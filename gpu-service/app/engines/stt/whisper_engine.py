"""
Reference openai-whisper engine. Kept mainly as a documented fallback/parity
check against faster-whisper — prefer FasterWhisperEngine in production (see
its docstring for why). Same public interface, so the router can swap between
them with a single config value (STT_ENGINE=whisper|faster-whisper).
"""
from __future__ import annotations

import asyncio
from typing import Optional

from app.config import settings
from app.engines.base import SpeechToTextEngine, TranscriptResult, TranscriptSegment, EngineLoadError
from app.registry.language_registry import registry


class WhisperEngine(SpeechToTextEngine):
    name = "whisper"

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
            if self._model is not None:
                return
            try:
                import whisper  # lazy import: heavy, GPU-only dep
            except ImportError as e:
                raise EngineLoadError("openai-whisper is not installed. `pip install openai-whisper`.") from e

            def _load():
                return whisper.load_model(self._model_size, device=settings.device)

            self._model = await asyncio.get_event_loop().run_in_executor(None, _load)

    async def unload(self) -> None:
        async with self._lock:
            self._model = None

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
            result = self._model.transcribe(audio_path, language=whisper_lang, verbose=False)
            segs = [
                TranscriptSegment(
                    id=i, start=s["start"], end=s["end"], text=s["text"].strip()
                )
                for i, s in enumerate(result.get("segments", []))
                if s.get("text", "").strip()
            ]
            return segs, result.get("language")

        segments, detected_lang = await asyncio.get_event_loop().run_in_executor(None, _run)
        return TranscriptResult(segments=segments, detected_language=detected_lang)
