#!/bin/sh
# Keeps the simple case simple: set STREAM_URL in .env and `docker compose up`
# just works.
set -e

if [ -z "$STREAM_URL" ]; then
  echo "[entrypoint] ERROR: set STREAM_URL in .env" >&2
  exit 1
fi

echo "[entrypoint] node src/index.js -i $STREAM_URL"
exec node src/index.js -i "$STREAM_URL"
