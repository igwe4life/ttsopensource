"""
The section-5 fan-out, implemented: transcribe ONE audio chunk once, then
translate + synthesize it for however many target languages were requested,
concurrently, all reusing the same transcript. This is what `/process` and
the orchestrator's segment pipeline call — never call transcribe per target
language.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

from app.engines.base import SynthesizedClip, TranscriptResult, UnsupportedLanguageError
from app.routing import model_router

log = logging.getLogger("pipeline")


@dataclass
class LanguageResult:
    language_code: str
    ok: bool
    text: Optional[str] = None
    audio: Optional[bytes] = None
    sample_rate: Optional[int] = None
    translation_engine: Optional[str] = None
    tts_engine: Optional[str] = None
    error: Optional[str] = None


@dataclass
class ProcessResult:
    transcript: TranscriptResult
    source_lang: str
    languages: dict[str, LanguageResult] = field(default_factory=dict)


async def process_segment(
    audio_path: str,
    target_langs: list[str],
    source_lang_hint: Optional[str] = None,
) -> ProcessResult:
    """One STT call, fanned out to N (translate -> TTS) calls in parallel.

    Mirrors the old ttsengine's segmentPipeline.js deadline/fallback shape,
    but per-target-language instead of per-segment: a failure translating or
    synthesizing ONE language does not block or fail the others.
    """
    transcript = await model_router.transcribe(audio_path, language_hint=source_lang_hint)
    detected = transcript.detected_language or source_lang_hint or "en"

    if not transcript.segments:
        return ProcessResult(
            transcript=transcript,
            source_lang=detected,
            languages={
                lang: LanguageResult(language_code=lang, ok=False, error="no speech detected")
                for lang in target_langs
            },
        )

    async def _one(lang: str) -> LanguageResult:
        try:
            translated, t_engine = await model_router.translate(
                transcript.segments, source_lang=detected, target_lang=lang
            )
            full_text = " ".join(seg.text for seg in translated)
            clip: SynthesizedClip
            clip, s_engine = await model_router.synthesize(full_text, language_code=lang)
            return LanguageResult(
                language_code=lang,
                ok=True,
                text=full_text,
                audio=clip.audio,
                sample_rate=clip.sample_rate,
                translation_engine=t_engine,
                tts_engine=s_engine,
            )
        except UnsupportedLanguageError as e:
            return LanguageResult(language_code=lang, ok=False, error=str(e))
        except Exception as e:  # noqa: BLE001 — isolate this language's failure from the rest
            log.exception("processing failed for %s", lang)
            return LanguageResult(language_code=lang, ok=False, error=f"{type(e).__name__}: {e}")

    results = await asyncio.gather(*(_one(lang) for lang in target_langs))
    return ProcessResult(
        transcript=transcript,
        source_lang=detected,
        languages={r.language_code: r for r in results},
    )
