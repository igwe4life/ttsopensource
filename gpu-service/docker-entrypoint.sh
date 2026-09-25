#!/bin/sh
# Downloads a small, VERIFIED-real starter set of Piper voices on first boot
# (skipped if already present — e.g. a persisted volume from a previous run),
# so `docker compose up` produces working TTS immediately for a few major
# languages instead of failing until someone manually fetches .onnx files.
# Paths were checked against the live rhasspy/piper-voices HF repo tree
# before being hardcoded here — see scripts/build-registry.js's PIPER_VOICES
# table for the full (also-verified) set covering more languages; download
# more of those the same way if you want them pre-fetched too.
set -e

mkdir -p "$PIPER_VOICES_DIR"

# NOTE: deliberately does NOT let a download failure kill the container.
# `set -e` is active for the rest of this script, but a transient network
# blip fetching a starter voice shouldn't crash-loop the whole GPU service —
# it should just start without that one voice (the router/registry already
# treat a missing voice file as a per-request error, not a startup failure).
# code -> "voice_id|hf_subpath" (subpath is lang/lang_COUNTRY/name/quality)
fetch_voice() {
  voice_id="$1"
  subpath="$2"
  onnx="$PIPER_VOICES_DIR/$voice_id.onnx"
  if [ -f "$onnx" ]; then
    echo "[entrypoint] $voice_id already present, skipping"
    return 0
  fi
  echo "[entrypoint] downloading Piper voice: $voice_id"
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/$subpath"
  if curl -fsSL -o "$onnx.part" "$base/$voice_id.onnx"; then
    mv "$onnx.part" "$onnx"
    curl -fsSL -o "$onnx.json" "$base/$voice_id.onnx.json" || echo "[entrypoint] WARN: $voice_id.onnx.json fetch failed (voice may still work without it)"
  else
    echo "[entrypoint] WARN: failed to download $voice_id — continuing without it (network issue? check HF availability)"
    rm -f "$onnx.part"
  fi
  return 0
}

fetch_voice en_US-lessac-medium   en/en_US/lessac/medium
fetch_voice es_ES-sharvard-medium es/es_ES/sharvard/medium
fetch_voice fr_FR-siwis-medium    fr/fr_FR/siwis/medium
fetch_voice de_DE-thorsten-medium de/de_DE/thorsten/medium

echo "[entrypoint] starting uvicorn"
exec python3.11 -m uvicorn app.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}"
