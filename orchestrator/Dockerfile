# Orchestrator — no GPU required. Ingests the source HLS stream, calls the
# GPU inference service over HTTP, writes per-language output HLS, serves the
# viewer-facing HTTP API.
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
VOLUME ["/srv/orchestrator/work"]

# Simple case: set STREAM_URL in .env, nothing else to mount — see
# docker-entrypoint.sh. Advanced cases (--stream-config / --rtmp-targets)
# work by bind-mounting a file at /srv/orchestrator/stream.json or
# /srv/orchestrator/rtmp-targets.json (see docker-compose.yml).
ENTRYPOINT ["./docker-entrypoint.sh"]
