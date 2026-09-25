# GPU inference service — same image deploys to RunPod, Hyperstack, or any
# CUDA-capable host (see deploy/runpod and deploy/hyperstack). Provider
# differences are env vars only, never a different image.
#
# BUILD CONTEXT MUST BE THE REPO ROOT (not gpu-service/), because this image
# also bundles language-registry/, the shared source of truth:
#   docker build -f gpu-service/Dockerfile -t ttsopensource-gpu-service .
# docker-compose.yml (repo root) is already wired up this way.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3-pip python3.11-venv \
        ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Piper TTS binary (self-contained, no Python deps) — see
# https://github.com/rhasspy/piper/releases. Release tags have NO "v" prefix
# (verified against the GitHub API before hardcoding this — a "v2023..." URL
# 404s). Pin a version explicitly for reproducible builds.
ARG PIPER_VERSION=2023.11.14-2
RUN curl -L -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
    && tar -xzf /tmp/piper.tar.gz -C /opt \
    && ln -s /opt/piper/piper /usr/local/bin/piper \
    && rm /tmp/piper.tar.gz

WORKDIR /srv/gpu-service

COPY gpu-service/requirements.txt .
# torch's default PyPI wheel is CUDA-enabled on Linux x86_64 for recent
# versions; pin an explicit --index-url here if you need a specific CUDA build.
RUN python3.11 -m pip install --upgrade pip \
    && python3.11 -m pip install -r requirements.txt

COPY gpu-service/app ./app
COPY gpu-service/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
# Language registry is the shared source of truth — bundle it into the image
# (or mount it read-only at runtime via LANGUAGE_REGISTRY_PATH).
COPY language-registry /srv/language-registry

ENV LANGUAGE_REGISTRY_PATH=/srv/language-registry/languages.json \
    LANGUAGE_OVERRIDES_PATH=/srv/language-registry/overrides.json \
    PIPER_VOICES_DIR=/srv/models/piper \
    DEVICE=cuda \
    PORT=8000

EXPOSE 8000

# STT/translation models (Whisper, NLLB) download on first boot via
# transformers/faster-whisper's own HF cache the first time they're loaded
# (app startup — see app/routing/model_router.py's startup()); a small
# VERIFIED-real starter set of Piper voices downloads via the entrypoint
# below so TTS works out of the box for a few languages too. Mount a volume
# at /srv/models and /root/.cache/huggingface (see docker-compose.yml) so
# none of this re-downloads on every container restart.
ENTRYPOINT ["./docker-entrypoint.sh"]
