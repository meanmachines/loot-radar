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

# One backend, one Postgres, many events -- see the portal at
# frontend/portal/ and events_registry.py's own module docstring for the
# rest of this design. hall_id/event_id validation against that registry
# happens in main.py, right before it ever calls into this module -- this
# layer just trusts its caller and does the query.

# Bytes, not pixels -- the client resizes/compresses before upload (see
# app.js's own comment on why: no server-side image library needed at all
# this way), this is just the hard safety cap against an oversized or
# malicious payload.
MAX_PHOTO_BYTES = 400_000

_pool: Optional[asyncpg.Pool] = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS loot_entries (
    id SERIAL PRIMARY KEY,
    event_id TEXT NOT NULL DEFAULT 'gamescom2026',
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
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    validity_score INT NOT NULL DEFAULT 0,
    confirm_count INT NOT NULL DEFAULT 0,
    dispute_count INT NOT NULL DEFAULT 0,
    quality_sum INT NOT NULL DEFAULT 0,
    quality_count INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Additive migrations for the already-live table (this app shipped and had
-- real traffic before events_registry.py's multi-event model AND accounts
-- existed) -- ADD COLUMN IF NOT EXISTS with a DEFAULT/NULL backfills every
-- existing row, so nothing reported before either migration is orphaned or
-- dropped. user_id is nullable and stays that way -- an anonymous
-- submission is still a fully valid one, just not yet linked to anyone
-- (see auth.py's own note on how sign-in retroactively links past
-- device_id activity to the account that just signed in).
ALTER TABLE loot_entries ADD COLUMN IF NOT EXISTS event_id TEXT NOT NULL DEFAULT 'gamescom2026';
ALTER TABLE loot_entries ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS loot_entries_hall_idx ON loot_entries(hall_id);
CREATE INDEX IF NOT EXISTS loot_entries_user_idx ON loot_entries(user_id);
-- Composite, not two separate single-column indexes -- every hot read
-- path (list_active_loot, all three leaderboard queries) filters on
-- exactly this pair together, and a composite index lets Postgres satisfy
-- that filter in one index scan instead of a bitmap AND across two.
CREATE INDEX IF NOT EXISTS loot_entries_event_status_idx ON loot_entries(event_id, status);

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
    id, event_id, hall_id, booth_no, company_name, items, pin_x, pin_y,
    (photo IS NOT NULL) AS has_photo, submitted_by, user_id,
    validity_score, confirm_count, dispute_count,
    quality_sum, quality_count, status,
    extract(epoch FROM created_at)::float8 AS created_at
"""
# Real bug found live: EXTRACT(EPOCH FROM ...) returns Postgres `numeric`,
# which asyncpg maps to Python Decimal, not float -- FastAPI's own response
# encoder tolerates that silently (jsonable_encoder converts Decimal->float),
# but main.py's _broadcast() uses plain stdlib json.dumps for the SSE
# stream, which has no Decimal support and raised a 500 on every single
# loot creation. The ::float8 cast here makes asyncpg return a real float
# at the query level, so every consumer gets the same plain-float value
# instead of relying on FastAPI's encoder to paper over a type mismatch
# in one path but not another.


async def init_pool() -> None:
    global _pool
    # max_size=25, not the original 10 -- a viral traffic spike means many
    # near-simultaneous initial page loads (each one GET /loot + 3
    # leaderboard queries) landing in the same second; 10 connections
    # queued up fast under that burst even though sustained load is tiny
    # (SSE carries live updates after the initial load, not polling). The
    # read cache below cuts real query volume far more than pool size
    # alone could, but the pool still needs enough headroom for the
    # concurrent MISSES a fresh cache window allows before it refills.
    _pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=25)
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


class TTLCache:
    """Small per-key TTL cache -- single process only (see this module's
    own docstring, same assumption as RateLimiter below). The real reason
    this exists: a traffic spike means many near-simultaneous INITIAL page
    loads (each one a GET /loot plus three leaderboard queries) landing in
    the same second or two, not sustained high query-per-second load (live
    updates after that first load ride the SSE stream, not polling) -- a
    short cache turns "thousands of requests hit Postgres in one burst"
    into "the first request in each TTL window hits Postgres, everyone
    else in that window reads memory," which is the actual fix a bigger
    connection pool alone can't provide.
    """

    def __init__(self, ttl_seconds: float):
        self.ttl = ttl_seconds
        self._store: dict[Any, tuple[float, Any]] = {}

    def get(self, key: Any) -> Any:
        entry = self._store.get(key)
        if entry is None:
            return None
        fetched_at, value = entry
        if time.monotonic() - fetched_at > self.ttl:
            return None
        return value

    def set(self, key: Any, value: Any) -> None:
        self._store[key] = (time.monotonic(), value)

    def clear(self) -> None:
        self._store.clear()


# Loot list: short TTL -- someone who just reported loot wants to see it
# show up fast even on a fresh page load (not just via their own optimistic
# local update). Leaderboard: longer TTL -- rankings shifting by a few
# seconds' delay is imperceptible, and it's the more expensive read (three
# aggregate queries, not one plain select).
_loot_cache = TTLCache(ttl_seconds=2.0)
_leaderboard_cache = TTLCache(ttl_seconds=5.0)


def _invalidate_read_caches() -> None:
    # Cleared wholesale (every event, not just the one that changed) --
    # deliberately simple: the catalog is a handful of events at most (see
    # events_registry.py), so there's no real cost to clearing all of it
    # versus the complexity of tracing a loot_id back to its event_id
    # first just to invalidate one key.
    _loot_cache.clear()
    _leaderboard_cache.clear()


async def list_active_loot(event_id: str) -> list[dict[str, Any]]:
    cached = _loot_cache.get(event_id)
    if cached is not None:
        return cached
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_LIST_COLUMNS} FROM loot_entries WHERE status = 'active' AND event_id = $1 ORDER BY created_at DESC",
            event_id,
        )
    result = [_row_to_dict(r) for r in rows]
    _loot_cache.set(event_id, result)
    return result


async def create_loot(
    *,
    event_id: str,
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
    user_id: Optional[int] = None,
) -> dict[str, Any]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            f"""
            INSERT INTO loot_entries
                (event_id, hall_id, booth_no, company_name, items, pin_x, pin_y,
                 submitted_by, device_id, photo, photo_mime, user_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING {_LIST_COLUMNS}
            """,
            event_id, hall_id, booth_no, company_name, items, pin_x, pin_y,
            submitted_by, device_id, photo, photo_mime, user_id,
        )
    _invalidate_read_caches()
    return _row_to_dict(row)


# ---------------------------------------------------------------------------
# Accounts -- see auth.py for the actual OAuth flow (authorize/callback,
# session cookie issuance). This module only owns the storage: upsert on
# every successful login (so a returning user's profile picture/name stays
# fresh, not just their identity), and the retroactive link from an
# anonymous device_id's past activity to the account that just signed in
# with it.
# ---------------------------------------------------------------------------


async def upsert_user(
    *, provider: str, provider_user_id: str, email: Optional[str], display_name: Optional[str], avatar_url: Optional[str]
) -> dict[str, Any]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO users (provider, provider_user_id, email, display_name, avatar_url)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (provider, provider_user_id)
            DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, avatar_url=EXCLUDED.avatar_url
            RETURNING id, provider, email, display_name, avatar_url, extract(epoch FROM created_at)::float8 AS created_at
            """,
            provider, provider_user_id, email, display_name, avatar_url,
        )
    return dict(row)


async def get_user(user_id: int) -> Optional[dict[str, Any]]:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, provider, email, display_name, avatar_url, extract(epoch FROM created_at)::float8 AS created_at FROM users WHERE id=$1",
            user_id,
        )
    return dict(row) if row else None


