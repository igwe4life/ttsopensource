# Architecture

## Two processes, one contract

```
                         ┌─────────────────────────────┐
 Live HLS  ──ingest──▶   │        orchestrator         │   (Node — no GPU)
 source                  │  poll m3u8 → download .ts    │
                          │  extract 16kHz mono WAV      │
                          │  sharedPipelineManager        │
                          │  (which languages are active) │
                          └──────────────┬───────────────┘
                                         │  POST /process
                                         │  { audio, target_langs }
                          ┌──────────────▼───────────────┐
                          │        gpu-service            │  (Python/FastAPI — GPU)
                          │  Whisper/faster-whisper (ONE)  │
                          │       │                        │
                          │       ▼ transcript              │
                          │  ┌────┴────┬────────┬────────┐  │
                          │  NLLB→fr  NLLB→es  NLLB→ar  ... │
                          │  ┌────┴────┬────────┬────────┐  │
                          │  Piper/XTTS/MMS-TTS per language │
                          └──────────────┬───────────────┘
                                         │ { lang: {text, audio} }
                          ┌──────────────▼───────────────┐
                          │        orchestrator            │
                          │  mix over ducked original bed    │
                          │  remux (video copy + dub audio)  │
                          │  append to <lang>/playlist.m3u8   │
                          └──────────────┬───────────────┘
                                         │  static files
                          GET /hls/es/playlist.m3u8  ◀── N viewers, same files
```

`orchestrator` never imports a model library. `gpu-service` never touches
HLS/RTMP/ffmpeg-for-video. The only contract between them is the HTTP/JSON
`/process` API (plus `/transcribe`, `/translate`, `/tts`, `/health`,
`/models`, and `/ws/stream` for lower-latency streaming — see below). Either
side can be replaced, rewritten, or horizontally scaled independently.

## Why transcribe once, fan out (section 5)

`gpu-service/app/pipeline/process_pipeline.py` calls the STT engine exactly
once per segment, regardless of how many target languages are requested, then
runs `(translate -> synthesize)` concurrently per language with
`asyncio.gather`. This is the whole reason `/process` takes a *list* of
`target_langs` instead of one language per call — the orchestrator collects
the current active-language set from `sharedPipelineManager` and sends all of
them in a single request per segment.

## Two output modes: HLS (default) and RTMP (opt-in, `--rtmp-targets`)

