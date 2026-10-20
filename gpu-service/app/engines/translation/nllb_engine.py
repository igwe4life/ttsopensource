"""
NLLB-200 — the primary translation engine. ONE model handles all 200
FLORES-200 languages, which is what makes the fan-out in section 5 possible:
transcribe once, then run N translate calls against this SAME loaded model
instead of loading N separate models.
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
from app.registry.language_registry import registry


class NLLBEngine(TranslationEngine):
    name = "nllb"

    def __init__(self, model_id: Optional[str] = None):
        self._model_id = model_id or settings.nllb_model_id
        self._model = None
        self._tokenizer = None
        self._lock = asyncio.Lock()

    def is_loaded(self, target_lang: Optional[str] = None) -> bool:
        return self._model is not None  # single shared model — target_lang is irrelevant

    async def load(self, target_lang: Optional[str] = None) -> None:
        if self._model is not None:
            return
        async with self._lock:
            if self._model is not None:
                return
            try:
                from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
            except ImportError as e:
                raise EngineLoadError("transformers is not installed. `pip install transformers`.") from e

            def _load():
                tokenizer = AutoTokenizer.from_pretrained(self._model_id)
                model = AutoModelForSeq2SeqLM.from_pretrained(self._model_id)
                if settings.device.startswith("cuda"):
                    model = model.to(settings.device)
                model.eval()
                return model, tokenizer

            self._model, self._tokenizer = await asyncio.get_event_loop().run_in_executor(None, _load)

    async def unload(self, target_lang: Optional[str] = None) -> None:
        async with self._lock:
            self._model = None
            self._tokenizer = None

    def supports_pair(self, source_lang: str, target_lang: str) -> bool:
        src = registry.get(source_lang)
        tgt = registry.get(target_lang)
        return bool(src and tgt and src.nllb_code and tgt.nllb_code)

    async def translate_multi(
        self, segments: list[TranscriptSegment], source_lang: str, target_langs: list[str]
    ) -> dict[str, list[TranslatedSegment]]:
        """Translate the SAME segments into MANY target languages with a single
        batched generate() call (one GPU pass, not one per language).

        Each batch row carries its own target language via decoder_input_ids =
        [decoder_start, <tgt_lang_token>] -- generate()'s forced_bos_token_id can
        only express ONE language per call, which is what forced one separate
        (and GPU-contending) call per language before.
        """
        langs = [l for l in target_langs if self.supports_pair(source_lang, l)]
        if not langs or not segments:
            raise UnsupportedLanguageError(f"NLLB cannot translate {source_lang}->{target_langs}")
        if self._model is None:
            await self.load()

        src_entry = registry.get(source_lang)
        n = len(segments)

        def _run():
            import torch

            self._tokenizer.src_lang = src_entry.nllb_code
            enc = self._tokenizer(
                [s.text for s in segments], return_tensors="pt", padding=True, truncation=True
            )
            # Row order: for each language, each segment (language-major).
            input_ids = enc["input_ids"].repeat(len(langs), 1)
            attention_mask = enc["attention_mask"].repeat(len(langs), 1)
            start = self._model.config.decoder_start_token_id
            if start is None:
                start = self._model.config.eos_token_id
            lang_ids = [
                self._tokenizer.convert_tokens_to_ids(registry.get(l).nllb_code) for l in langs
            ]
            decoder_ids = torch.tensor([[start, lid] for lid in lang_ids for _ in range(n)])

            decoded: list[str] = []
            batch = max(settings.nllb_max_batch, n)
            for i in range(0, input_ids.shape[0], batch):
                kwargs = dict(
                    input_ids=input_ids[i : i + batch],
                    attention_mask=attention_mask[i : i + batch],
                    decoder_input_ids=decoder_ids[i : i + batch],
                )
                if settings.device.startswith("cuda"):
                    kwargs = {k: v.to(settings.device) for k, v in kwargs.items()}
                # Cap the output length relative to the input: low-resource target
                # languages can fall into repetition loops that run to the 256-token
                # ceiling, which stalls the whole batch (and then becomes a very long
                # TTS clip).
                max_new = min(256, max(32, int(kwargs["input_ids"].shape[1] * 2.5) + 16))
                generated = self._model.generate(**kwargs, max_new_tokens=max_new)
                decoded.extend(self._tokenizer.batch_decode(generated, skip_special_tokens=True))

            out: dict[str, list[TranslatedSegment]] = {}
            for li, lang in enumerate(langs):
                rows = decoded[li * n : (li + 1) * n]
                out[lang] = [
                    TranslatedSegment(id=seg.id, start=seg.start, end=seg.end, text=text)
                    for seg, text in zip(segments, rows)
                ]
            return out

        return await asyncio.get_event_loop().run_in_executor(None, _run)

    async def translate_batch(
        self, segments: list[TranscriptSegment], source_lang: str, target_lang: str
    ) -> list[TranslatedSegment]:
        if not self.supports_pair(source_lang, target_lang):
            raise UnsupportedLanguageError(f"NLLB has no FLORES code for {source_lang}->{target_lang}")
        if self._model is None:
            await self.load()

        src_entry = registry.get(source_lang)
        tgt_entry = registry.get(target_lang)

        def _run():
            self._tokenizer.src_lang = src_entry.nllb_code
            out: list[TranslatedSegment] = []
            batch = settings.nllb_max_batch
            for i in range(0, len(segments), batch):
                chunk = segments[i : i + batch]
                texts = [s.text for s in chunk]
                inputs = self._tokenizer(texts, return_tensors="pt", padding=True, truncation=True)
                if settings.device.startswith("cuda"):
                    inputs = {k: v.to(settings.device) for k, v in inputs.items()}
                forced_bos = self._tokenizer.convert_tokens_to_ids(tgt_entry.nllb_code)
                generated = self._model.generate(
                    **inputs, forced_bos_token_id=forced_bos, max_length=256
                )
                decoded = self._tokenizer.batch_decode(generated, skip_special_tokens=True)
                for seg, text in zip(chunk, decoded):
                    out.append(TranslatedSegment(id=seg.id, start=seg.start, end=seg.end, text=text))
            return out

        return await asyncio.get_event_loop().run_in_executor(None, _run)
