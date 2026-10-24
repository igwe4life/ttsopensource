"""
TTS worker processes.

Why: per language and per chunk the service spends ~0.1-0.15 s of CPU-bound Python
(phonemizing, tokenizing, WAV encoding, numpy) around each voice. Python runs only
one thread of its own code at a time (the GIL), so 25 languages queue up behind one
another in a single process (~3.5 s per chunk) while the GPU and the pod's other
~30 CPU cores sit idle.

What: with TTS_WORKER_PROCS=N the main process starts N *separate* Python processes.
Each worker owns a share of the languages: it downloads, loads and warms only its own
voices (Piper and MMS) and synthesizes them one after another. The main process keeps
Whisper and NLLB (it is the only one that talks to the orchestrator); for each chunk it
translates once, hands every worker its languages' texts, and the workers synthesize in
parallel on different CPU cores, sharing the pod's one GPU.

Off by default (TTS_WORKER_PROCS=0 keeps the original single-process behavior).
Heavy imports (torch, onnxruntime, transformers) stay inside worker_main so this module
can be imported by tests and by the main process cheaply.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import multiprocessing
import os
import threading
import time
import zlib
from typing import Optional

from app.engines.base import SynthesizedClip, UnsupportedLanguageError

log = logging.getLogger("tts_workers")


# ── Pure logic (unit-tested) ────────────────────────────────────────────────
def assign_workers(languages: list[str], n: int, cost=None) -> dict[str, int]:
    """Balance languages across n workers by estimated cost (greedy longest-first:
    the most expensive voice goes to the currently least-loaded worker). Deterministic.
    `cost(lang)` defaults to 1 for every language, which degrades to round-robin."""
    cost = cost or (lambda _lang: 1)
    order = sorted(range(len(languages)), key=lambda i: (-cost(languages[i]), i))
    load = [0.0] * n
    out: dict[str, int] = {}
    for i in order:
        w = min(range(n), key=lambda k: (load[k], k))
        out[languages[i]] = w
        load[w] += cost(languages[i])
    return out


def default_cost(lang: str) -> float:
    """Measured: an MMS voice costs ~3x a Piper voice per chunk."""
    from app.registry.language_registry import registry

    entry = registry.get(lang)
    return 3.0 if entry is not None and entry.tts_engine == "mms" else 1.0


def worker_index(lang: str, assignment: dict[str, int], n: int) -> int:
    """Worker that owns `lang`. A language outside the preload list gets a stable
    hash-based owner and loads its voice lazily on first use."""
    if lang in assignment:
        return assignment[lang]
    return zlib.crc32(lang.encode("utf-8")) % n


# ── Worker process ──────────────────────────────────────────────────────────
def worker_main(idx: int, in_q, out_q, languages: list[str]) -> None:
    """Entry point of one worker process (started with the 'spawn' method)."""
    # Each process would otherwise start torch/OpenMP threads for every core.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")  # before torch is imported
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")
    logging.basicConfig(level=logging.INFO, format=f"%(asctime)s %(levelname)s tts-worker-{idx}: %(message)s")
    try:
        _worker_loop(idx, in_q, out_q, languages)
    except BaseException as e:  # noqa: BLE001 -- tell the parent why we died
        try:
            out_q.put(("fatal", idx, f"{type(e).__name__}: {e}"[:300]))
        finally:
            raise


def _trim_gpu_cache() -> None:
    """Hand cached-but-unused GPU memory back so it cannot creep up over hours."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _report_mem(out_q, idx: int) -> None:
    """Tell the parent how much GPU memory this worker's torch holds (for the /health memory breakdown)."""
    try:
        import torch

        if torch.cuda.is_available():
            out_q.put(("mem", idx, {"torch_reserved_mb": round(torch.cuda.memory_reserved() / 1e6), "torch_allocated_mb": round(torch.cuda.memory_allocated() / 1e6)}))
    except Exception:  # noqa: BLE001
        pass