The default output is per-language HLS files (below). If you already have an
RTMP-ingest CDN, `orchestrator/src/live/rtmpOutputManager.js` +
`rtmpPush.js` (the latter copied verbatim from the old engine — it's generic)
give each configured language its own persistent `ffmpeg` process pushing to
a fixed `rtmp://.../<stream_key>`, same "always-on, one process per language"
model the old engine used. A language with an RTMP target is pinned active
in `sharedPipelineManager` for the whole run rather than waiting for a
viewer's `/select` call. Because raw MPEG-TS bytes fed into one ffmpeg's
stdin (unlike standalone HLS segment files) DO need continuous timestamps
across segment boundaries, `rtmpOutputManager.js` tracks a running
`tsOffset` per RTMP-targeted language and `segmentQueue.js` remuxes that
language's segment a second time with that offset before writing it to the
pusher — the HLS copy of the same segment stays offset-free. See
`README.md`'s "Pushing to RTMP servers" section for usage.

## Why "one pipeline per language," not "one pipeline per viewer" (section 5)

`orchestrator/src/live/sharedPipelineManager.js` ref-counts *language*
subscriptions, not viewer connections. A language is "active" (included in
the next segment's `target_langs`) iff at least one viewer currently wants
it. Because the output is plain HLS files
(`hlsPlaylistWriter.js`), N viewers of the same language read the exact same
`playlist.m3u8` + `.ts` files over ordinary HTTP — there is nothing
per-viewer to spin up or tear down. This is a much simpler dedup story than
the old ttsengine's RTMP push (one persistent connection per stream), and
falls out almost for free from choosing HLS as the output format.

## Why HTTP `/process` by default, not the WebSocket, for v1

`gpu-service` exposes `/ws/stream` (see `app/ws/stream_ws.py`) for genuinely
low-latency, connection-reused streaming. The orchestrator's default path
(`gpuClient.js`) uses one HTTP request per segment instead. With
`HLS_SEGMENT_SECONDS` around 6s and inference taking low-single-digit seconds,
HTTP request/response overhead (tens of milliseconds) is negligible relative
to the segment interval — so v1 takes the simpler, more debuggable path
(plain request/response, easy to curl, easy to load-balance across a pool of
GPU workers in `gpuClient.js`). Switching the orchestrator to use `/ws/stream`
instead is a contained change (new `wsGpuClient.js` implementing the same
shape `segmentPipeline.js` expects) if per-segment connection setup ever
becomes the bottleneck — see docs/ROADMAP_500_1000_LANGUAGES.md.

## Known v1 simplification: whole-segment TTS, not phrase-level alignment

The old ttsengine synthesized ONE clip per recognized phrase and aligned each
to its own timestamp window (`stages/alignAudio.js` in the old repo). This
open-source rebuild's `/process` synthesizes ONE clip for the WHOLE segment's
translated text (`gpu-service/app/pipeline/process_pipeline.py` joins all
transcript segments before calling TTS), and the orchestrator's
`alignAudio.js` stretches/trims that single clip to the segment's duration —
looser sync than phrase-level alignment, but a much simpler, more batchable
GPU-service API (one TTS call per language per segment instead of one call
per phrase per language per segment, which would multiply GPU load by the
average phrase count). Reintroducing phrase-level timing means having
`/process` return per-phrase clips with timestamps instead of one clip; the
orchestrator's `alignAudio.js`/`segmentPipeline.js` shapes were kept close to
the old per-phrase design specifically so that change stays localized.

## VRAM budget (rough, faster-whisper large-v3 + NLLB-600M + a few TTS models)

| Component | Approx. VRAM |
|---|---|
| faster-whisper large-v3 (float16) | ~3 GB |
| NLLB-200-distilled-600M | ~2.5 GB |
| XTTS v2 (if loaded) | ~2 GB |
| MMS-TTS per loaded checkpoint | ~0.3-0.5 GB each |
| Marian/OPUS-MT per loaded pair | ~0.3 GB each |

A 16GB GPU comfortably runs Whisper + NLLB + a handful of MMS/Marian entries
from the pool (`MAX_LOADED_TTS_MODELS`, `MAX_LOADED_TRANSLATION_MODELS` in
`gpu-service/.env.example`) at once. Scale up (24GB+) or split across multiple
GPU workers (via `orchestrator`'s `GPU_SERVICE_POOL` round-robin) as the
number of *simultaneously active* languages grows — not as the *registry
size* grows, since inactive languages cost nothing (section 7's whole point).

## Engine abstraction (section 2)

`gpu-service/app/engines/base.py` defines three ABCs —
`SpeechToTextEngine`, `TranslationEngine`, `TextToSpeechEngine` — with
`load/unload/is_loaded/supports*` plus the actual inference call. Concrete
engines:

| Abstract | Concrete | File |
|---|---|---|
| SpeechToTextEngine | `WhisperEngine`, `FasterWhisperEngine` | `engines/stt/` |
| TranslationEngine | `NLLBEngine`, `MarianEngine`, `OPUSEngine` (subclass of Marian) | `engines/translation/` |
| TextToSpeechEngine | `PiperEngine`, `XTTSEngine`, `MMSTTSEngine` | `engines/tts/` |

`app/routing/model_router.py` is the ONLY place that imports these concrete
classes and decides which one handles a given language + fallback order.
Nothing in `app/main.py` or `app/pipeline/` references a concrete engine —
adding a fourth TTS engine means writing one new file plus one new line in
the router's `_TTS_ENGINES` map, not touching call sites.

## Provider independence (section 3)

`gpu-service/config.py`'s `GPU_PROVIDER` setting is purely informational
(surfaced in `/health`); nothing branches on it. The same Docker image
(`gpu-service/Dockerfile`) deploys to RunPod (`deploy/runpod/`), Hyperstack
(`deploy/hyperstack/`), or a bare CUDA box — only environment variables and
which compose/console flow you use differ. `orchestrator`'s `GPU_SERVICE_URL`
is the only thing that needs to change to point at a different provider.

## What's not implemented / needs real-world validation

This was built without GPU hardware or the ability to install
torch/transformers/faster-whisper in the sandbox it was written in — the
Python side is reviewed carefully but not executed end-to-end. Before relying
on it:

1. `pip install -r gpu-service/requirements.txt` on a real CUDA box and run
   `pytest gpu-service/tests/` (registry tests need no GPU) then a manual
   `/health` + `/process` call with a short WAV.
2. Run `node scripts/verify-models.js` (needs only Node + network — no GPU)
   before trusting any language's checkpoint claim; see
   docs/LANGUAGE_COVERAGE.md for what it already found.
3. Download real Piper voice `.onnx` files into `PIPER_VOICES_DIR` — the
   registry references voice IDs by name but does not ship the binaries.
