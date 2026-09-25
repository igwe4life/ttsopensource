#!/bin/sh
# Keeps the simple case simple: set STREAM_URL in .env and `docker compose up`
# just works, no separate JSON file to create. Advanced cases (--stream-config,
# --rtmp-targets) still work by mounting a file at the paths below.
set -e

ARGS=""

if [ -n "$STREAM_URL" ]; then
  ARGS="-i $STREAM_URL"
elif [ -f /srv/orchestrator/stream.json ]; then
  ARGS="--stream-config /srv/orchestrator/stream.json"
else
  echo "[entrypoint] ERROR: set STREAM_URL in .env, or mount a stream.json at /srv/orchestrator/stream.json" >&2
  exit 1
fi

if [ -f /srv/orchestrator/rtmp-targets.json ]; then
  ARGS="$ARGS --rtmp-targets /srv/orchestrator/rtmp-targets.json"
fi

echo "[entrypoint] node src/index.js $ARGS"
exec node src/index.js $ARGS
