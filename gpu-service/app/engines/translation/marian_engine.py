"""
Generic MarianMT engine: loads ONE model per (source, target) language pair
via transformers' MarianMTModel. This is the underlying architecture behind
Helsinki-NLP's opus-mt-* checkpoints (see opus_mt_engine.py, a thin naming
wrapper over this class).

Deliberately kept as a fallback, not the default: unlike NLLB's one-model-for-
200-languages, Marian needs a SEPARATE model per pair, which does not scale to
hundreds of languages sitting in GPU memory at once. The model pool
(routing/model_pool.py) treats each pair as its own cache entry and evicts
LRU-style so this stays usable for a handful of high-traffic overflow pairs
without blowing the VRAM budget.
"""
from __future__ import annotations

import asyncio
from typing import Optional

from app.config import settings
from app.engines.base import (
    EngineLoadError,
    TranscriptSegment,
    TranslatedSegment,
    TranslationEngine,
    UnsupportedLanguageError,
)


class MarianEngine(TranslationEngine):
    name = "marian"

    def __init__(self, model_id_template: Optional[str] = None):
        self._template = model_id_template or settings.opus_mt_model_template
        self._models: dict[str, tuple] = {}  # pair_key -> (model, tokenizer)
        self._lock = asyncio.Lock()

    @staticmethod
    def _pair_key(source_lang: str, target_lang: str) -> str:
        return f"{source_lang}-{target_lang}"

    def is_loaded(self, target_lang: Optional[str] = None) -> bool:
        if target_lang is None:
            return len(self._models) > 0
        return any(k.endswith(f"-{target_lang}") for k in self._models)

    def _model_id_for(self, source_lang: str, target_lang: str) -> str:
        return self._template.format(src=source_lang, tgt=target_lang)

    async def load(self, target_lang: Optional[str] = None, source_lang: str = "en") -> None:
        if target_lang is None:
            return  # nothing to preload without knowing the pair
        key = self._pair_key(source_lang, target_lang)
        if key in self._models:
            return
        async with self._lock:
            if key in self._models:
                return
            try:
                from transformers import MarianMTModel, MarianTokenizer
            except ImportError as e:
                raise EngineLoadError("transformers is not installed. `pip install transformers`.") from e

            model_id = self._model_id_for(source_lang, target_lang)

            def _load():
                tokenizer = MarianTokenizer.from_pretrained(model_id)
                model = MarianMTModel.from_pretrained(model_id)
                if settings.device.startswith("cuda"):
                    model = model.to(settings.device)
                model.eval()
                return model, tokenizer

            try:
                self._models[key] = await asyncio.get_event_loop().run_in_executor(None, _load)
            except OSError as e:
                raise UnsupportedLanguageError(
                    f"No Marian/OPUS-MT checkpoint found for {model_id}"
                ) from e

    async def unload(self, target_lang: Optional[str] = None) -> None:
        async with self._lock:
            if target_lang is None:
                self._models.clear()
                return
            for key in [k for k in self._models if k.endswith(f"-{target_lang}")]:
                del self._models[key]

    def supports_pair(self, source_lang: str, target_lang: str) -> bool:
        # Marian/OPUS-MT checkpoints are per-pair and not centrally enumerable
        # offline; we optimistically say yes and let load() surface a 404 as
        # UnsupportedLanguageError, which the router treats as "try the next
        # engine in the fallback chain."
        return True

    async def translate_batch(
        self, segments: list[TranscriptSegment], source_lang: str, target_lang: str
    ) -> list[TranslatedSegment]:
        key = self._pair_key(source_lang, target_lang)
        if key not in self._models:
            await self.load(target_lang=target_lang, source_lang=source_lang)
        model, tokenizer = self._models[key]

        def _run():
            out: list[TranslatedSegment] = []
            texts = [s.text for s in segments]
            inputs = tokenizer(texts, return_tensors="pt", padding=True, truncation=True)
            if settings.device.startswith("cuda"):
                inputs = {k: v.to(settings.device) for k, v in inputs.items()}
            generated = model.generate(**inputs, max_length=256)
            decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
            for seg, text in zip(segments, decoded):
                out.append(TranslatedSegment(id=seg.id, start=seg.start, end=seg.end, text=text))
            return out

        return await asyncio.get_event_loop().run_in_executor(None, _run)
