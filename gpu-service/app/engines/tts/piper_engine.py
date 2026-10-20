"""
Piper — fast, CPU-friendly, high-quality neural TTS with curated per-language
voices (rhasspy/piper-voices). Preferred TTS engine wherever a voice exists
(see language-registry: PIPER_VOICES table).

Uses Piper's own Python package (`piper-tts`, the piper1-gpl project) to
load each voice's ONNX model ONCE and keep it resident in memory for every
subsequent synthesize() call. This replaces an earlier version that shelled
out to a standalone `piper` CLI binary as a **fresh subprocess per call**
(full process spawn + model reload every single time) — found via live
testing to saturate CPU with only 3 languages running continuously, since
the process-spawn-and-reload overhead dominated actual synthesis cost.
onnxruntime sessions are safe to call concurrently from multiple threads,
so the same loaded voice can serve overlapping requests.
"""
from __future__ import annotations

import asyncio
import io
import logging
import threading
import wave
from pathlib import Path
from typing import Optional

# torch first: importing it preloads the CUDA/cuDNN shared libs from its own
# pip wheels, which onnxruntime-gpu then finds (the documented workaround for
# ORT not locating cuDNN on its own). Harmless on a CPU-only install.
try:
    import torch  # noqa: F401
except ImportError:
    pass

from piper import PiperVoice

from app.config import settings
from app.engines.base import EngineLoadError, SynthesizedClip, TextToSpeechEngine, UnsupportedLanguageError
from app.engines.tts.executor import tts_executor
from app.engines.tts.piper_voices import ensure_voice
from app.registry.language_registry import registry


log = logging.getLogger("piper")


def _preload_cuda_libs() -> None:
    """onnxruntime-gpu 1.20 has no preload_dlls(): it dlopen()s libcudnn.so.9 /
    libcublas.so.12 by soname and, when they are not on the loader path, quietly
    retries on CPU. torch's pip wheels ship those libs under site-packages/nvidia/*/lib
    but do not put them on the path, so load them RTLD_GLOBAL up front."""
    import ctypes
    import glob
    import site
    import sys

    roots = list(site.getsitepackages()) + [p for p in sys.path if p.endswith("site-packages")]
    # Dependency order: runtime -> cublas -> the rest -> cudnn last.
    wanted = ["libcudart.so.12", "libcublasLt.so.12", "libcublas.so.12", "libcufft.so.11",
              "libcurand.so.10", "libnvJitLink.so.12", "libcudnn_*.so.9", "libcudnn.so.9"]
    for name in wanted:
        for root in dict.fromkeys(roots):
            hits = sorted(glob.glob(f"{root}/nvidia/*/lib/{name}"))
            if hits:
                # cuDNN 9 is split into libcudnn_{adv,cnn,graph,ops,...}.so.9; the CUDA
                # provider needs them by soname, so every match gets loaded.
                for hit in hits:
                    try:
                        ctypes.CDLL(hit, mode=ctypes.RTLD_GLOBAL)
                    except OSError as e:
                        log.warning("could not preload %s: %s", hit, e)
                break


if settings.piper_use_cuda:
    try:
        _preload_cuda_libs()
    except Exception:  # noqa: BLE001 -- best effort; the CPU fallback still works
        log.warning("CUDA lib preload failed", exc_info=True)


