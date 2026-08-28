"""Postgres access layer for loot-radar.

Single-process assumption throughout this app (see main.py's own note on
why uvicorn runs with exactly one worker): the in-memory read cache here
and the SSE broadcaster in main.py both rely on living in one process. A
loot entry list in the hundreds/low-thousands at a single show doesn't
need a second worker or a cache invalidation protocol -- it needs to
serve reads fast, and an in-memory list refreshed on writes does that
with zero infrastructure.
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

import asyncpg

DATABASE_URL = os.environ["DATABASE_URL"]

# Hall ids are a small, fixed set (see frontend/halls.js for the matching
# geometry/display data) -- validated here so a malformed hall_id can never
# reach the database, without needing a halls table or a round trip just to
# check membership.
VALID_HALL_IDS = {
    "confex", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "h11",
}

# Bytes, not pixels -- the client resizes/compresses before upload (see
# app.js's own comment on why: no server-side image library needed at all
# this way), this is just the hard safety cap against an oversized or
# malicious payload.
MAX_PHOTO_BYTES = 400_000

_pool: Optional[asyncpg.Pool] = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS loot_entries (
    id SERIAL PRIMARY KEY,
    hall_id TEXT NOT NULL,
    booth_no TEXT NOT NULL,
    company_name TEXT NOT NULL,
    items TEXT NOT NULL,
    pin_x REAL NOT NULL,
    pin_y REAL NOT NULL,
    photo BYTEA,
    photo_mime TEXT,
    submitted_by TEXT,
    device_id TEXT NOT NULL,
    validity_score INT NOT NULL DEFAULT 0,
    confirm_count INT NOT NULL DEFAULT 0,
    dispute_count INT NOT NULL DEFAULT 0,
    quality_sum INT NOT NULL DEFAULT 0,
    quality_count INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loot_entries_hall_idx ON loot_entries(hall_id);
CREATE INDEX IF NOT EXISTS loot_entries_status_idx ON loot_entries(status);

CREATE TABLE IF NOT EXISTS loot_votes (
    id SERIAL PRIMARY KEY,
    loot_id INT NOT NULL REFERENCES loot_entries(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    vote_type TEXT NOT NULL CHECK (vote_type IN ('confirm', 'dispute')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(loot_id, device_id)
);

CREATE TABLE IF NOT EXISTS loot_ratings (
    id SERIAL PRIMARY KEY,
    loot_id INT NOT NULL REFERENCES loot_entries(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    stars INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(loot_id, device_id)
);
"""

# Every column the frontend needs, MINUS the photo bytes themselves (those
# are large and only fetched on demand via GET /loot/{id}/photo) -- list
# queries would otherwise drag full image payloads over the wire for every
# entry on every poll.
_LIST_COLUMNS = """
    id, hall_id, booth_no, company_name, items, pin_x, pin_y,
    (photo IS NOT NULL) AS has_photo, submitted_by,
    validity_score, confirm_count, dispute_count,
    quality_sum, quality_count, status,
    extract(epoch FROM created_at) AS created_at
"""


async def init_pool() -> None:
    global _pool
    _pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    async with _pool.acquire() as conn:
        await conn.execute(SCHEMA)


async def close_pool() -> None:
    if _pool is not None:
        await _pool.close()


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db pool not initialized -- init_pool() must run at startup")
    return _pool


async def db_ready() -> bool:
    try:
        async with pool().acquire() as conn:
            await conn.fetchval("SELECT 1")
        return True
    except Exception:
        return False


def _row_to_dict(row: asyncpg.Record) -> dict[str, Any]:
    d = dict(row)
    d["avg_quality"] = round(d["quality_sum"] / d["quality_count"], 2) if d["quality_count"] else None
    return d


async def list_active_loot() -> list[dict[str, Any]]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_LIST_COLUMNS} FROM loot_entries WHERE status = 'active' ORDER BY created_at DESC"
        )
    return [_row_to_dict(r) for r in rows]


async def create_loot(
    *,
    hall_id: str,
    booth_no: str,
    company_name: str,
    items: str,
    pin_x: float,
    pin_y: float,
    submitted_by: Optional[str],
    device_id: str,
    photo: Optional[bytes],
    photo_mime: Optional[str],
) -> dict[str, Any]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            f"""
            INSERT INTO loot_entries
                (hall_id, booth_no, company_name, items, pin_x, pin_y,
                 submitted_by, device_id, photo, photo_mime)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING {_LIST_COLUMNS}
            """,
            hall_id, booth_no, company_name, items, pin_x, pin_y,
            submitted_by, device_id, photo, photo_mime,
        )
    return _row_to_dict(row)


async def get_photo(loot_id: int) -> Optional[tuple[bytes, str]]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT photo, photo_mime FROM loot_entries WHERE id = $1 AND photo IS NOT NULL", loot_id
        )
    if row is None:
        return None
    return row["photo"], row["photo_mime"] or "image/jpeg"


