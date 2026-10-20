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
import time
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
    translate_ms: Optional[int] = None
    tts_ms: Optional[int] = None


@dataclass
class ProcessResult:
    transcript: TranscriptResult
    source_lang: str
    english_text: Optional[str] = None
    # Stage timings (ms) for the whole segment: stt_ms, translate_en_ms, fanout_ms, total_ms.
    # Returned to the orchestrator, since pod logs are not reachable on RunPod.
    timings: dict[str, int] = field(default_factory=dict)
    languages: dict[str, LanguageResult] = field(default_factory=dict)


async def process_segment(
    audio_path: str,
    target_langs: list[str],
    source_lang_hint: Optional[str] = None,
) -> ProcessResult:
    """One STT call, pivoted through English once, then fanned out to N
    (translate -> TTS) calls in parallel.

    The English pivot (STT -> English -> N targets, rather than translating
    detected-language -> each target directly) matches the product's stated
    pipeline shape and scales better as target languages are added later:
    one new en->X model per language, not a full source x target matrix.

    Mirrors the old ttsengine's segmentPipeline.js deadline/fallback shape,
    but per-target-language instead of per-segment: a failure translating or
    synthesizing ONE language does not block or fail the others.
    """
    t_start = time.perf_counter()
    transcript = await model_router.transcribe(audio_path, language_hint=source_lang_hint)
    stt_ms = int((time.perf_counter() - t_start) * 1000)
    detected = transcript.detected_language or source_lang_hint or "en"

    if not transcript.segments:
        return ProcessResult(
            transcript=transcript,
            source_lang=detected,
            timings={"stt_ms": stt_ms, "translate_en_ms": 0, "fanout_ms": 0, "total_ms": stt_ms},
            languages={
                lang: LanguageResult(language_code=lang, ok=False, error="no speech detected")
                for lang in target_langs
            },
        )

    t_en = time.perf_counter()
    if detected == "en":
        english_segments = transcript.segments
    else:
        english_segments, _ = await model_router.translate(
            transcript.segments, source_lang=detected, target_lang="en"
        )
    translate_en_ms = int((time.perf_counter() - t_en) * 1000)
    english_text = " ".join(seg.text for seg in english_segments)

    # ONE batched translation pass for every target language (a single GPU
    # generate() call), instead of N concurrent per-language calls fighting
    # over the same GPU. Per-language failures come back in `failures`.
    t_fan = time.perf_counter()
    translations, failures = await model_router.translate_many(
        english_segments, source_lang="en", target_langs=list(target_langs)
    )
    translate_ms = int((time.perf_counter() - t_fan) * 1000)

    async def _one(lang: str) -> LanguageResult:
        if lang in failures:
            err = failures[lang]
            if not isinstance(err, UnsupportedLanguageError):
                log.error("translation failed for %s: %s", lang, err)
            return LanguageResult(language_code=lang, ok=False, error=f"{type(err).__name__}: {err}")
        try:
            translated, t_engine = translations[lang]
            full_text = " ".join(seg.text for seg in translated)
            clip: SynthesizedClip
            t1 = time.perf_counter()
            try:
                clip, s_engine = await model_router.synthesize(full_text, language_code=lang)
            except UnsupportedLanguageError as first_err:
                # The batched translation can hand a voice text it cannot say (seen live:
                # Piper produced zero audio chunks for some language/chunk combinations
                # while the same voices work on ordinary text). Retry ONCE with the
                # single-language translation path, and say what the text was if it
                # still fails — pod logs are unreachable on RunPod.
                retry_text = None
                try:
                    again, t_engine2 = await model_router.translate(english_segments, source_lang="en", target_lang=lang)
                    retry_text = " ".join(seg.text for seg in again).strip()
                except Exception:  # noqa: BLE001
                    pass
                if retry_text and retry_text != full_text.strip():
                    clip, s_engine = await model_router.synthesize(retry_text, language_code=lang)
                    full_text, t_engine = retry_text, f"{t_engine2}+retry"
                    log.warning("TTS retry with single-language translation fixed %s", lang)
                else:
                    raise UnsupportedLanguageError(f"{first_err} [text={full_text[:80]!r}]") from first_err
            tts_ms = int((time.perf_counter() - t1) * 1000)
            return LanguageResult(
                language_code=lang,
                ok=True,
                text=full_text,
                audio=clip.audio,
                sample_rate=clip.sample_rate,
                translation_engine=t_engine,
                tts_engine=s_engine,
                translate_ms=translate_ms,
                tts_ms=tts_ms,
            )
        except UnsupportedLanguageError as e:
            return LanguageResult(language_code=lang, ok=False, error=str(e))
        except Exception as e:  # noqa: BLE001 — isolate this language's failure from the rest
            log.exception("processing failed for %s", lang)
            return LanguageResult(language_code=lang, ok=False, error=f"{type(e).__name__}: {e}")

    results = await asyncio.gather(*(_one(lang) for lang in target_langs))
    fanout_ms = int((time.perf_counter() - t_fan) * 1000)
    return ProcessResult(
        transcript=transcript,
        source_lang=detected,
        english_text=english_text,
        timings={
            "stt_ms": stt_ms,
            "translate_en_ms": translate_en_ms,
            "translate_batch_ms": translate_ms,
            "fanout_ms": fanout_ms,
            "total_ms": int((time.perf_counter() - t_start) * 1000),
        },
        languages={r.language_code: r for r in results},
    )
