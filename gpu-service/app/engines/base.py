"""
Engine abstraction layer (section 2 of the brief).

Three abstract base classes: SpeechToTextEngine, TranslationEngine,
TextToSpeechEngine. Concrete engines (WhisperEngine, FasterWhisperEngine,
NLLBEngine, MarianEngine/OPUSEngine, PiperEngine, XTTSEngine, MMSTTSEngine)
implement these. Nothing outside `app/engines/` should import a concrete
engine directly — always go through `app/routing/model_router.py` so engines
stay swappable without touching call sites.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TranscriptSegment:
    id: int
    start: float  # seconds, relative to the audio chunk passed in
    end: float
    text: str


@dataclass
class TranscriptResult:
    segments: list[TranscriptSegment]
    detected_language: Optional[str] = None


@dataclass
class TranslatedSegment:
    id: int
    start: float
    end: float
    text: str


@dataclass
class SynthesizedClip:
    audio: bytes  # WAV PCM bytes
    sample_rate: int
    format: str = "wav"


class EngineLoadError(RuntimeError):
    """Raised when an engine cannot load its model (missing checkpoint, OOM, etc.)."""


class UnsupportedLanguageError(RuntimeError):
    """Raised when an engine is asked to handle a language it doesn't cover.
    The router catches this and tries the next engine in the fallback chain."""


class SpeechToTextEngine(ABC):
    """One instance is expected to be shared across MANY source languages —
    see section 5 ("do not run Whisper separately for every target language").
    """

    name: str = "base-stt"

    @abstractmethod
    async def load(self) -> None:
        """Load the model into GPU/CPU memory. Idempotent — safe to call when
        already loaded."""

    @abstractmethod
    async def unload(self) -> None:
        """Free model memory. Called by the model pool under memory pressure."""

    @property
    @abstractmethod
    def is_loaded(self) -> bool: ...

    @abstractmethod
    def supports(self, language_code: str) -> bool:
        """Whisper codes, not our internal registry codes necessarily — engines
        translate via the language registry before calling this."""

    @abstractmethod
    async def transcribe(
        self, audio_path: str, language_hint: Optional[str] = None
    ) -> TranscriptResult:
        """`audio_path` is a 16kHz mono WAV on local disk (matches the old
        ttsengine's extractAudio.js convention — orchestrator writes it, this
        never touches the network)."""


class TranslationEngine(ABC):
    name: str = "base-translation"

    @abstractmethod
    async def load(self, target_lang: Optional[str] = None) -> None:
        """Some translation engines (NLLB) load once for ALL languages;
        others (Marian/OPUS-MT) load one model PER language pair — `target_lang`
        lets per-pair engines lazy-load just what's needed."""

    @abstractmethod
    async def unload(self, target_lang: Optional[str] = None) -> None: ...

    @abstractmethod
    def is_loaded(self, target_lang: Optional[str] = None) -> bool: ...

    @abstractmethod
    def supports_pair(self, source_lang: str, target_lang: str) -> bool: ...

    @abstractmethod
    async def translate_batch(
        self, segments: list[TranscriptSegment], source_lang: str, target_lang: str
    ) -> list[TranslatedSegment]:
        """Translate all segments in ONE call where the underlying model
        supports batching (NLLB) — keeps GPU utilization high vs. one call per
        line."""


class TextToSpeechEngine(ABC):
    name: str = "base-tts"

    @abstractmethod
    async def load(self, language_code: str, voice_id: Optional[str] = None) -> None: ...

    @abstractmethod
    async def unload(self, language_code: str, voice_id: Optional[str] = None) -> None: ...

    @abstractmethod
    def is_loaded(self, language_code: str, voice_id: Optional[str] = None) -> bool: ...

    @abstractmethod
    def supports(self, language_code: str) -> bool: ...

    @abstractmethod
    async def synthesize(
        self, text: str, language_code: str, voice_id: Optional[str] = None
    ) -> SynthesizedClip: ...
