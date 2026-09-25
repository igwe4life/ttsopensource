"""
Coqui XTTS v2 — higher-quality, voice-cloning-capable TTS, GPU-resident.
17-language coverage (see language-registry XTTS_LANGS). Heavier per-call cost
than Piper, so the router only reaches for this when Piper has no voice for
the language, or a caller explicitly asks for voice cloning via `voice_id`
pointing at a reference clip.
"""
from __future__ import annotations

import asyncio
import io
from typing import Optional

from app.config import settings
from app.engines.base import EngineLoadError, SynthesizedClip, TextToSpeechEngine, UnsupportedLanguageError
from app.registry.language_registry import registry

XTTS_SAMPLE_RATE = 24000


class XTTSEngine(TextToSpeechEngine):
    name = "xtts"

    def __init__(self, model_id: Optional[str] = None):
        self._model_id = model_id or settings.xtts_model_id
        self._tts = None  # coqui TTS.api.TTS instance — GPU-resident once loaded
        self._lock = asyncio.Lock()

    def supports(self, language_code: str) -> bool:
        entry = registry.get(language_code)
        return bool(entry and entry.tts_engine == "xtts")

    def is_loaded(self, language_code: str, voice_id: Optional[str] = None) -> bool:
        return self._tts is not None

    async def load(self, language_code: str, voice_id: Optional[str] = None) -> None:
        if self._tts is not None:
            return
        async with self._lock:
            if self._tts is not None:
                return
            try:
                from TTS.api import TTS  # coqui-tts package; lazy import (heavy, GPU)
            except ImportError as e:
                raise EngineLoadError("coqui-tts is not installed. `pip install coqui-tts`.") from e

            def _load():
                return TTS(self._model_id, gpu=settings.device.startswith("cuda"))

            self._tts = await asyncio.get_event_loop().run_in_executor(None, _load)

    async def unload(self, language_code: str, voice_id: Optional[str] = None) -> None:
        async with self._lock:
            self._tts = None

    async def synthesize(
        self, text: str, language_code: str, voice_id: Optional[str] = None
    ) -> SynthesizedClip:
        entry = registry.get(language_code)
        if not entry or entry.tts_engine != "xtts":
            raise UnsupportedLanguageError(f"XTTS has no configured voice for {language_code}")
        if self._tts is None:
            await self.load(language_code)

        # `voice_id` may point at a reference WAV for voice cloning; falls back
        # to the model's built-in default speaker embedding for the language.
        speaker_wav = voice_id if (voice_id and voice_id.endswith(".wav")) else None

        def _run():
            wav_array = self._tts.tts(
                text=text,
                language=language_code,
                speaker_wav=speaker_wav,
            )
            return _floats_to_wav(wav_array, XTTS_SAMPLE_RATE)

        wav_bytes = await asyncio.get_event_loop().run_in_executor(None, _run)
        return SynthesizedClip(audio=wav_bytes, sample_rate=XTTS_SAMPLE_RATE)


def _floats_to_wav(samples, sample_rate: int) -> bytes:
    import wave

    import numpy as np

    arr = np.asarray(samples, dtype=np.float32)
    pcm16 = (np.clip(arr, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()
