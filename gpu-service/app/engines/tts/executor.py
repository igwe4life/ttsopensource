"""One bounded thread pool for every TTS engine (see settings.tts_workers)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from app.config import settings

tts_executor = ThreadPoolExecutor(max_workers=max(1, settings.tts_workers), thread_name_prefix="tts")