async def link_device_to_user(device_id: str, user_id: int) -> int:
    """Retroactively claims every anonymous loot entry this device already
    submitted (across every event -- accounts are platform-wide, see
    events_registry.py's own module docstring) that isn't linked to some
    OTHER account already. Returns how many rows got linked, purely for
    logging -- callers don't need to branch on it.
    """
    async with pool().acquire() as conn:
        result = await conn.execute(
            "UPDATE loot_entries SET user_id=$1 WHERE device_id=$2 AND user_id IS NULL", user_id, device_id
        )
    _invalidate_read_caches()
    # asyncpg's execute() returns a status string like "UPDATE 3"
    try:
        return int(result.split()[-1])
    except (ValueError, IndexError):
        return 0


async def list_my_loot(event_id: str, *, user_id: Optional[int], device_id: str) -> list[dict[str, Any]]:
    """Everything this visitor has reported at this event -- matched by
    user_id when signed in (covers every device they've ever used), OR by
    this device's own id (covers activity from before they signed in, or
    if they're browsing anonymously). Deliberately NOT cached (see
    list_active_loot) -- this is a low-traffic, per-user query, not a hot
    shared path a traffic spike would burst on.
    """
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT {_LIST_COLUMNS} FROM loot_entries
            WHERE event_id=$1 AND (user_id = $2 OR device_id = $3)
            ORDER BY created_at DESC
            """,
            event_id, user_id, device_id,
        )
    return [_row_to_dict(r) for r in rows]


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
            # Real bug found live: without this check, voting on a
            # nonexistent loot_id (a stale link, a typo'd id) raised an
            # unhandled asyncpg.exceptions.ForeignKeyViolationError from
            # the INSERT below (loot_votes.loot_id references
            # loot_entries.id) -- a 500, not the clean 404 main.py's own
            # vote_loot handler already expects when this returns None.
            if not await conn.fetchval("SELECT 1 FROM loot_entries WHERE id=$1", loot_id):
                return None
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
            # Real bug found live: `validity_score = $2 - $3` inside the SQL
            # itself raised asyncpg.exceptions.AmbiguousFunctionError
            # ("operator is not unique: unknown - unknown") -- both
            # placeholders arrive at the wire as untyped parameters, and
            # Postgres couldn't infer a type for the bare `-` between two
            # of them from this UPDATE's own context. confirm_count and
            # dispute_count are already plain Python ints here (asyncpg
            # maps bigint -> int), so just doing the subtraction in Python
            # and passing the result as its own typed parameter sidesteps
            # the ambiguity entirely instead of adding SQL-side casts.
            validity_score = confirm_count - dispute_count
            await conn.execute(
                """
                UPDATE loot_entries
                SET confirm_count=$2, dispute_count=$3,
                    validity_score=$4, status=$5
                WHERE id=$1
                """,
                loot_id, confirm_count, dispute_count, validity_score, status,
            )
            _invalidate_read_caches()
            return await _fetch_one(conn, loot_id)


async def cast_rating(loot_id: int, device_id: str, stars: int) -> Optional[dict[str, Any]]:
    async with pool().acquire() as conn:
        async with conn.transaction():
            # Same real bug as cast_vote above, same fix -- loot_ratings has
            # the identical FK-to-loot_entries shape.
            if not await conn.fetchval("SELECT 1 FROM loot_entries WHERE id=$1", loot_id):
                return None
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
            _invalidate_read_caches()
            return await _fetch_one(conn, loot_id)


async def _fetch_one(conn: asyncpg.Connection, loot_id: int) -> Optional[dict[str, Any]]:
    row = await conn.fetchrow(f"SELECT {_LIST_COLUMNS} FROM loot_entries WHERE id=$1", loot_id)
    return _row_to_dict(row) if row else None


async def leaderboard_top_loot(event_id: str, limit: int = 20) -> list[dict[str, Any]]:
    cache_key = ("top_loot", event_id, limit)
    cached = _leaderboard_cache.get(cache_key)
    if cached is not None:
        return cached
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT {_LIST_COLUMNS} FROM loot_entries
            WHERE status='active' AND event_id=$1 AND quality_count >= 2
            ORDER BY (quality_sum::float / NULLIF(quality_count,0)) DESC, quality_count DESC
            LIMIT $2
            """,
            event_id, limit,
        )
    result = [_row_to_dict(r) for r in rows]
    _leaderboard_cache.set(cache_key, result)
    return result


