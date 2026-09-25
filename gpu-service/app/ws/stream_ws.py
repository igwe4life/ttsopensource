"""
WebSocket streaming endpoint for real-time segment processing.

Protocol (deliberately simple — JSON control frame immediately followed by one
binary frame per segment):

  client -> server:
    1. text frame:   {"type":"segment","seq":<int>,"target_langs":["fr","es"],
                       "source_lang_hint":"en"}
    2. binary frame: raw WAV bytes (16kHz mono PCM) for that segment

  server -> client (as each target language finishes — NOT batched, so a slow
  language doesn't hold up a fast one):
    text frame: {"type":"result","seq":<int>,"language":"fr","ok":true,
                 "text":"...","translation_engine":"nllb","tts_engine":"piper",
                 "sample_rate":22050,"audio_bytes":<int>}
    binary frame: the WAV audio for that (seq, language) pair, immediately after

  server -> client (fatal per-segment error):
    text frame: {"type":"error","seq":<int>,"message":"..."}

This is what the orchestrator's live pipeline talks to instead of spawning a
new HTTP request per segment — avoids reconnect/TLS overhead on every ~6s
chunk during a long-running stream.
"""
from __future__ import annotations

import json
import logging
import tempfile
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect

from app.pipeline.process_pipeline import process_segment

log = logging.getLogger("stream_ws")


async def handle_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    tmp_dir = Path(tempfile.mkdtemp(prefix="ttsopensource_ws_"))
    try:
        while True:
            control_raw = await websocket.receive_text()
            try:
                control = json.loads(control_raw)
            except json.JSONDecodeError:
                await _send_error(websocket, None, "control frame was not valid JSON")
                continue

            if control.get("type") != "segment":
                await _send_error(websocket, control.get("seq"), f"unknown frame type: {control.get('type')}")
                continue

            seq = control.get("seq")
            target_langs = control.get("target_langs") or []
            source_hint = control.get("source_lang_hint")

            audio_bytes = await websocket.receive_bytes()
            seg_path = tmp_dir / f"seg_{seq}.wav"
            seg_path.write_bytes(audio_bytes)

            try:
                result = await process_segment(str(seg_path), target_langs, source_hint)
            except Exception as e:  # noqa: BLE001
                log.exception("segment %s processing failed", seq)
                await _send_error(websocket, seq, f"{type(e).__name__}: {e}")
                continue
            finally:
                seg_path.unlink(missing_ok=True)

            for lang, lang_result in result.languages.items():
                payload = {
                    "type": "result",
                    "seq": seq,
                    "language": lang,
                    "ok": lang_result.ok,
                    "text": lang_result.text,
                    "translation_engine": lang_result.translation_engine,
                    "tts_engine": lang_result.tts_engine,
                    "error": lang_result.error,
                    "sample_rate": lang_result.sample_rate,
                    "audio_bytes": len(lang_result.audio) if lang_result.audio else 0,
                }
                await websocket.send_text(json.dumps(payload))
                if lang_result.ok and lang_result.audio:
                    await websocket.send_bytes(lang_result.audio)
    except WebSocketDisconnect:
        log.info("stream client disconnected")
    finally:
        for f in tmp_dir.glob("*"):
            f.unlink(missing_ok=True)
        tmp_dir.rmdir()


async def _send_error(websocket: WebSocket, seq, message: str) -> None:
    await websocket.send_text(json.dumps({"type": "error", "seq": seq, "message": message}))