# Vote/rating writes recompute the parent row's aggregate columns in the
# SAME transaction as the upsert -- see _recompute_validity's own comment
# for why status is derived here instead of via a background job.

async def cast_vote(loot_id: int, device_id: str, vote_type: str) -> Optional[dict[str, Any]]:
    async with pool().acquire() as conn:
        async with conn.transaction():
            existing = await conn.fetchval(
                "SELECT vote_type FROM loot_votes WHERE loot_id=$1 AND device_id=$2", loot_id, device_id
            )
            if existing == vote_type:
                return await _fetch_one(conn, loot_id)  # no-op, already cast this exact vote
            await conn.execute(
                """
                INSERT INTO loot_votes (loot_id, device_id, vote_type) VALUES ($1,$2,$3)
                ON CONFLICT (loot_id, device_id) DO UPDATE SET vote_type = EXCLUDED.vote_type, created_at = now()
                """,
                loot_id, device_id, vote_type,
            )
            counts = await conn.fetchrow(
                """
                SELECT
                    count(*) FILTER (WHERE vote_type='confirm') AS confirm_count,
                    count(*) FILTER (WHERE vote_type='dispute') AS dispute_count
                FROM loot_votes WHERE loot_id=$1
                """,
                loot_id,
            )
            confirm_count, dispute_count = counts["confirm_count"], counts["dispute_count"]
            # Auto-hide rule: once a loot entry has enough validity votes to
            # be meaningful (>=3) and disputes outnumber confirms, hide it
            # from the live map without needing a human moderator online --
            # the whole point of a crowd validity score. Re-confirming past
            # this threshold (if someone corrects a wrong dispute) can bring
            # it back, since this recomputes fresh on every vote.
            total = confirm_count + dispute_count
            status = "hidden" if (total >= 3 and dispute_count > confirm_count) else "active"
            await conn.execute(
                """
                UPDATE loot_entries
                SET confirm_count=$2, dispute_count=$3,
                    validity_score = $2 - $3, status=$4
                WHERE id=$1
                """,
                loot_id, confirm_count, dispute_count, status,
            )
            return await _fetch_one(conn, loot_id)


async def cast_rating(loot_id: int, device_id: str, stars: int) -> Optional[dict[str, Any]]:
    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO loot_ratings (loot_id, device_id, stars) VALUES ($1,$2,$3)
                ON CONFLICT (loot_id, device_id) DO UPDATE SET stars = EXCLUDED.stars, created_at = now()
                """,
                loot_id, device_id, stars,
            )
            agg = await conn.fetchrow(
                "SELECT coalesce(sum(stars),0) AS s, count(*) AS c FROM loot_ratings WHERE loot_id=$1", loot_id
            )
            await conn.execute(
                "UPDATE loot_entries SET quality_sum=$2, quality_count=$3 WHERE id=$1",
                loot_id, agg["s"], agg["c"],
            )
            return await _fetch_one(conn, loot_id)


async def _fetch_one(conn: asyncpg.Connection, loot_id: int) -> Optional[dict[str, Any]]:
    row = await conn.fetchrow(f"SELECT {_LIST_COLUMNS} FROM loot_entries WHERE id=$1", loot_id)
    return _row_to_dict(row) if row else None


async def leaderboard_top_loot(limit: int = 20) -> list[dict[str, Any]]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT {_LIST_COLUMNS} FROM loot_entries
            WHERE status='active' AND quality_count >= 2
            ORDER BY (quality_sum::float / NULLIF(quality_count,0)) DESC, quality_count DESC
            LIMIT $1
            """,
            limit,
        )
    return [_row_to_dict(r) for r in rows]


async def leaderboard_top_halls(limit: int = 11) -> list[dict[str, Any]]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT hall_id, count(*) AS loot_count,
                   coalesce(avg(quality_sum::float / NULLIF(quality_count,0)), 0) AS avg_quality
            FROM loot_entries
            WHERE status='active'
            GROUP BY hall_id
            ORDER BY loot_count DESC
            LIMIT $1
            """,
            limit,
        )
    return [dict(r) for r in rows]


async def leaderboard_top_finders(limit: int = 20) -> list[dict[str, Any]]:
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT coalesce(nullif(submitted_by, ''), 'Anonymous scout') AS name,
                   count(*) AS loot_count
            FROM loot_entries
            WHERE status='active'
            GROUP BY 1
            ORDER BY loot_count DESC
            LIMIT $1
            """,
            limit,
        )
    return [dict(r) for r in rows]


class RateLimiter:
    """Fixed-window per-key token bucket, in-memory. Fine for a single
    uvicorn worker (see this module's own top-of-file note) -- would need
    a shared store the moment this app runs more than one process.
    """

    def __init__(self, max_per_window: int, window_seconds: float) -> None:
        self.max = max_per_window
        self.window = window_seconds
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        hits = [t for t in self._hits.get(key, []) if now - t < self.window]
        if len(hits) >= self.max:
            self._hits[key] = hits
            return False
        hits.append(now)
        self._hits[key] = hits
        return True
