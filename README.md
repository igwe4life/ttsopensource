# ttsopensource

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/igwe4life/ttsopensource/actions/workflows/ci.yml/badge.svg)](https://github.com/igwe4life/ttsopensource/actions/workflows/ci.yml)
[![Docker Build](https://github.com/igwe4life/ttsopensource/actions/workflows/docker.yml/badge.svg)](https://github.com/igwe4life/ttsopensource/actions/workflows/docker.yml)
[![Languages](https://img.shields.io/badge/languages-106-blue.svg)](language-registry/languages.json)

> The CI/Docker badges link to this **private** repo's Actions tab — they'll
> only render for people with repo access (that's a GitHub limitation for
> private repos, not a bug). The languages badge is a static snapshot of
> `language-registry/languages.json`'s `total_languages` — see
> [docs/LANGUAGE_COVERAGE.md](docs/LANGUAGE_COVERAGE.md) for the live
> breakdown by status.

Open-source, GPU-powered, real-time multilingual HLS video translation and
dubbing. Same shape of problem as the sibling `ttsengine` project
(`C:\apps\mobile\nodejs\ttsengine`), but built entirely on self-hostable
models instead of Azure — this is a separate, independent codebase; nothing
here imports from or modifies that project.

```
Live HLS Video
      ↓
FFmpeg audio extraction + VAD-based segmentation      (orchestrator, Node)
      ↓
Whisper / faster-whisper                              (gpu-service, Python/GPU)
      ↓
NLLB-200 / OPUS-MT / MarianMT translation                    "
      ↓
Piper / Coqui XTTS / MMS-TTS                                  "
      ↓
Mix + remux + per-language HLS output                 (orchestrator)
```

## Two independently-deployable pieces

| Directory | Runtime | Job |
|---|---|---|
| [`gpu-service/`](gpu-service/) | Python, FastAPI, GPU | STT/translation/TTS behind `SpeechToTextEngine` / `TranslationEngine` / `TextToSpeechEngine` abstractions. Deploys to RunPod, Hyperstack, or any CUDA box — see `deploy/`. |
| [`orchestrator/`](orchestrator/) | Node.js, no GPU needed | Polls the source HLS stream, calls `gpu-service` over HTTP once per segment for whichever languages have active viewers, writes per-language output HLS. Reuses several files verbatim/adapted from the old `ttsengine` (ffmpeg helpers, HLS polling, remux) — see the "Reused from ttsengine" comments at the top of each. |
| [`language-registry/`](language-registry/) | data | The single source of truth both services read — see its README for why it's generated (`scripts/build-registry.js`), not hand-written. |

Full design rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Language coverage specifics and a real verification finding:
[docs/LANGUAGE_COVERAGE.md](docs/LANGUAGE_COVERAGE.md). Path to 500-1000+
languages: [docs/ROADMAP_500_1000_LANGUAGES.md](docs/ROADMAP_500_1000_LANGUAGES.md).

## Quickstart — Docker (recommended, works with or without a GPU)

Three steps, one file to edit:

```bash
cp .env.example .env       # set STREAM_URL to your live HLS source
docker compose up --build  # CPU by default — works on any machine, just slow
```

Got an NVIDIA GPU (with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed)? Layer on the GPU overlay instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

That's it. Two containers come up:
- `gpu-service` downloads Whisper + NLLB (a few GB — first boot takes a
  while, watch `docker compose logs -f gpu-service`) plus four verified
  starter Piper voices (English/Spanish/French/German) automatically.
- `orchestrator` starts polling `STREAM_URL` and exposes the viewer API on
  `:4000` (`gpu-service`'s API is also on `:8000` if you want to call it
  directly).

Then pick a language and play it:
```bash
curl http://localhost:4000/languages                 # what's available, per language
curl -X POST http://localhost:4000/select -d '{"lang":"es"}' -H 'Content-Type: application/json'
# -> { "hls_url": "/hls/es/playlist.m3u8" } — open that URL in any HLS player (e.g. VLC, hls.js)
```

Everything else in `.env.example` (ports, API key, RTMP server default) has a
sane default — only `STREAM_URL` is required. Models persist in Docker
volumes (`hf-cache`, `./gpu-service/models`), so a `docker compose restart`
doesn't re-download anything.

### Pushing to RTMP instead of (or as well as) HLS

If you have an existing RTMP-ingest CDN and want continuous, always-on
dubbed RTMP streams rather than viewer-driven HLS:

```bash
cp rtmp-targets.json.example rtmp-targets.json   # edit language/stream_key/rtmp_server
```
Then uncomment the `rtmp-targets.json` volume line in `docker-compose.yml`
and `docker compose up --build` again. Each entry gets its own persistent
`ffmpeg` process pushing to `<rtmp_server>/<stream_key>` for the whole run —
it does **not** wait for a viewer to `/select` it, matching the old engine's
"always dubbing" model. It still also produces that language's HLS output for
free. Check `GET /health` for `rtmp_targets: [{ lang, rtmp_url, alive }]`.

## Quickstart — without Docker (local dev, more moving parts)

```bash
node scripts/build-registry.js               # regenerate the language registry
node scripts/verify-models.js --write-overrides  # (recommended) sanity-check model claims

cd gpu-service && pip install -r requirements.txt && cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000   # needs a CUDA GPU + Piper binary on PATH

# separate terminal, no GPU needed:
cd orchestrator && npm install && cp .env.example .env
node src/index.js -i https://example.com/live/stream.m3u8
# or: node src/index.js -i <url> --rtmp-targets rtmp-targets.json
```

## What's been verified vs. what hasn't

This was built and reviewed carefully, and the parts that don't need a GPU
were actually run and checked in the process:

- ✅ `scripts/build-registry.js` runs, produces 106 languages with
  independently-computed STT/translation/TTS support flags.
- ✅ `scripts/verify-models.js` was run for real against HuggingFace — see
  docs/LANGUAGE_COVERAGE.md for what it found (including a rate-limiting bug
  it caught and fixed in itself before being trusted).
- ✅ `orchestrator`'s config/registry loading, HTTP API (`/languages`,
  `/select`, `/unselect`, `/health`), and source-unreachable retry behavior
  were exercised against a live local server and a dummy/unreachable source
  (a real bug — the whole process crashing when the source was momentarily
  unreachable — was found and fixed this way).
- ✅ `--rtmp-targets` was run end-to-end (label resolution, pinning languages
  active, building `<rtmp_server>/<stream_key>` URLs, `/health` reporting).
  `ffmpeg` itself isn't installed in the environment this was built in, so
  the actual RTMP push (spawning `ffmpeg`, connecting, reconnect-on-drop) is
  the SAME code as the old `ttsengine`'s already-proven `rtmpPush.js` (copied
  verbatim), not newly-written/untested logic — but confirm it on a box with
  `ffmpeg` on `PATH` before relying on it.
- ✅ Both Docker entrypoints were dry-run tested (argument branching logic)
  and both compose files pass YAML lint. The Piper binary's GitHub release
  URL baked into `gpu-service/Dockerfile` was wrong on the first pass (a
  `v` prefix that isn't in the real tag) — caught by actually curling it,
  not assumed. The starter-voice download in `gpu-service/docker-entrypoint.sh`
  was **actually executed** (not just URL-checked) — a real 63MB
  `en_US-lessac-medium.onnx` + its config JSON downloaded successfully. A
  `set -e` bug that would have crash-looped the whole GPU service on a
  transient network blip during startup was found and fixed the same way.
  A real CI run (`.github/workflows/docker.yml`, the "Docker Build" badge
  above) then actually built both images: `orchestrator` built clean;
  `gpu-service` initially failed with `OSError: [Errno 28] No space left on
  device` partway through `pip install` — torch pulls in the full CUDA
  toolkit as pip dependencies (several GB of `nvidia-*` wheels), which
  overflowed the GitHub-hosted runner's default free disk. Fixed by freeing
  preinstalled toolchains (.NET, Android SDK, GHC) the job never uses before
  building — not a Dockerfile bug, but a real constraint worth knowing if you
  build this image in another disk-constrained CI environment. Full `docker
  compose up` (container networking, healthcheck, actually running the
  containers) still hasn't been exercised — that's the remaining
  Docker-specific thing to confirm on a real machine.
- ⚠️ `gpu-service` (Python/FastAPI/torch/transformers/faster-whisper/
  coqui-tts) was written and reviewed carefully but **could not be executed**
  in the environment this was built in (no GPU, no Python interpreter beyond
  a Windows Store stub, no ability to install torch/transformers). Before
  relying on it: `pip install -r gpu-service/requirements.txt` on a real
  machine, run `pytest gpu-service/tests/` (no GPU needed for those), then a
  manual `/health` and `/process` call.
- ⚠️ The full live orchestrator↔gpu-service segment pipeline (extract audio →
  `/process` → mix → remux → HLS append) has not been run end-to-end against
  a real live stream — it was built by careful adaptation of the old
  ttsengine's already-proven ffmpeg/HLS logic, but say so plainly rather than
  claim it's been tested live.

## License / models

This project's own code is [MIT licensed](LICENSE) (matches the old
`ttsengine`). The AI models it wires up (Whisper, NLLB-200, OPUS-MT/MarianMT,
Piper, Coqui XTTS, MMS) each carry their own licenses — check each before
commercial deployment, particularly XTTS v2 (Coqui Public Model License —
non-commercial without a separate agreement as of this writing) and confirm
current terms yourself before shipping.
