"""loot-radar backend -- FastAPI app serving the crowd-sourced Gamescom
loot map API. See db.py's own module docstring for the single-process
assumption this whole app is built on (in-memory rate limiter + SSE
broadcaster live in this one process).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import db

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("loot-radar")

app = FastAPI(title="loot-radar")

BUILD_SHA = os.environ.get("GIT_SHA", "dev")
BUILD_TIME = os.environ.get("BUILD_TIME", "unknown")

_create_limiter = db.RateLimiter(max_per_window=20, window_seconds=3600)
_vote_limiter = db.RateLimiter(max_per_window=120, window_seconds=3600)

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _client_key(request: Request) -> str:
    # Coolify/Traefik terminate in front of this app -- the real client IP
    # arrives via X-Forwarded-For, not request.client.host (that would just
    # be the proxy). Falls back to request.client.host for local/dev runs.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _device_id(request: Request) -> str:
    device_id = request.headers.get("x-device-id", "")
    if not _DEVICE_ID_RE.match(device_id):
        raise HTTPException(400, "missing or malformed X-Device-Id header")
    return device_id


# ---------------------------------------------------------------------------
# Platform contract endpoints (see get_platform_contract's required_endpoints)
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    # Must NOT touch the database -- see get_platform_contract's own note on
    # why a slow query here can cascade into every app on the node getting
    # marked unhealthy at once.
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    if await db.db_ready():
        return {"status": "ready"}
    return JSONResponse({"status": "not ready"}, status_code=503)


@app.get("/version")
async def version():
    return {"sha": BUILD_SHA, "built": BUILD_TIME}


# ---------------------------------------------------------------------------
# SSE broadcast -- see db.py's module docstring for the single-process
# assumption this pub/sub relies on.
# ---------------------------------------------------------------------------

_subscribers: set[asyncio.Queue] = set()


async def _broadcast(event: str, data: dict) -> None:
    # default=str: defensive backstop, not the primary fix -- see db.py's
    # own comment on the real bug this guards against (a Postgres numeric
    # column reaching this plain json.dumps call as a non-serializable
    # Decimal). FastAPI's own response encoder tolerates that; stdlib
    # json.dumps does not, and this is the one path in the app that calls
    # it directly instead of going through FastAPI.
    payload = f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"
    dead = []
    for q in _subscribers:
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _subscribers.discard(q)


@app.get("/events")
async def events():
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
    _subscribers.add(queue)

    async def gen():
        try:
            yield "event: ready\ndata: {}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=25)
                    yield payload
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"  # comment line -- keeps proxies from closing an idle stream
        finally:
            _subscribers.discard(queue)

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Loot CRUD + voting
# ---------------------------------------------------------------------------


@app.get("/loot")
async def list_loot():
    return await db.list_active_loot()


@app.post("/loot")
async def create_loot(
    request: Request,
    hall_id: str,
    booth_no: str,
    company_name: str,
    items: str,
    pin_x: float,
    pin_y: float,
    submitted_by: Optional[str] = None,
    photo: Optional[UploadFile] = None,
):
    if hall_id not in db.VALID_HALL_IDS:
        raise HTTPException(400, "unknown hall_id")
    if not (0 <= pin_x <= 1 and 0 <= pin_y <= 1):
        raise HTTPException(400, "pin_x/pin_y must be normalized 0..1")
    booth_no = booth_no.strip()[:40]
    company_name = company_name.strip()[:120]
    items = items.strip()[:500]
    if not booth_no or not company_name or not items:
        raise HTTPException(400, "booth_no, company_name and items are required")

    device_id = _device_id(request)
    if not _create_limiter.allow(_client_key(request)):
        raise HTTPException(429, "too many loot submissions -- try again in a bit")

    photo_bytes: Optional[bytes] = None
    photo_mime: Optional[str] = None
    if photo is not None and photo.filename:
        photo_bytes = await photo.read()
        if len(photo_bytes) > db.MAX_PHOTO_BYTES:
            raise HTTPException(413, f"photo too large -- max {db.MAX_PHOTO_BYTES // 1000}KB, resize before upload")
        photo_mime = photo.content_type or "image/jpeg"

    entry = await db.create_loot(
        hall_id=hall_id,
        booth_no=booth_no,
        company_name=company_name,
        items=items,
        pin_x=pin_x,
        pin_y=pin_y,
        submitted_by=(submitted_by or "").strip()[:60] or None,
        device_id=device_id,
        photo=photo_bytes,
        photo_mime=photo_mime,
    )
    await _broadcast("loot.created", entry)
    return entry


@app.get("/loot/{loot_id}/photo")
async def loot_photo(loot_id: int):
    result = await db.get_photo(loot_id)
    if result is None:
        raise HTTPException(404, "no photo")
    data, mime = result
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


class VoteIn(BaseModel):
    vote_type: str


@app.post("/loot/{loot_id}/vote")
async def vote_loot(loot_id: int, body: VoteIn, request: Request):
    if body.vote_type not in ("confirm", "dispute"):
        raise HTTPException(400, "vote_type must be confirm or dispute")
    device_id = _device_id(request)
    if not _vote_limiter.allow(_client_key(request)):
        raise HTTPException(429, "too many votes -- slow down")
    entry = await db.cast_vote(loot_id, device_id, body.vote_type)
    if entry is None:
        raise HTTPException(404, "loot entry not found")
    await _broadcast("loot.updated", entry)
    return entry


class RatingIn(BaseModel):
    stars: int = Field(ge=1, le=5)


@app.post("/loot/{loot_id}/rate")
async def rate_loot(loot_id: int, body: RatingIn, request: Request):
    device_id = _device_id(request)
    if not _vote_limiter.allow(_client_key(request)):
        raise HTTPException(429, "too many ratings -- slow down")
    entry = await db.cast_rating(loot_id, device_id, body.stars)
    if entry is None:
        raise HTTPException(404, "loot entry not found")
    await _broadcast("loot.updated", entry)
    return entry


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------


@app.get("/leaderboard")
async def leaderboard():
    top_loot, top_halls, top_finders = await asyncio.gather(
        db.leaderboard_top_loot(),
        db.leaderboard_top_halls(),
        db.leaderboard_top_finders(),
    )
    return {"top_loot": top_loot, "top_halls": top_halls, "top_finders": top_finders}


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


@app.on_event("startup")
async def on_startup():
    await db.init_pool()
    logger.info(json.dumps({"msg": "loot-radar startup complete"}))


@app.on_event("shutdown")
async def on_shutdown():
    await db.close_pool()
