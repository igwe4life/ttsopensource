"""
Piper — fast, CPU-friendly, high-quality neural TTS with curated per-language
voices (rhasspy/piper-voices). Preferred TTS engine wherever a voice exists
(see language-registry: PIPER_VOICES table).

Uses Piper's own Python package (`piper-tts`, the piper1-gpl project) to
load each voice's ONNX model ONCE and keep it resident in memory for every
subsequent synthesize() call. This replaces an earlier version that shelled
out to a standalone `piper` CLI binary as a **fresh subprocess per call**
(full process spawn + model reload every single time) — found via live
testing to saturate CPU with only 3 languages running continuously, since
the process-spawn-and-reload overhead dominated actual synthesis cost.
onnxruntime sessions are safe to call concurrently from multiple threads,
so the same loaded voice can serve overlapping requests.
"""
from __future__ import annotations

import asyncio
import io
import logging
import wave
from pathlib import Path
from typing import Optional

# torch first: importing it preloads the CUDA/cuDNN shared libs from its own
# pip wheels, which onnxruntime-gpu then finds (the documented workaround for
# ORT not locating cuDNN on its own). Harmless on a CPU-only install.
try:
    import torch  # noqa: F401
except ImportError:
    pass

from piper import PiperVoice

from app.config import settings
from app.engines.base import EngineLoadError, SynthesizedClip, TextToSpeechEngine, UnsupportedLanguageError
from app.registry.language_registry import registry


log = logging.getLogger("piper")


class PiperEngine(TextToSpeechEngine):
    name = "piper"

    def __init__(self):
        self._voices_dir = Path(settings.piper_voices_dir)
        self._voices: dict[str, PiperVoice] = {}  # voice_id -> resident, loaded voice
        self._providers: dict[str, list[str]] = {}  # voice_id -> ORT providers actually in use
        self._lock = asyncio.Lock()

    def supports(self, language_code: str) -> bool:
        entry = registry.get(language_code)
        return bool(entry and entry.tts_engine == "piper")

    def _voice_path(self, voice_id: str) -> Path:
        return self._voices_dir / f"{voice_id}.onnx"

    def is_loaded(self, language_code: str, voice_id: Optional[str] = None) -> bool:
        vid = voice_id or (registry.get(language_code).voice_id if registry.get(language_code) else None)
        return bool(vid and vid in self._voices)

    async def load(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        if not vid:
            raise UnsupportedLanguageError(f"No Piper voice configured for {language_code}")
        async with self._lock:
            if vid in self._voices:
                return
            path = self._voice_path(vid)
            if not path.exists():
                raise EngineLoadError(
                    f"Piper voice file missing: {path}. Download it from "
                    f"huggingface.co/rhasspy/piper-voices into {self._voices_dir}."
                )
            # PiperVoice.load() creates a real onnxruntime InferenceSession —
            # synchronous and CPU-bound (brief, but still worth keeping off
            # the event loop, same as the other engines' model loads).
            loop = asyncio.get_event_loop()
            try:
                voice, providers = await loop.run_in_executor(None, _load_voice, str(path))
            except Exception as e:  # noqa: BLE001 — e.g. missing/corrupt voice.onnx.json
                raise EngineLoadError(f"Piper failed to load voice {vid}: {e}") from e
            self._voices[vid] = voice
            self._providers[vid] = providers
            log.info("Piper voice %s loaded, providers=%s", vid, providers)

    async def unload(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        self._voices.pop(vid, None)
        self._providers.pop(vid, None)

    def info(self) -> dict:
        """Surfaced in /health so the GPU-vs-CPU outcome is verifiable remotely."""
        return {
            "use_cuda_requested": settings.piper_use_cuda,
            "voices": {vid: prov for vid, prov in self._providers.items()},
        }

    async def synthesize(
        self, text: str, language_code: str, voice_id: Optional[str] = None
    ) -> SynthesizedClip:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        if not vid:
            raise UnsupportedLanguageError(f"No Piper voice configured for {language_code}")
        if vid not in self._voices:
            await self.load(language_code, vid)

        voice = self._voices[vid]
        loop = asyncio.get_event_loop()
        wav_bytes = await loop.run_in_executor(None, _synthesize_wav_bytes, voice, text)
        return SynthesizedClip(audio=wav_bytes, sample_rate=voice.config.sample_rate)


def _load_voice(path: str):
    """Runs on a worker thread. Tries CUDA when requested and falls back to
    CPU if the CUDA execution provider can't be created, so a missing or
    mismatched onnxruntime-gpu degrades to the old behavior instead of
    losing the voice."""
    if settings.piper_use_cuda:
        try:
            voice = PiperVoice.load(path, use_cuda=True)
            return voice, _providers_of(voice)
        except Exception:  # noqa: BLE001
            log.warning("Piper CUDA load failed for %s, falling back to CPU", path, exc_info=True)
    voice = PiperVoice.load(path, use_cuda=False)
    return voice, _providers_of(voice)


def _providers_of(voice) -> list[str]:
    try:
        return list(voice.session.get_providers())
    except Exception:  # noqa: BLE001 -- attribute layout differs across piper versions
        return ["unknown"]


def _synthesize_wav_bytes(voice: "PiperVoice", text: str) -> bytes:
    """Runs on a worker thread — onnxruntime inference is synchronous/blocking."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize_wav(text, wav_file)
    return buf.getvalue()