def _worker_loop(idx: int, in_q, out_q, languages: list[str]) -> None:
    from app.engines.tts.mms_tts_engine import MMSTTSEngine
    from app.engines.tts.piper_engine import PiperEngine
    from app.engines.tts.piper_voices import ensure_voice
    from app.registry.language_registry import registry

    log_ = logging.getLogger("tts_worker")
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    engines = {"piper": PiperEngine(), "mms": MMSTTSEngine()}

    async def load_one(lang: str) -> None:
        entry = registry.get(lang)
        if entry is None or not entry.tts_supported or entry.tts_engine not in engines:
            raise RuntimeError(f"no worker-capable TTS route for {lang}")
        if entry.tts_engine == "piper":
            await asyncio.get_event_loop().run_in_executor(None, ensure_voice, entry.voice_id)
        await engines[entry.tts_engine].load(lang)
        try:  # warm-up (builds CUDA kernels / plans); harmless if it fails
            await engines[entry.tts_engine].synthesize("1 2 3", lang)
        except Exception:  # noqa: BLE001
            pass

    failed: dict[str, str] = {}
    total = len(languages)
    for done, lang in enumerate(languages, start=1):
        try:
            loop.run_until_complete(load_one(lang))
        except Exception as e:  # noqa: BLE001
            log_.warning("preload failed for %s: %s", lang, e)
            failed[lang] = f"{type(e).__name__}: {e}"[:200]
        out_q.put(("progress", idx, done, total, dict(failed)))
    out_q.put(("ready", idx, engines["piper"].info().get("voices", {})))
    _report_mem(out_q, idx)
    log_.info("worker %d ready: %d languages, %d failed", idx, total, len(failed))

    jobs_done = 0
    while True:
        msg = in_q.get()
        if msg is None or msg[0] == "stop":
            break
        _kind, job_id, lang, text = msg
        jobs_done += 1
        if jobs_done % 20 == 0:
            _trim_gpu_cache()
        if jobs_done % 200 == 0:
            _report_mem(out_q, idx)
        try:
            entry = registry.get(lang)
            if entry is None or entry.tts_engine not in engines:
                raise RuntimeError(f"no worker-capable TTS route for {lang}")
            clip = loop.run_until_complete(engines[entry.tts_engine].synthesize(text, lang))
            out_q.put(("result", job_id, True, clip.audio, clip.sample_rate, entry.tts_engine, None))
        except Exception as e:  # noqa: BLE001 -- one bad clip must not stop the worker
            out_q.put(("result", job_id, False, None, None, None, f"{type(e).__name__}: {e}"[:300]))


