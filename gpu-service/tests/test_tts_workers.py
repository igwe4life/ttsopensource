"""Pure-logic tests for the TTS worker pool (no GPU, no processes started)."""
from app.tts_workers import assign_workers, worker_index


def test_every_language_gets_exactly_one_worker():
    langs = [f"l{i}" for i in range(25)]
    out = assign_workers(langs, 4)
    assert set(out) == set(langs)
    assert set(out.values()) <= {0, 1, 2, 3}


def test_equal_cost_is_balanced():
    out = assign_workers([f"l{i}" for i in range(25)], 4)
    counts = [list(out.values()).count(w) for w in range(4)]
    assert max(counts) - min(counts) <= 1


def test_expensive_languages_are_spread_out():
    langs = [f"m{i}" for i in range(8)] + [f"p{i}" for i in range(16)]
    out = assign_workers(langs, 4, cost=lambda lang: 3 if lang.startswith("m") else 1)
    mms_per_worker = [sum(1 for lang, w in out.items() if w == k and lang.startswith("m")) for k in range(4)]
    assert mms_per_worker == [2, 2, 2, 2]
    load = [sum((3 if lang.startswith("m") else 1) for lang, w in out.items() if w == k) for k in range(4)]
    assert max(load) - min(load) <= 1


def test_assignment_is_deterministic():
    langs = ["es", "am", "fr", "ha", "de", "yo"]
    cost = lambda lang: 3 if lang in ("am", "ha", "yo") else 1  # noqa: E731
    assert assign_workers(langs, 3, cost) == assign_workers(list(langs), 3, cost)


def test_unlisted_language_has_a_stable_owner_in_range():
    assignment = assign_workers(["es", "fr"], 3)
    first = worker_index("xx", assignment, 3)
    assert 0 <= first < 3
    assert first == worker_index("xx", assignment, 3)
    assert worker_index("es", assignment, 3) == assignment["es"]
