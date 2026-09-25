"""
RunPod Serverless handler. Adapts the same pipeline code the FastAPI app uses
(app.pipeline.process_pipeline.process_segment) to RunPod's `handler(event)`
contract, so there is exactly one implementation of "transcribe once, fan out
to N languages" — this file is routing/glue only, no logic duplicated.

Deploy with deploy/runpod/Dockerfile.serverless. See README.md in this
directory for Pod vs. Serverless tradeoffs.
"""
from __future__ import annotations

import base64
import tempfile
from pathlib import Path

import runpod

from app.pipeline.process_pipeline import process_segment
from app.routing import model_router

_started = False


async def _ensure_started():
    global _started
    if not _started:
        await model_router.startup()
        _started = True


async def handler(event: dict) -> dict:
    """
    event["input"] = {
      "audio_base64": "...",       # 16kHz mono WAV
      "target_langs": ["fr", "es"],
      "source_lang_hint": "en"      # optional
    }
    """
    await _ensure_started()
    inp = event.get("input", {})
    audio_bytes = base64.b64decode(inp["audio_base64"])
    target_langs = inp.get("target_langs", [])
    source_hint = inp.get("source_lang_hint")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.write(audio_bytes)
    tmp.close()
    try:
        result = await process_segment(tmp.name, target_langs, source_hint)
    finally:
        Path(tmp.name).unlink(missing_ok=True)

    return {
        "source_lang": result.source_lang,
        "languages": {
            lang: {
                "ok": r.ok,
                "text": r.text,
                "error": r.error,
                "audio_base64": base64.b64encode(r.audio).decode("ascii") if r.audio else None,
                "sample_rate": r.sample_rate,
            }
            for lang, r in result.languages.items()
        },
    }


runpod.serverless.start({"handler": handler})
