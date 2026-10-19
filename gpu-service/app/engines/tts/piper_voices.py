"""
Downloads Piper voice files (rhasspy/piper-voices on HuggingFace) on demand.

The container entrypoint only pre-fetches four starter voices. A pod serving a
shard of the 100-language set needs ~25 more, so the voice file is fetched here
the first time it is needed (or during startup preload, see app/preload.py).
Paths follow the repo layout: <lang>/<lang_COUNTRY>/<name>/<quality>/<voice_id>.onnx
"""
from __future__ import annotations

import logging
import urllib.request
from pathlib import Path

from app.config import settings

log = logging.getLogger("piper_voices")

_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"


def voice_urls(voice_id: str) -> tuple[str, str]:
    locale, name, quality = voice_id.split("-", 2)
    lang = locale.split("_")[0]
    base = f"{_BASE}/{lang}/{locale}/{name}/{quality}/{voice_id}"
    return f"{base}.onnx", f"{base}.onnx.json"


def _fetch(url: str, dest: Path, attempts: int = 3) -> None:
    last: Exception | None = None
    for _ in range(attempts):
        part = dest.with_suffix(dest.suffix + ".part")
        try:
            with urllib.request.urlopen(url, timeout=120) as resp, open(part, "wb") as out:
                while True:
                    block = resp.read(1 << 20)
                    if not block:
                        break
                    out.write(block)
            part.replace(dest)
            return
        except Exception as e:  # noqa: BLE001 -- retry transient network errors
            last = e
            part.unlink(missing_ok=True)
    raise RuntimeError(f"download failed for {url}: {last}")


def ensure_voice(voice_id: str) -> Path:
    """Blocking (run it in an executor). Returns the local .onnx path."""
    voices_dir = Path(settings.piper_voices_dir)
    voices_dir.mkdir(parents=True, exist_ok=True)
    onnx = voices_dir / f"{voice_id}.onnx"
    cfg = voices_dir / f"{voice_id}.onnx.json"
    if onnx.exists() and cfg.exists():
        return onnx
    onnx_url, cfg_url = voice_urls(voice_id)
    log.info("downloading Piper voice %s", voice_id)
    if not cfg.exists():
        _fetch(cfg_url, cfg)
    if not onnx.exists():
        _fetch(onnx_url, onnx)
    return onnx
