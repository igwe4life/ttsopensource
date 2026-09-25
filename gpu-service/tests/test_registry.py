"""
No GPU/model downloads required — these just verify the registry loader and
status computation are internally consistent. Run with: pytest tests/
"""
from app.registry.language_registry import registry


def test_registry_loads_and_has_languages():
    langs = registry.all()
    assert len(langs) >= 50, "expected the ~100-language initial target"


def test_every_available_language_has_all_three_stages():
    for entry in registry.all():
        if entry.status == "available":
            assert entry.stt_supported, entry.language_code
            assert entry.translation_supported, entry.language_code
            assert entry.tts_supported, entry.language_code


def test_unsupported_never_enabled():
    for entry in registry.all():
        if entry.status == "unsupported":
            assert not entry.enabled, f"{entry.language_code} is unsupported but enabled"


def test_known_language_spanish_is_available():
    es = registry.get("es")
    assert es is not None
    assert es.nllb_code == "spa_Latn"
    assert es.status in ("available", "limited")


def test_requested_african_languages_present():
    # Section 8 explicitly names these — they must at least exist in the
    # registry, even if some stages are still experimental/unsupported.
    for code in ["yo", "ig", "ha", "sw", "am", "zu", "xh", "sn", "so", "tw", "wo", "ln", "rw", "ff"]:
        assert registry.get(code) is not None, f"missing requested language: {code}"
