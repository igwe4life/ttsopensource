"""
faster-whisper (CTranslate2) — preferred STT engine. Same 99-language coverage
as openai-whisper but 4-8x faster on GPU with lower VRAM, which matters when
this one model has to serve every source language (see section 5).
"""
from __future__ import annotations

import asyncio
from typing import Optional

from app.config import settings
from app.engines.base import SpeechToTextEngine, TranscriptResult, TranscriptSegment, EngineLoadError
from app.registry.language_registry import registry


class FasterWhisperEngine(SpeechToTextEngine):
    name = "faster-whisper"

    def __init__(self, model_size: Optional[str] = None):
        self._model_size = model_size or settings.whisper_model_size
        self._model = None
        self._lock = asyncio.Lock()

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    async def load(self) -> None:
        if self._model is not None:
            return
        async with self._lock:
            if self._model is not None:  # re-check after acquiring the lock
                return
            try:
                from faster_whisper import WhisperModel  # lazy import: heavy, GPU-only dep
            except ImportError as e:
                raise EngineLoadError(
                    "faster-whisper is not installed. `pip install faster-whisper`."
                ) from e

            def _load():
                return WhisperModel(
                    self._model_size,
                    device=settings.device,
                    compute_type=settings.compute_type,
                    download_root=settings.whisper_model_dir or None,
                )

            # Model load is blocking (disk + CUDA init) — run off the event loop.
            self._model = await asyncio.get_event_loop().run_in_executor(None, _load)

    async def unload(self) -> None:
        async with self._lock:
            self._model = None  # let GC/CUDA reclaim; ctranslate2 has no explicit unload

    def supports(self, language_code: str) -> bool:
        entry = registry.get(language_code)
        return bool(entry and entry.whisper_code)

    async def transcribe(
        self, audio_path: str, language_hint: Optional[str] = None
    ) -> TranscriptResult:
        if self._model is None:
            await self.load()

        entry = registry.get(language_hint) if language_hint else None
        whisper_lang = entry.whisper_code if entry else None

        def _run():
            segments_iter, info = self._model.transcribe(
                audio_path,
                language=whisper_lang,  # None => auto-detect
                vad_filter=True,  # built-in Silero VAD — skips silence, see docs/ARCHITECTURE.md
                vad_parameters={"min_silence_duration_ms": 300},
                beam_size=5,
            )
            segs = [
                TranscriptSegment(id=i, start=s.start, end=s.end, text=s.text.strip())
                for i, s in enumerate(segments_iter)
                if s.text and s.text.strip()
            ]
            return segs, info.language

        segments, detected_lang = await asyncio.get_event_loop().run_in_executor(None, _run)
        return TranscriptResult(segments=segments, detected_language=detected_lang)
