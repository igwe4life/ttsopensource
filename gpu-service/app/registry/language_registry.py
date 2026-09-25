"""
Loads language-registry/languages.json (the single cross-service source of
truth — see language-registry/README.md) and answers capability questions for
the router and API layer.

Both this file and orchestrator/src/config.js read the SAME json file. Do not
re-implement language data here — this module is a thin query layer only.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.config import settings


@dataclass(frozen=True)
class LanguageEntry:
    language_code: str
    language_name: str
    native_name: str
    whisper_code: Optional[str]
    stt_supported: bool
    stt_fallback: Optional[str]
    nllb_code: Optional[str]
    translation_supported: bool
    translation_model: Optional[str]
    translation_fallback: Optional[str]
    tts_supported: bool
    tts_engine: Optional[str]
    tts_model: Optional[str]
    voice_id: Optional[str]
    quality_level: str
    status: str
    enabled: bool
    priority: int
    notes: str

    @staticmethod
    def from_dict(d: dict) -> "LanguageEntry":
        return LanguageEntry(
            language_code=d["language_code"],
            language_name=d["language_name"],
            native_name=d["native_name"],
            whisper_code=d.get("whisper_code"),
            stt_supported=d.get("stt_supported", False),
            stt_fallback=d.get("stt_fallback"),
            nllb_code=d.get("nllb_code"),
            translation_supported=d.get("translation_supported", False),
            translation_model=d.get("translation_model"),
            translation_fallback=d.get("translation_fallback"),
            tts_supported=d.get("tts_supported", False),
            tts_engine=d.get("tts_engine"),
            tts_model=d.get("tts_model"),
            voice_id=d.get("voice_id"),
            quality_level=d.get("quality_level", "unsupported"),
            status=d.get("status", "unsupported"),
            enabled=d.get("enabled", False),
            priority=d.get("priority", 3),
            notes=d.get("notes", ""),
        )


def _compute_status(entry: dict) -> str:
    """Mirrors scripts/build-registry.js and the Node config.js equivalent —
    keep all three in sync if this logic ever changes. Recomputed after
    override merge so an override's quality_level change (e.g. after
    scripts/verify-models.js confirms a checkpoint) can't silently leave a
    stale `status` behind."""
    if not entry.get("translation_supported") or not entry.get("tts_supported"):
        return "unsupported"
    if not entry.get("stt_supported") or entry.get("quality_level") == "experimental":
        return "experimental"
    if entry.get("quality_level") in ("medium", "limited"):
        return "limited"
    return "available"


class LanguageRegistry:
    """Loaded once at process start; call `reload()` to pick up edits without
    restarting the service (e.g. after flipping an override to enabled)."""

    def __init__(self, registry_path: Path, overrides_path: Path):
        self._registry_path = registry_path
        self._overrides_path = overrides_path
        self._lock = threading.Lock()
        self._by_code: dict[str, LanguageEntry] = {}
        self.reload()

    def reload(self) -> None:
        with self._lock:
            raw = json.loads(self._registry_path.read_text(encoding="utf-8"))
            overrides = {}
            if self._overrides_path.exists():
                overrides = json.loads(self._overrides_path.read_text(encoding="utf-8"))

            by_code = {}
            for entry in raw.get("languages", []):
                code = entry["language_code"]
                merged = {**entry, **overrides.get(code, {})}
                merged["status"] = _compute_status(merged)
                by_code[code] = LanguageEntry.from_dict(merged)
            self._by_code = by_code

    def get(self, code: str) -> Optional[LanguageEntry]:
        return self._by_code.get(code)

    def all(self) -> list[LanguageEntry]:
        return list(self._by_code.values())

    def enabled(self) -> list[LanguageEntry]:
        return [e for e in self._by_code.values() if e.enabled]

    def supports_stt(self, code: str) -> bool:
        e = self.get(code)
        return bool(e and e.stt_supported)

    def supports_translation(self, code: str) -> bool:
        e = self.get(code)
        return bool(e and e.translation_supported)

    def supports_tts(self, code: str) -> bool:
        e = self.get(code)
        return bool(e and e.tts_supported)

    def summary(self) -> dict:
        counts: dict[str, int] = {}
        for e in self._by_code.values():
            counts[e.status] = counts.get(e.status, 0) + 1
        return {
            "total": len(self._by_code),
            "enabled": sum(1 for e in self._by_code.values() if e.enabled),
            "by_status": counts,
        }


registry = LanguageRegistry(settings.language_registry_path, settings.language_overrides_path)