# ── Parent side ─────────────────────────────────────────────────────────────
class TTSWorkerPool:
    def __init__(self, n: int, languages: list[str]):
        self.n = n
        self.languages = list(languages)
        self.assignment = assign_workers(self.languages, n, default_cost)
        self._ctx = multiprocessing.get_context("spawn")  # CUDA cannot be used after fork
        self._procs: list = [None] * n
        self._in_qs: list = [None] * n
        self._out_qs: list = [None] * n
        self._gen = [0] * n
        self._pending: dict[int, tuple[asyncio.Future, int]] = {}
        self._job_ids = itertools.count(1)
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._stopping = False
        self._state = [
            {"total": len(self._shard(i)), "done": 0, "ready": len(self._shard(i)) == 0, "failed": {},
             "piper_voices": {}, "restarts": 0, "fatal": None}
            for i in range(n)
        ]

    def _shard(self, i: int) -> list[str]:
        return [lang for lang in self.languages if self.assignment[lang] == i]

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        for i in range(self.n):
            self._spawn(i)
        loop.create_task(self._monitor())
        log.info("started %d TTS worker processes for %d languages", self.n, len(self.languages))

    def _spawn(self, i: int) -> None:
        in_q, out_q = self._ctx.Queue(), self._ctx.Queue()
        proc = self._ctx.Process(
            target=worker_main, args=(i, in_q, out_q, self._shard(i)), daemon=True, name=f"tts-worker-{i}"
        )
        proc.start()
        with self._lock:
            self._gen[i] += 1
            gen = self._gen[i]
            self._procs[i], self._in_qs[i], self._out_qs[i] = proc, in_q, out_q
        threading.Thread(target=self._reader, args=(i, gen, out_q), daemon=True, name=f"tts-reader-{i}").start()

    def _reader(self, i: int, gen: int, out_q) -> None:
        while True:
            try:
                msg = out_q.get()
            except (EOFError, OSError):
                return
            if msg is None or self._gen[i] != gen:
                return  # sentinel, or this worker was replaced
            self._handle(i, msg)

    def _handle(self, i: int, msg: tuple) -> None:
        kind = msg[0]
        if kind == "progress":
            _, _, done, total, failed = msg
            st = self._state[i]
            st.update(done=done, total=total, failed=failed)
        elif kind == "ready":
            st = self._state[i]
            st.update(ready=True, piper_voices=msg[2])
        elif kind == "mem":
            self._state[i]["mem"] = msg[2]
        elif kind == "fatal":
            self._state[i]["fatal"] = msg[2]
            log.error("TTS worker %d died: %s", i, msg[2])
        elif kind == "result":
            _, job_id, ok, audio, sample_rate, engine, err = msg
            with self._lock:
                entry = self._pending.pop(job_id, None)
            if entry is not None and self._loop is not None:
                fut = entry[0]
                self._loop.call_soon_threadsafe(
                    lambda f=fut, r=(ok, audio, sample_rate, engine, err): (f.done() or f.set_result(r))
                )

    async def synthesize(self, lang: str, text: str, timeout: float = 30.0) -> tuple[SynthesizedClip, str]:
        i = worker_index(lang, self.assignment, self.n)
        proc = self._procs[i]
        if proc is None or not proc.is_alive():
            raise UnsupportedLanguageError(f"TTS worker {i} is not running")
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        job_id = next(self._job_ids)
        with self._lock:
            self._pending[job_id] = (fut, i)
        self._in_qs[i].put(("synth", job_id, lang, text))
        try:
            ok, audio, sample_rate, engine, err = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            with self._lock:
                self._pending.pop(job_id, None)
            raise UnsupportedLanguageError(f"TTS worker {i} timed out after {timeout:.0f}s for {lang}")
        if not ok:
            raise UnsupportedLanguageError(err or "TTS worker failed")
        return SynthesizedClip(audio=audio, sample_rate=sample_rate), engine

    async def _monitor(self) -> None:
        """Restart a worker that died; its languages reload (and fail meanwhile)."""
        while not self._stopping:
            await asyncio.sleep(3)
            for i in range(self.n):
                proc = self._procs[i]
                if proc is not None and not proc.is_alive() and not self._stopping:
                    log.error("TTS worker %d exited (code %s); restarting", i, proc.exitcode)
                    self._fail_pending(i, f"TTS worker {i} crashed")
                    try:
                        self._out_qs[i].put(None)  # unblock the old reader thread
                    except Exception:  # noqa: BLE001
                        pass
                    st = self._state[i]
                    st.update(done=0, ready=len(self._shard(i)) == 0, failed={}, restarts=st["restarts"] + 1)
                    self._spawn(i)

    def _fail_pending(self, i: int, reason: str) -> None:
        with self._lock:
            dead = [jid for jid, (_f, wi) in self._pending.items() if wi == i]
            futures = [self._pending.pop(jid)[0] for jid in dead]
        for fut in futures:
            if self._loop is not None:
                self._loop.call_soon_threadsafe(
                    lambda f=fut: (f.done() or f.set_result((False, None, None, None, reason)))
                )

    def stop(self) -> None:
        self._stopping = True
        for q in self._in_qs:
            try:
                q.put(None)
            except Exception:  # noqa: BLE001
                pass

    def status(self) -> dict:
        workers = []
        for i in range(self.n):
            proc = self._procs[i]
            st = self._state[i]
            workers.append({
                "index": i, "alive": bool(proc and proc.is_alive()), "languages": len(self._shard(i)),
                "done": st["done"], "total": st["total"], "ready": st["ready"], "failed": dict(st["failed"]),
                "restarts": st["restarts"], "fatal": st["fatal"], "torch_mem": st.get("mem"),
                "piper_on_cpu": sorted(v for v, p in st["piper_voices"].items() if "CUDAExecutionProvider" not in p),
            })
        return {"processes": self.n, "ready": all(w["ready"] for w in workers), "workers": workers}
