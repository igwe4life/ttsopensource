"""
Piper — fast, CPU-friendly, high-quality neural TTS with curated per-language
voices (rhasspy/piper-voices). Preferred TTS engine wherever a voice exists
(see language-registry: PIPER_VOICES table). Runs the `piper` binary as a
subprocess per call rather than binding its C++ runtime directly, trading a
small amount of latency for zero Python/native-binding maintenance burden.
"""
from __future__ import annotations

import asyncio
import io
import wave
from pathlib import Path
from typing import Optional

from app.config import settings
from app.engines.base import EngineLoadError, SynthesizedClip, TextToSpeechEngine, UnsupportedLanguageError
from app.registry.language_registry import registry


class PiperEngine(TextToSpeechEngine):
    name = "piper"

    def __init__(self):
        self._voices_dir = Path(settings.piper_voices_dir)
        self._loaded_voices: set[str] = set()  # voice files verified present on disk
        self._lock = asyncio.Lock()

    def supports(self, language_code: str) -> bool:
        entry = registry.get(language_code)
        return bool(entry and entry.tts_engine == "piper")

    def _voice_path(self, voice_id: str) -> Path:
        return self._voices_dir / f"{voice_id}.onnx"

    def is_loaded(self, language_code: str, voice_id: Optional[str] = None) -> bool:
        vid = voice_id or (registry.get(language_code).voice_id if registry.get(language_code) else None)
        return bool(vid and vid in self._loaded_voices)

    async def load(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        if not vid:
            raise UnsupportedLanguageError(f"No Piper voice configured for {language_code}")
        path = self._voice_path(vid)
        async with self._lock:
            if vid in self._loaded_voices:
                return
            if not path.exists():
                raise EngineLoadError(
                    f"Piper voice file missing: {path}. Download it from "
                    f"huggingface.co/rhasspy/piper-voices into {self._voices_dir}."
                )
            self._loaded_voices.add(vid)  # "loaded" == verified present; piper loads per-process

    async def unload(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        self._loaded_voices.discard(vid)

    async def synthesize(
        self, text: str, language_code: str, voice_id: Optional[str] = None
    ) -> SynthesizedClip:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        if not vid:
            raise UnsupportedLanguageError(f"No Piper voice configured for {language_code}")
        if vid not in self._loaded_voices:
            await self.load(language_code, vid)

        model_path = self._voice_path(vid)
        proc = await asyncio.create_subprocess_exec(
            settings.piper_binary,
            "--model", str(model_path),
            "--output-raw",  # raw 16-bit PCM mono on stdout, sample rate from voice config
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(text.encode("utf-8"))
        if proc.returncode != 0:
            raise EngineLoadError(f"piper exited {proc.returncode}: {stderr.decode(errors='replace')}")

        sample_rate = 22050  # Piper's standard voice sample rate; override via voice config if needed
        return SynthesizedClip(audio=_pcm_to_wav(stdout, sample_rate), sample_rate=sample_rate)


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm_bytes)
    return buf.getvalue()
