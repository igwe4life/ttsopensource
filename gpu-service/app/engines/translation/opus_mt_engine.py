"""
OPUS-MT is just Helsinki-NLP's public set of MarianMT checkpoints — this class
is a thin naming wrapper over MarianEngine so the router/config can refer to
"opus-mt" as a distinct engine name (matching the brief's OPUSEngine /
MarianEngine split) while sharing 100% of the loading/inference code.
"""
from __future__ import annotations

from app.engines.translation.marian_engine import MarianEngine


class OPUSEngine(MarianEngine):
    name = "opus-mt"
