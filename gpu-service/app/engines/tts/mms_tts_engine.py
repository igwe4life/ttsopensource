"""
MMS-TTS (Meta's Massively Multilingual Speech project, facebook/mms-tts-*) —
the long-tail TTS engine. This is THE scaling path to 500-1000+ languages:
1107 per-language VITS checkpoints on HuggingFace, including most of the
lower-resource languages named in the brief (Yoruba, Igbo, Hausa, Swahili,
Amharic, Zulu, Xhosa, Shona, Somali, Twi, Wolof, Lingala, Kinyarwanda, Fula).

Quality is noticeably more robotic than Piper/XTTS and coverage claims in
language-registry are marked `experimental` until verified (see
scripts/verify-models.js) — this engine intentionally does NOT get promoted to
"high" quality automatically. It exists so a language has *some* working TTS
route rather than none, which is the whole point of the routing/fallback
design in section 7.

Each language is its own small checkpoint (~20-100MB), so unlike NLLB this
engine loads models ON DEMAND and relies on the model pool
(routing/model_pool.py) to evict idle ones — you cannot keep 1000+ of these
resident in VRAM at once.
"""
from __future__ import annotations

import asyncio
import io
from typing import Optional

from app.config import settings
from app.engines.base import EngineLoadError, SynthesizedClip, TextToSpeechEngine, UnsupportedLanguageError
from app.registry.language_registry import registry

MMS_SAMPLE_RATE = 16000  # VITS output rate for MMS-TTS checkpoints


class MMSTTSEngine(TextToSpeechEngine):
    name = "mms"

    def __init__(self):
        self._models: dict[str, tuple] = {}  # mms_code -> (model, tokenizer)
        self._lock = asyncio.Lock()

    def supports(self, language_code: str) -> bool:
        entry = registry.get(language_code)
        return bool(entry and entry.tts_engine == "mms")

    def is_loaded(self, language_code: str, voice_id: Optional[str] = None) -> bool:
        entry = registry.get(language_code)
        return bool(entry and entry.voice_id in self._models)

    async def load(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        if not entry or entry.tts_engine != "mms":
            raise UnsupportedLanguageError(f"No MMS-TTS checkpoint configured for {language_code}")
        mms_code = voice_id or entry.voice_id
        if mms_code in self._models:
            return
        async with self._lock:
            if mms_code in self._models:
                return
            try:
                from transformers import VitsModel, AutoTokenizer
            except ImportError as e:
                raise EngineLoadError("transformers is not installed. `pip install transformers`.") from e

            model_id = settings.mms_tts_model_template.format(code=mms_code)

            def _load():
                tokenizer = AutoTokenizer.from_pretrained(model_id)
                model = VitsModel.from_pretrained(model_id)
                if settings.device.startswith("cuda"):
                    model = model.to(settings.device)
                model.eval()
                return model, tokenizer

            try:
                self._models[mms_code] = await asyncio.get_event_loop().run_in_executor(None, _load)
            except OSError as e:
                raise EngineLoadError(
                    f"No MMS-TTS checkpoint found at {model_id} — the code in "
                    f"language-registry may be wrong; see notes field for that language."
                ) from e

    async def unload(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        mms_code = voice_id or (entry.voice_id if entry else None)
        async with self._lock:
            self._models.pop(mms_code, None)

    async def synthesize(
        self, text: str, language_code: str, voice_id: Optional[str] = None
    ) -> SynthesizedClip:
        entry = registry.get(language_code)
        if not entry or entry.tts_engine != "mms":
            raise UnsupportedLanguageError(f"No MMS-TTS checkpoint configured for {language_code}")
        mms_code = voice_id or entry.voice_id
        if mms_code not in self._models:
            await self.load(language_code, mms_code)
        model, tokenizer = self._models[mms_code]

        def _run():
            import torch

            inputs = tokenizer(text, return_tensors="pt")
            if settings.device.startswith("cuda"):
                inputs = {k: v.to(settings.device) for k, v in inputs.items()}
            with torch.no_grad():
                output = model(**inputs).waveform
            return _floats_to_wav(output.squeeze().cpu().numpy(), MMS_SAMPLE_RATE)

        wav_bytes = await asyncio.get_event_loop().run_in_executor(None, _run)
        return SynthesizedClip(audio=wav_bytes, sample_rate=MMS_SAMPLE_RATE)


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
