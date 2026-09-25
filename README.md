# ttsopensource

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/igwe4life/ttsopensource/actions/workflows/ci.yml/badge.svg)](https://github.com/igwe4life/ttsopensource/actions/workflows/ci.yml)
[![Docker Build](https://github.com/igwe4life/ttsopensource/actions/workflows/docker.yml/badge.svg)](https://github.com/igwe4life/ttsopensource/actions/workflows/docker.yml)
[![Languages](https://img.shields.io/badge/languages-106-blue.svg)](language-registry/languages.json)

> The languages badge is a static snapshot of
> `language-registry/languages.json`'s `total_languages`.

See `docs/` for design notes.

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
- `orchestrator` continuously captures `STREAM_URL`'s audio and streams it to
  `gpu-service` for live transcription/translation/TTS.

Open **http://localhost:4000/** in a browser — the video plays directly from
your source, and a language picker lets you switch the live translated audio
track on the fly (English pivot → 10 target languages by default; see
`TARGET_LANGUAGES` in `.env.example`). Only languages someone is actually
listening to consume GPU time — picking a language subscribes you to a
shared live stream of that language, not a fresh one per viewer.

Everything else in `.env.example` (ports, API key, chunking) has a sane
default — only `STREAM_URL` is required. Models persist in Docker volumes
(`hf-cache`, `./gpu-service/models`), so a `docker compose restart` doesn't
re-download anything. There's no on-disk output at all in steady state —
audio is captured, translated, and pushed to listening viewers continuously,
nothing is buffered to files.

## Quickstart — without Docker (local dev, more moving parts)

```bash
node scripts/build-registry.js               # regenerate the language registry
node scripts/verify-models.js --write-overrides  # (recommended) sanity-check model claims

cd gpu-service && pip install -r requirements.txt && cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000   # needs a CUDA GPU + Piper binary on PATH

# separate terminal, no GPU needed:
cd orchestrator && npm install && cp .env.example .env
node src/index.js -i https://example.com/live/stream.m3u8
# then open http://localhost:4000/
```

## License / models

This project's own code is [MIT licensed](LICENSE) (matches the old
`ttsengine`). The AI models it wires up (Whisper, NLLB-200, OPUS-MT/MarianMT,
Piper, Coqui XTTS, MMS) each carry their own licenses — check each before
commercial deployment, particularly XTTS v2 (Coqui Public Model License —
non-commercial without a separate agreement as of this writing) and confirm
current terms yourself before shipping.
