import random

from app.gpu_guard import planned_uptime_hours, should_restart


def test_no_restart_when_healthy():
    assert should_restart(8.0, 0, 3.0, 20.0, 1.5) is None


def test_planned_restart_after_uptime():
    assert "planned" in should_restart(8.0, 0, 20.5, 20.0, 1.5)


def test_planned_restart_disabled_with_zero():
    assert should_restart(8.0, 0, 500.0, 0.0, 1.5) is None


def test_low_memory_needs_a_streak():
    assert should_restart(0.2, 2, 5.0, 20.0, 1.5) is None
    assert "below" in should_restart(0.2, 3, 5.0, 20.0, 1.5)


def test_low_memory_ignored_during_warmup():
    assert should_restart(0.2, 5, 0.01, 20.0, 1.5) is None


def test_no_gpu_never_restarts_on_memory():
    assert should_restart(None, 9, 5.0, 20.0, 1.5) is None


def test_planned_uptime_is_jittered_and_bounded():
    rng = random.Random(1)
    vals = {round(planned_uptime_hours(20.0, 4.0, rng), 2) for _ in range(20)}
    assert len(vals) > 5
    assert all(16.0 <= v <= 20.0 for v in vals)
    assert planned_uptime_hours(0, 4.0) == 0.0
