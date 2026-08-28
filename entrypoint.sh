#!/bin/sh
set -e

# Real ceiling found live: Docker's default open-file soft limit (1024)
# would cap this container at roughly a thousand concurrent connections
# TOTAL, well short of "thousands of simultaneous users" holding a live
# SSE connection each (nginx alone needs 2 FDs per SSE client -- one to
# the browser, one proxied through to the backend -- before the backend's
# own single process needs a third). Confirmed live that the HARD limit is
# already 524288, so a process can raise its own soft limit this high
# without any special privileges or Coolify-level config -- this is that
# raise, applied before either server starts so both inherit it.
ulimit -n 65536 2>/dev/null || true

# Exactly one uvicorn worker -- db.py's own module docstring explains why:
# the in-memory rate limiter, the read cache, and the SSE pub/sub in
# main.py/db.py all assume a single process. A second worker would
# silently break every one of them (rate limits reset per-worker, SSE
# subscribers split across workers never see every event, cached reads go
# stale differently per worker) without ever raising an error. Scaling
# this further means scaling the ONE process's own concurrency ceiling
# (this ulimit raise, the asyncpg pool size, the read cache below) rather
# than adding workers.
(cd /opt/loot-radar/backend && exec python -m uvicorn main:app --host 127.0.0.1 --port 8643) &
BACKEND_PID=$!

# Stop the backend if nginx exits so the container signals failure instead
# of limping along with a dead API behind a healthy-looking proxy.
trap 'kill "$BACKEND_PID" 2>/dev/null || true' EXIT

nginx -g 'daemon off;'
