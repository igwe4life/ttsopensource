"""
Model router: the single place that decides WHICH engine handles a given
language, with fallback chains, so `app/pipeline` and `app/main` never
reference a concrete engine class directly (section 2's "replace without
rewriting the application").

Routing rules (see docs/ARCHITECTURE.md for the full rationale):
  STT:          one shared engine (faster-whisper or whisper) for every
                language it covers. No per-language choice to make.
  Translation:  NLLB first (one shared model, all 200 languages) -> OPUS-MT/
                Marian per-pair fallback if NLLB has no code or the call fails.
  TTS:          registry-assigned engine first (piper > xtts > mms, decided at
                registry-build time) -> the next engine in that same priority
                order that also claims support, as a last-resort fallback.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.config import settings
from app.engines.base import (
    SynthesizedClip,
    TranscriptResult,
    TranslatedSegment,
    TranscriptSegment,
    UnsupportedLanguageError,
)
from app.engines.stt.faster_whisper_engine import FasterWhisperEngine
from app.engines.stt.whisper_engine import WhisperEngine
from app.engines.translation.nllb_engine import NLLBEngine
from app.engines.translation.opus_mt_engine import OPUSEngine
from app.engines.tts.mms_tts_engine import MMSTTSEngine
from app.engines.tts.piper_engine import PiperEngine
from app.engines.tts.xtts_engine import XTTSEngine
from app.registry.language_registry import registry
from app.routing.model_pool import translation_pool, tts_pool

log = logging.getLogger("router")

# ── Singletons — constructed once, reused for the life of the process ──────
stt_engine = FasterWhisperEngine() if settings.stt_engine == "faster-whisper" else WhisperEngine()
nllb_engine = NLLBEngine()
opus_engine = OPUSEngine()
piper_engine = PiperEngine()
xtts_engine = XTTSEngine()
mms_engine = MMSTTSEngine()

translation_pool.set_limit(opus_engine.name, settings.max_loaded_translation_models)
tts_pool.set_limit(xtts_engine.name, 1)  # one XTTS model instance; cheap to keep resident once loaded
tts_pool.set_limit(mms_engine.name, settings.max_loaded_tts_models)

_TTS_ENGINES = {"piper": piper_engine, "xtts": xtts_engine, "mms": mms_engine}
_TTS_PRIORITY = ["piper", "xtts", "mms"]  # quality-descending fallback order


async def startup() -> None:
    """Called once at app boot (see main.py). Loads the always-on shared
    models; per-language/per-pair models load lazily on first request."""
    await stt_engine.load()
    await nllb_engine.load()
    log.info("Shared STT (%s) and translation (%s) models loaded.", stt_engine.name, nllb_engine.name)


async def transcribe(audio_path: str, language_hint: Optional[str] = None) -> TranscriptResult:
    return await stt_engine.transcribe(audio_path, language_hint=language_hint)


async def translate(
    segments: list[TranscriptSegment], source_lang: str, target_lang: str
) -> tuple[list[TranslatedSegment], str]:
    """Returns (translated_segments, engine_name_used)."""
    entry = registry.get(target_lang)
    if entry is None or not entry.translation_supported:
        raise UnsupportedLanguageError(f"{target_lang} has no translation route configured")

    if nllb_engine.supports_pair(source_lang, target_lang):
        try:
            return await nllb_engine.translate_batch(segments, source_lang, target_lang), nllb_engine.name
        except Exception:
            log.warning("NLLB failed for %s->%s, trying fallback", source_lang, target_lang, exc_info=True)

    if entry.translation_fallback == "opus-mt":
        try:
            result = await opus_engine.translate_batch(segments, source_lang, target_lang)
            await translation_pool.touch(
                opus_engine.name,
                f"{source_lang}-{target_lang}",
                lambda: opus_engine.unload(target_lang=target_lang),
            )
            return result, opus_engine.name
        except Exception:
            log.warning("OPUS-MT fallback also failed for %s->%s", source_lang, target_lang, exc_info=True)

    raise UnsupportedLanguageError(f"No working translation engine for {source_lang}->{target_lang}")


async def synthesize(
    text: str, language_code: str, voice_id: Optional[str] = None
) -> tuple[SynthesizedClip, str]:
    """Returns (clip, engine_name_used). Tries the registry-assigned engine
    first, then walks the rest of the priority order as a last resort."""
    entry = registry.get(language_code)
    if entry is None or not entry.tts_supported:
        raise UnsupportedLanguageError(f"{language_code} has no TTS route configured")

    tried = []
    preferred = [entry.tts_engine] + [e for e in _TTS_PRIORITY if e != entry.tts_engine]
    for engine_name in preferred:
        engine = _TTS_ENGINES.get(engine_name)
        if not engine or not engine.supports(language_code):
            continue
        tried.append(engine_name)
        try:
            clip = await engine.synthesize(text, language_code, voice_id=voice_id)
            if engine_name in ("xtts", "mms"):
                pool = tts_pool
                key = voice_id or (entry.voice_id if engine_name == "mms" else "xtts")
                await pool.touch(engine.name, key, lambda: engine.unload(language_code, voice_id))
            return clip, engine_name
        except Exception:
            log.warning("TTS engine %s failed for %s, trying next", engine_name, language_code, exc_info=True)
            continue

    raise UnsupportedLanguageError(
        f"All TTS engines failed for {language_code} (tried: {', '.join(tried) or 'none configured'})"
    )


def status() -> dict:
    return {
        "stt": {"engine": stt_engine.name, "loaded": stt_engine.is_loaded},
        "translation": {
            "primary": {"engine": nllb_engine.name, "loaded": nllb_engine.is_loaded()},
            "fallback_pool": translation_pool.stats(),
        },
        "tts_pool": tts_pool.stats(),
    }
