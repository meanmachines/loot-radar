#!/bin/sh
set -e

# Exactly one uvicorn worker -- db.py's own module docstring explains why:
# the in-memory rate limiter and the SSE pub/sub in main.py both assume a
# single process. A second worker would silently break both (rate limits
# reset per-worker, SSE subscribers split across workers never see every
# event) without ever raising an error.
(cd /opt/loot-radar/backend && exec python -m uvicorn main:app --host 127.0.0.1 --port 8643) &
BACKEND_PID=$!

# Stop the backend if nginx exits so the container signals failure instead
# of limping along with a dead API behind a healthy-looking proxy.
trap 'kill "$BACKEND_PID" 2>/dev/null || true' EXIT

nginx -g 'daemon off;'
