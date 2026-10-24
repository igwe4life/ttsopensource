"""
GPU memory visibility and self-healing.

Free VRAM on a pod slowly shrinks over many hours until every request fails with a CUDA out-of-memory
error. Two things live here:

* gpu_snapshot(): who holds the memory (per-process, from nvidia-smi, plus this process's own torch
  numbers), exposed on /health so the source of the growth can be identified.
* run_guard(): a watchdog that restarts the service (docker-entrypoint.sh relaunches it, ~1 min with warm
  caches) when free VRAM stays low, or when the process has simply been up too long. The planned uptime
  has random jitter so the pods of a pool do not all restart at the same moment.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import signal
import subprocess
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("gpu_guard")

LAST_RESTART_FILE = Path(os.environ.get("GPU_GUARD_STATE_FILE", "/tmp/gpu_guard_last_restart"))
RESTART_EXIT_CODE = 75

_started = time.time()
_state: dict = {"min_free_gb": None, "low_streak": 0, "restart_at_h": None, "last_restart": None}


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, default))
    except ValueError:
        return default


def should_restart(
    free_gb: Optional[float],
    low_streak: int,
    uptime_h: float,
    planned_uptime_h: float,
    min_free_gb: float,
    streak_needed: int = 3,
    warmup_h: float = 0.1,
) -> Optional[str]:
    """Decision rule, kept pure so it can be unit tested. Returns the reason to restart, or None."""
    if uptime_h >= planned_uptime_h > 0:
        return f"planned restart after {uptime_h:.1f} h of uptime"
    if free_gb is not None and uptime_h > warmup_h and free_gb < min_free_gb and low_streak >= streak_needed:
        return f"free GPU memory stayed below {min_free_gb} GB (now {free_gb} GB)"
    return None


def planned_uptime_hours(max_uptime_h: float, jitter_h: float, rng=random) -> float:
    """Planned restart time: max_uptime_h minus a random 0..jitter_h so pods are staggered. 0 disables."""
    if max_uptime_h <= 0:
        return 0.0
    return max(0.25, max_uptime_h - rng.random() * max(0.0, jitter_h))


def _proc_name(pid: int) -> str:
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        return "?"
    if "multiprocessing.spawn" in cmd or "spawn_main" in cmd:
        return "tts-worker"
    if "uvicorn" in cmd:
        return "main(stt+translation)"
    return cmd[:60] or "?"


def gpu_snapshot() -> dict:
    """Best-effort breakdown of GPU memory use; never raises."""
    snap: dict = {}
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        apps = []
        for line in out.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 2 and parts[0].isdigit():
                try:
                    mb = int(parts[1])
                except ValueError:
                    continue
                apps.append({"pid": int(parts[0]), "used_mb": mb, "name": _proc_name(int(parts[0]))})
        snap["processes"] = sorted(apps, key=lambda a: -a["used_mb"])
        snap["processes_total_mb"] = sum(a["used_mb"] for a in apps)
    except Exception as e:  # noqa: BLE001
        snap["processes_error"] = f"{type(e).__name__}: {e}"[:120]
    try:
        import torch

        if torch.cuda.is_available():
            snap["main_torch_reserved_mb"] = round(torch.cuda.memory_reserved() / 1e6)
            snap["main_torch_allocated_mb"] = round(torch.cuda.memory_allocated() / 1e6)
    except Exception:  # noqa: BLE001
        pass
    return snap


def status() -> dict:
    up_h = (time.time() - _started) / 3600
    last = None
    try:
        last = LAST_RESTART_FILE.read_text().strip() or None
    except OSError:
        pass
    return {
        "uptime_h": round(up_h, 2),
        "planned_restart_at_h": _state["restart_at_h"] and round(_state["restart_at_h"], 2),
        "min_free_gb_seen": _state["min_free_gb"],
        "low_streak": _state["low_streak"],
        "last_restart_reason": last,
        "memory": gpu_snapshot(),
    }


def _kill_children() -> None:
    """Stop the TTS worker processes (and anything else we spawned) so none is orphaned holding VRAM."""
    me = os.getpid()
    try:
        for p in Path("/proc").iterdir():
            if not p.name.isdigit():
                continue
            try:
                fields = (p / "stat").read_text().rsplit(")", 1)[1].split()
                if int(fields[1]) == me:
                    os.kill(int(p.name), signal.SIGKILL)
            except (OSError, IndexError, ValueError):
                continue
    except OSError:
        pass


def restart_service(reason: str) -> None:
    log.error("GPU guard restarting the service: %s", reason)
    try:
        LAST_RESTART_FILE.write_text(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {reason}")
    except OSError:
        pass
    _kill_children()
    os._exit(RESTART_EXIT_CODE)  # docker-entrypoint.sh starts uvicorn again


async def run_guard(get_free_gb) -> None:
    """Background task. get_free_gb() -> free VRAM in GB, or None when there is no GPU."""
    min_free = _env_float("GPU_MIN_FREE_GB", 1.5)
    planned = planned_uptime_hours(_env_float("GPU_MAX_UPTIME_HOURS", 20.0), _env_float("GPU_UPTIME_JITTER_HOURS", 4.0))
    _state["restart_at_h"] = planned
    log.info("GPU guard on: restart if free < %.1f GB for 90 s, planned restart after %.1f h", min_free, planned)
    while True:
        await asyncio.sleep(30)
        try:
            free = get_free_gb()
        except Exception:  # noqa: BLE001
            free = None
        if free is not None:
            _state["min_free_gb"] = free if _state["min_free_gb"] is None else min(_state["min_free_gb"], free)
            _state["low_streak"] = _state["low_streak"] + 1 if free < min_free else 0
        uptime_h = (time.time() - _started) / 3600
        reason = should_restart(free, _state["low_streak"], uptime_h, planned, min_free)
        if reason:
            restart_service(reason)
