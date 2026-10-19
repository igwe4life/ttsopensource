# Orchestrator — no GPU required. Continuously captures the source HLS
# stream's audio, streams it to the GPU inference service over WebSocket,
# live-mixes each language's translated audio over the (ducked) original,
# and pushes one always-on RTMP stream per language. Video is passed through
# untouched (-c:v copy). Exposes only /health and /languages for monitoring.
#
# Runs on any small CPU host (RunPod CPU pod, a VM, a laptop). Everything
# is configured through env vars — see orchestrator/.env.example; secrets
# (stream keys, GPU API key) are injected at runtime, never baked in.
#
# BUILD CONTEXT MUST BE THE REPO ROOT (bundles language-registry/, same as
# gpu-service/Dockerfile):
#   docker build -f orchestrator/Dockerfile -t ttsopensource-orchestrator .
FROM node:20-bookworm-slim

# Links the GHCR package to this (public) repo so it inherits public
# visibility on first publish — RunPod then pulls it without credentials.
LABEL org.opencontainers.image.source="https://github.com/igwe4life/ttsopensource"

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/orchestrator

COPY orchestrator/package.json orchestrator/package-lock.json* ./
RUN npm install --omit=dev

COPY orchestrator/src ./src
COPY orchestrator/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
COPY language-registry /srv/language-registry

ENV LANGUAGE_REGISTRY_PATH=/srv/language-registry/languages.json \
    LANGUAGE_OVERRIDES_PATH=/srv/language-registry/overrides.json \
    HTTP_PORT=4000

EXPOSE 4000

# Set STREAM_URL (the source HLS URL) plus the GPU_SERVICE_* and RTMP_* vars.
# No persistent work directory: steady-state writes nothing to disk.
ENTRYPOINT ["./docker-entrypoint.sh"]
