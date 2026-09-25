"""
GPU inference service — FastAPI app.

Endpoints (section 3):
  POST /transcribe   audio -> transcript (one shared STT model, any source lang)
  POST /translate    transcript segments -> translated segments, one target lang
  POST /tts          text -> synthesized audio, one target lang
  POST /process      audio -> {lang: {text, audio}} for MANY target langs in one
                      call, transcribing ONCE and fanning out (section 5)
  GET  /health       process + GPU + loaded-model status
  GET  /models       language registry summary + currently loaded models
  WS   /ws/stream     real-time segment-by-segment processing (see ws/stream_ws.py)

Provider-independent by construction: nothing here references RunPod or
Hyperstack. GPU_PROVIDER is informational only (surfaced in /health).
"""
from __future__ import annotations

import asyncio
import base64
import logging
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, UploadFile, WebSocket
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import settings
from app.engines.base import TranscriptSegment, UnsupportedLanguageError
from app.pipeline.process_pipeline import process_segment
from app.registry.language_registry import registry
from app.routing import model_router
from app.routing.model_pool import translation_pool, tts_pool
from app.ws.stream_ws import handle_stream

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")

app = FastAPI(title="ttsopensource GPU inference service", version="0.1.0")


def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


@app.on_event("startup")
async def _startup() -> None:
    await model_router.startup()
    asyncio.create_task(_idle_eviction_loop())


async def _idle_eviction_loop() -> None:
    while True:
        await asyncio.sleep(60)
        await translation_pool.evict_idle()
        await tts_pool.evict_idle()


# ── Schemas ──────────────────────────────────────────────────────────────────
class TranscribeRequest(BaseModel):
    audio_base64: str
    language_hint: Optional[str] = None


class TranslateSegmentIn(BaseModel):
    id: int
    start: float
    end: float
    text: str


class TranslateRequest(BaseModel):
    segments: list[TranslateSegmentIn]
    source_lang: str
    target_lang: str


class TTSRequest(BaseModel):
    text: str
    language_code: str
    voice_id: Optional[str] = None


class ProcessRequest(BaseModel):
    audio_base64: str
    target_langs: list[str]
    source_lang_hint: Optional[str] = None


def _write_temp_wav(audio_bytes: bytes) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.write(audio_bytes)
    tmp.close()
    return tmp.name


# ── Health / models ──────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    gpu_info = {"device": settings.device, "provider": settings.gpu_provider}
    try:
        import torch

        gpu_info["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            gpu_info["gpu_name"] = torch.cuda.get_device_name(settings.gpu_id)
            free, total = torch.cuda.mem_get_info(settings.gpu_id)
            gpu_info["vram_free_gb"] = round(free / 1e9, 2)
            gpu_info["vram_total_gb"] = round(total / 1e9, 2)
    except ImportError:
        gpu_info["cuda_available"] = None
    return {"status": "ok", "gpu": gpu_info, "models": model_router.status()}


@app.get("/models")
async def models():
    return {
        "language_registry": registry.summary(),
        "loaded": model_router.status(),
        "languages": [
            {
                "language_code": e.language_code,
                "language_name": e.language_name,
                "status": e.status,
                "enabled": e.enabled,
                "tts_engine": e.tts_engine,
            }
            for e in registry.all()
        ],
    }


# ── /transcribe ──────────────────────────────────────────────────────────────
@app.post("/transcribe", dependencies=[Depends(require_api_key)])
async def transcribe(req: TranscribeRequest):
    audio_bytes = base64.b64decode(req.audio_base64)
    path = _write_temp_wav(audio_bytes)
    try:
        result = await model_router.transcribe(path, language_hint=req.language_hint)
    finally:
        Path(path).unlink(missing_ok=True)
    return {
        "detected_language": result.detected_language,
        "segments": [s.__dict__ for s in result.segments],
    }


# ── /translate ───────────────────────────────────────────────────────────────
@app.post("/translate", dependencies=[Depends(require_api_key)])
async def translate(req: TranslateRequest):
    entry = registry.get(req.target_lang)
    if not entry or not entry.translation_supported:
        raise HTTPException(422, f"'{req.target_lang}' has no translation route configured")
    segments = [TranscriptSegment(id=s.id, start=s.start, end=s.end, text=s.text) for s in req.segments]
    try:
        translated, engine_used = await model_router.translate(segments, req.source_lang, req.target_lang)
    except UnsupportedLanguageError as e:
        raise HTTPException(422, str(e))
    return {
        "engine": engine_used,
        "segments": [s.__dict__ for s in translated],
    }


# ── /tts ─────────────────────────────────────────────────────────────────────
@app.post("/tts", dependencies=[Depends(require_api_key)])
async def tts(req: TTSRequest):
    entry = registry.get(req.language_code)
    if not entry or not entry.tts_supported:
        raise HTTPException(422, f"'{req.language_code}' has no TTS route configured")
    try:
        clip, engine_used = await model_router.synthesize(req.text, req.language_code, req.voice_id)
    except UnsupportedLanguageError as e:
        raise HTTPException(422, str(e))
    return JSONResponse(
        {
            "engine": engine_used,
            "sample_rate": clip.sample_rate,
            "format": clip.format,
            "audio_base64": base64.b64encode(clip.audio).decode("ascii"),
        }
    )


# ── /process — the section-5 fan-out endpoint ──────────────────────────────
@app.post("/process", dependencies=[Depends(require_api_key)])
async def process(req: ProcessRequest):
    unsupported = [l for l in req.target_langs if not (registry.get(l) and registry.get(l).enabled)]
    audio_bytes = base64.b64decode(req.audio_base64)
    path = _write_temp_wav(audio_bytes)
    try:
        result = await process_segment(path, req.target_langs, req.source_lang_hint)
    finally:
        Path(path).unlink(missing_ok=True)

    return {
        "source_lang": result.source_lang,
        "transcript_segments": len(result.transcript.segments),
        "not_enabled": unsupported,
        "languages": {
            lang: {
                "ok": r.ok,
                "text": r.text,
                "error": r.error,
                "translation_engine": r.translation_engine,
                "tts_engine": r.tts_engine,
                "sample_rate": r.sample_rate,
                "audio_base64": base64.b64encode(r.audio).decode("ascii") if r.audio else None,
            }
            for lang, r in result.languages.items()
        },
    }


# ── WebSocket streaming ──────────────────────────────────────────────────────
@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket):
    if settings.api_key and websocket.headers.get("x-api-key") != settings.api_key:
        await websocket.close(code=4401)
        return
    await handle_stream(websocket)
