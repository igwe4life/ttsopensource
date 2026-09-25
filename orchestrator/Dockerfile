# Orchestrator — no GPU required. Continuously captures the source HLS
# stream's audio, streams it to the GPU inference service over WebSocket, and
# serves the viewer page + live per-language audio over its own WebSocket.
# Video is never touched here — the browser's hls.js pulls it directly from
# the source URL (see src/public/index.html).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (bundles language-registry/, same as
# gpu-service/Dockerfile):
#   docker build -f orchestrator/Dockerfile -t ttsopensource-orchestrator .
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
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

# Nothing to mount — set STREAM_URL in .env, that's it (see
# docker-entrypoint.sh). No persistent work directory: steady-state writes
# nothing to disk.
ENTRYPOINT ["./docker-entrypoint.sh"]
