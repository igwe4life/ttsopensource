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

## License / models

This project's own code is [MIT licensed](LICENSE) (matches the old
`ttsengine`). The AI models it wires up (Whisper, NLLB-200, OPUS-MT/MarianMT,
Piper, Coqui XTTS, MMS) each carry their own licenses — check each before
commercial deployment, particularly XTTS v2 (Coqui Public Model License —
non-commercial without a separate agreement as of this writing) and confirm
current terms yourself before shipping.
