"""
Startup preload for a pod that serves a shard of the language set.

For every code in PRELOAD_LANGUAGES: download its TTS voice (Piper from
rhasspy/piper-voices, MMS from HuggingFace via transformers), load it, and run
one tiny warm-up synthesis so CUDA kernels / cuDNN plans are built before the
first live chunk. Progress is exposed through /health ("preload") so a deploy
script can wait for ready=true. A language that fails to load is recorded, not
fatal -- the others keep working.
"""
from __future__ import annotations

import asyncio
import logging
import time

from app.config import settings
from app.engines.tts.piper_voices import ensure_voice
from app.registry.language_registry import registry
from app.routing import model_router

log = logging.getLogger("preload")

_state: dict = {"total": 0, "done": 0, "ready": True, "failed": {}, "started": None, "seconds": None}


def status() -> dict:
    return dict(_state, failed=dict(_state["failed"]))


async def _one(code: str, sem: asyncio.Semaphore) -> None:
    async with sem:
        entry = registry.get(code)
        try:
            if entry is None or not entry.tts_supported:
                raise RuntimeError("no TTS route in registry")
            loop = asyncio.get_event_loop()
            if entry.tts_engine == "piper":
                await loop.run_in_executor(None, ensure_voice, entry.voice_id)
                await model_router.piper_engine.load(code)
            elif entry.tts_engine == "mms":
                await model_router.mms_engine.load(code)
            else:
                raise RuntimeError(f"preload not supported for engine {entry.tts_engine}")
            try:  # warm-up; a failure here (e.g. script mismatch) is harmless
                await model_router.synthesize("1 2 3", language_code=code)
            except Exception:  # noqa: BLE001
                pass
        except Exception as e:  # noqa: BLE001
            log.warning("preload failed for %s: %s", code, e)
            _state["failed"][code] = f"{type(e).__name__}: {e}"[:200]
        finally:
            _state["done"] += 1


async def run(languages: list[str]) -> None:
    _state.update(total=len(languages), done=0, ready=False, failed={}, started=time.time(), seconds=None)
    sem = asyncio.Semaphore(max(1, settings.preload_concurrency))
    await asyncio.gather(*(_one(c, sem) for c in languages))
    _state["ready"] = True
    _state["seconds"] = round(time.time() - _state["started"], 1)
    log.info("preload finished: %d/%d ok in %ss, failed=%s",
             _state["total"] - len(_state["failed"]), _state["total"], _state["seconds"], list(_state["failed"]))
