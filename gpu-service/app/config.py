"""
Central config for the GPU inference service. Everything is env-driven so the
same Docker image runs unmodified on RunPod, Hyperstack, or bare metal — only
env vars change between providers (see deploy/runpod and deploy/hyperstack).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(key: str, default: bool) -> bool:
    v = os.environ.get(key)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


def _float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


REPO_ROOT = Path(__file__).resolve().parents[2]  # C:\ttsopensource


@dataclass(frozen=True)
class Settings:
    # --- device / runtime ---------------------------------------------------
    device: str = os.environ.get("DEVICE", "cuda")  # 'cuda' | 'cpu' | 'mps'
    compute_type: str = os.environ.get("COMPUTE_TYPE", "float16")  # faster-whisper/ctranslate2 dtype
    gpu_id: int = _int("GPU_ID", 0)

    # --- language registry ---------------------------------------------------
    # Single source of truth shared with the Node orchestrator — see
    # language-registry/README.md. Never duplicate this file.
    language_registry_path: Path = Path(
        os.environ.get(
            "LANGUAGE_REGISTRY_PATH",
            str(REPO_ROOT / "language-registry" / "languages.json"),
        )
    )
    language_overrides_path: Path = Path(
        os.environ.get(
            "LANGUAGE_OVERRIDES_PATH",
            str(REPO_ROOT / "language-registry" / "overrides.json"),
        )
    )

    # --- STT (shared across ALL source languages — one model, see docs) -----
    stt_engine: str = os.environ.get("STT_ENGINE", "faster-whisper")  # 'faster-whisper' | 'whisper'
    whisper_model_size: str = os.environ.get("WHISPER_MODEL_SIZE", "large-v3")
    whisper_model_dir: str = os.environ.get("WHISPER_MODEL_DIR", "")  # blank -> HF cache default

    # --- Translation ----------------------------------------------------------
    nllb_model_id: str = os.environ.get("NLLB_MODEL_ID", "facebook/nllb-200-distilled-600M")
    nllb_max_batch: int = _int("NLLB_MAX_BATCH", 16)
    opus_mt_model_template: str = os.environ.get(
        "OPUS_MT_MODEL_TEMPLATE", "Helsinki-NLP/opus-mt-{src}-{tgt}"
    )

    # --- TTS --------------------------------------------------------------
    piper_voices_dir: str = os.environ.get("PIPER_VOICES_DIR", str(REPO_ROOT / "models" / "piper"))
    piper_binary: str = os.environ.get("PIPER_BINARY", "piper")
    xtts_model_id: str = os.environ.get("XTTS_MODEL_ID", "coqui/XTTS-v2")
    mms_tts_model_template: str = os.environ.get(
        "MMS_TTS_MODEL_TEMPLATE", "facebook/mms-tts-{code}"
    )

    # --- Model pool / routing (section 7: intelligent model routing) --------
    max_loaded_tts_models: int = _int("MAX_LOADED_TTS_MODELS", 6)
    max_loaded_translation_models: int = _int("MAX_LOADED_TRANSLATION_MODELS", 4)
    model_idle_unload_seconds: int = _int("MODEL_IDLE_UNLOAD_SECONDS", 900)

    # --- Real-time processing knobs (section 4) -----------------------------
    chunk_seconds: float = _float("CHUNK_SECONDS", 6.0)
    max_queue_depth: int = _int("MAX_QUEUE_DEPTH", 8)
    segment_deadline_ms: int = _int("SEGMENT_DEADLINE_MS", 12000)

    # --- HTTP / WS server ----------------------------------------------------
    host: str = os.environ.get("HOST", "0.0.0.0")
    port: int = _int("PORT", 8000)
    api_key: str = os.environ.get("GPU_SERVICE_API_KEY", "")  # blank -> auth disabled (dev only)

    # --- Model provider (informational; provider-independence is by design —
    # nothing in this service branches on it) ---------------------------------
    gpu_provider: str = os.environ.get("GPU_PROVIDER", "generic")  # 'runpod' | 'hyperstack' | 'generic'


settings = Settings()