class PiperEngine(TextToSpeechEngine):
    name = "piper"

    def __init__(self):
        self._voices_dir = Path(settings.piper_voices_dir)
        self._voices: dict[str, PiperVoice] = {}  # voice_id -> resident, loaded voice
        self._providers: dict[str, list[str]] = {}  # voice_id -> ORT providers actually in use
        self._cuda_diag: Optional[dict] = None
        self._lock = asyncio.Lock()

    def supports(self, language_code: str) -> bool:
        entry = registry.get(language_code)
        return bool(entry and entry.tts_engine == "piper")

    def _voice_path(self, voice_id: str) -> Path:
        return self._voices_dir / f"{voice_id}.onnx"

    def is_loaded(self, language_code: str, voice_id: Optional[str] = None) -> bool:
        vid = voice_id or (registry.get(language_code).voice_id if registry.get(language_code) else None)
        return bool(vid and vid in self._voices)

    async def load(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        if not vid:
            raise UnsupportedLanguageError(f"No Piper voice configured for {language_code}")
        async with self._lock:
            if vid in self._voices:
                return
            path = self._voice_path(vid)
            if not path.exists():
                # Not pre-fetched by the entrypoint: pull it from HuggingFace now.
                try:
                    await asyncio.get_event_loop().run_in_executor(None, ensure_voice, vid)
                except Exception as e:  # noqa: BLE001
                    log.warning("could not download Piper voice %s: %s", vid, e)
            if not path.exists():
                raise EngineLoadError(
                    f"Piper voice file missing: {path}. Download it from "
                    f"huggingface.co/rhasspy/piper-voices into {self._voices_dir}."
                )
            # PiperVoice.load() creates a real onnxruntime InferenceSession —
            # synchronous and CPU-bound (brief, but still worth keeping off
            # the event loop, same as the other engines' model loads).
            loop = asyncio.get_event_loop()
            try:
                voice, providers = await loop.run_in_executor(None, _load_voice, str(path))
            except Exception as e:  # noqa: BLE001 — e.g. missing/corrupt voice.onnx.json
                raise EngineLoadError(f"Piper failed to load voice {vid}: {e}") from e
            self._voices[vid] = voice
            self._providers[vid] = providers
            log.info("Piper voice %s loaded, providers=%s", vid, providers)

    async def unload(self, language_code: str, voice_id: Optional[str] = None) -> None:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        self._voices.pop(vid, None)
        self._providers.pop(vid, None)

    def info(self) -> dict:
        """Surfaced in /health so the GPU-vs-CPU outcome is verifiable remotely."""
        out = {
            "use_cuda_requested": settings.piper_use_cuda,
            "voices": {vid: prov for vid, prov in self._providers.items()},
        }
        # If a voice ended up on CPU although CUDA was requested, explain why
        # (pod logs are not reachable on RunPod, so this is the only window).
        if settings.piper_use_cuda and any("CUDAExecutionProvider" not in p for p in self._providers.values()):
            if self._cuda_diag is None:
                self._cuda_diag = _diagnose_cuda(self._voices_dir)
            out["cuda_diagnosis"] = self._cuda_diag
        return out

    async def synthesize(
        self, text: str, language_code: str, voice_id: Optional[str] = None
    ) -> SynthesizedClip:
        entry = registry.get(language_code)
        vid = voice_id or (entry.voice_id if entry else None)
        if not vid:
            raise UnsupportedLanguageError(f"No Piper voice configured for {language_code}")
        if vid not in self._voices:
            await self.load(language_code, vid)

        voice = self._voices[vid]
        loop = asyncio.get_event_loop()
        wav_bytes = await loop.run_in_executor(tts_executor, _synthesize_wav_bytes, voice, text)
        return SynthesizedClip(audio=wav_bytes, sample_rate=voice.config.sample_rate)


def _load_voice(path: str):
    """Runs on a worker thread. Tries CUDA when requested and falls back to
    CPU if the CUDA execution provider can't be created, so a missing or
    mismatched onnxruntime-gpu degrades to the old behavior instead of
    losing the voice."""
    # Load on CPU first (cheap, version-agnostic), then swap in our own CUDA
    # session: PiperVoice.load(use_cuda=True) builds one with onnxruntime's
    # default arena, which grows by doubling per session and ran a 24 GB card
    # out of memory with ~50 resident voices.
    voice = PiperVoice.load(path, use_cuda=False)
    if settings.piper_use_cuda:
        try:
            voice.session = _cuda_session(path)
        except Exception:  # noqa: BLE001
            log.warning("Piper CUDA session failed for %s, staying on CPU", path, exc_info=True)
    return voice, _providers_of(voice)


def _cuda_session(path: str):
    import onnxruntime as ort

    options = {
        "cudnn_conv_algo_search": "HEURISTIC",
        "arena_extend_strategy": "kSameAsRequested",
        "gpu_mem_limit": int(settings.piper_gpu_mem_mb) * 1024 * 1024,
    }
    return ort.InferenceSession(
        path,
        sess_options=ort.SessionOptions(),
        providers=[("CUDAExecutionProvider", options), "CPUExecutionProvider"],
    )


def _diagnose_cuda(voices_dir: Path) -> dict:
    """Why isn't the CUDA execution provider being used? Reports the installed
    onnxruntime build, what it claims to offer, and the real error from trying
    to open a session with CUDA only."""
    import warnings

    diag: dict = {}
    try:
        import onnxruntime as ort

        diag["ort_version"] = ort.__version__
        diag["ort_file"] = getattr(ort, "__file__", None)
        diag["ort_device"] = ort.get_device()
        diag["available_providers"] = ort.get_available_providers()
        voice = next(iter(sorted(voices_dir.glob("*.onnx"))), None)
        if voice is not None:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                try:
                    sess = ort.InferenceSession(str(voice), providers=["CUDAExecutionProvider"])
                    diag["probe_providers"] = sess.get_providers()
                except Exception as e:  # noqa: BLE001
                    diag["probe_error"] = f"{type(e).__name__}: {e}"[:600]
            if caught:
                diag["probe_warnings"] = [str(w.message)[:300] for w in caught][:3]
        # Direct dlopen of the CUDA provider library names the missing .so.
        import ctypes
        from pathlib import Path as _P

        lib = _P(ort.__file__).parent / "capi" / "libonnxruntime_providers_cuda.so"
        diag["cuda_provider_lib_exists"] = lib.exists()
        if lib.exists():
            try:
                ctypes.CDLL(str(lib))
                diag["cuda_provider_dlopen"] = "ok"
            except OSError as e:
                diag["cuda_provider_dlopen"] = str(e)[:300]
    except Exception as e:  # noqa: BLE001
        diag["diagnosis_error"] = f"{type(e).__name__}: {e}"[:300]
    return diag


def _providers_of(voice) -> list[str]:
    try:
        return list(voice.session.get_providers())
    except Exception:  # noqa: BLE001 -- attribute layout differs across piper versions
        return ["unknown"]


# Piper synthesis is NOT safe to run from several threads at once: live tests showed
# 8 parallel requests to one voice failing 6 times with "# channels not specified"
# (the voice yielded zero audio chunks), and ~60% of Piper languages failing when a
# 50-language chunk synthesized them concurrently — while each voice worked alone.
# One clip is only tens of milliseconds on the GPU, so serializing costs little; MMS
# (a separate engine) stays parallel.
_PIPER_LOCK = threading.Lock()


def _synthesize_wav_bytes(voice: "PiperVoice", text: str) -> bytes:
    """Runs on a worker thread — onnxruntime inference is synchronous/blocking."""
    with _PIPER_LOCK:
        buf = io.BytesIO()
        try:
            with wave.open(buf, "wb") as wav_file:
                voice.synthesize_wav(text, wav_file)
        except wave.Error as e:
            # The voice produced no audio at all. Say whether the phonemizer was the
            # reason, since pod logs are unreachable.
            try:
                lengths = [len(sent) for sent in voice.phonemize(text)]
            except Exception as pe:  # noqa: BLE001
                lengths = f"phonemize raised {type(pe).__name__}: {pe}"
            raise RuntimeError(f"no audio produced ({e}); phoneme sentence lengths={lengths}") from e
        return buf.getvalue()
