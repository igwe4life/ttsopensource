"""
Generic model pool: tracks last-used time per (engine, key) and evicts the
least-recently-used entries when an engine's `max_loaded` limit is exceeded,
or an entry has been idle past `model_idle_unload_seconds`.

This is the "load when required, cache where practical, reuse across jobs,
unload when necessary" mechanism from section 7. Engines don't self-manage
eviction — they just expose load(key)/unload(key)/is_loaded(key); this pool
decides WHEN to call unload. That keeps the policy in one place instead of
duplicated across Piper/XTTS/MMS/Marian.

Per-language-pair Marian models and per-language MMS-TTS checkpoints are the
main beneficiaries: with 100+ languages there is no way all of them stay
GPU-resident at once, so this is load-on-demand + LRU eviction, not
load-everything-at-startup.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from app.config import settings


@dataclass
class _Entry:
    last_used: float
    unload_fn: Callable[[], Awaitable[None]]


class ModelPool:
    def __init__(self, max_loaded_default: int = 6, idle_seconds: Optional[int] = None):
        self._max_loaded_default = max_loaded_default
        self._idle_seconds = idle_seconds if idle_seconds is not None else settings.model_idle_unload_seconds
        self._entries: dict[str, dict[str, _Entry]] = {}  # engine_name -> key -> entry
        self._max_loaded: dict[str, int] = {}
        self._lock = asyncio.Lock()

    def set_limit(self, engine_name: str, max_loaded: int) -> None:
        self._max_loaded[engine_name] = max_loaded

    async def touch(
        self, engine_name: str, key: str, unload_fn: Callable[[], Awaitable[None]]
    ) -> None:
        """Call after a successful load OR use, so eviction picks true LRU."""
        async with self._lock:
            bucket = self._entries.setdefault(engine_name, {})
            bucket[key] = _Entry(last_used=time.monotonic(), unload_fn=unload_fn)
            await self._enforce_limit_locked(engine_name)

    async def release(self, engine_name: str, key: str) -> None:
        async with self._lock:
            self._entries.get(engine_name, {}).pop(key, None)

    async def _enforce_limit_locked(self, engine_name: str) -> None:
        limit = self._max_loaded.get(engine_name, self._max_loaded_default)
        bucket = self._entries.get(engine_name, {})
        while len(bucket) > limit:
            lru_key = min(bucket, key=lambda k: bucket[k].last_used)
            entry = bucket.pop(lru_key)
            await entry.unload_fn()

    async def evict_idle(self) -> None:
        """Call periodically (see main.py's background task) to free memory
        for entries nobody has touched in `model_idle_unload_seconds`."""
        now = time.monotonic()
        async with self._lock:
            for engine_name, bucket in list(self._entries.items()):
                stale = [k for k, e in bucket.items() if now - e.last_used > self._idle_seconds]
                for k in stale:
                    entry = bucket.pop(k)
                    await entry.unload_fn()

    def stats(self) -> dict:
        return {
            engine: {
                "loaded_count": len(bucket),
                "keys": list(bucket.keys()),
                "limit": self._max_loaded.get(engine, self._max_loaded_default),
            }
            for engine, bucket in self._entries.items()
        }


# Two pools: translation (Marian/OPUS-MT pairs) and TTS (XTTS voices / MMS
# per-language checkpoints). NLLB and faster-whisper are single shared models
# and are never subject to eviction — they're loaded once at startup and kept.
translation_pool = ModelPool(max_loaded_default=settings.max_loaded_translation_models)
tts_pool = ModelPool(max_loaded_default=settings.max_loaded_tts_models)