async def leaderboard_top_halls(event_id: str, limit: int = 11) -> list[dict[str, Any]]:
    cache_key = ("top_halls", event_id, limit)
    cached = _leaderboard_cache.get(cache_key)
    if cached is not None:
        return cached
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT hall_id, count(*) AS loot_count,
                   coalesce(avg(quality_sum::float / NULLIF(quality_count,0)), 0) AS avg_quality
            FROM loot_entries
            WHERE status='active' AND event_id=$1
            GROUP BY hall_id
            ORDER BY loot_count DESC
            LIMIT $2
            """,
            event_id, limit,
        )
    result = [dict(r) for r in rows]
    _leaderboard_cache.set(cache_key, result)
    return result


async def leaderboard_top_finders(event_id: str, limit: int = 20) -> list[dict[str, Any]]:
    cache_key = ("top_finders", event_id, limit)
    cached = _leaderboard_cache.get(cache_key)
    if cached is not None:
        return cached
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT coalesce(nullif(submitted_by, ''), 'Anonymous scout') AS name,
                   count(*) AS loot_count
            FROM loot_entries
            WHERE status='active' AND event_id=$1
            GROUP BY 1
            ORDER BY loot_count DESC
            LIMIT $2
            """,
            event_id, limit,
        )
    result = [dict(r) for r in rows]
    _leaderboard_cache.set(cache_key, result)
    return result


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
