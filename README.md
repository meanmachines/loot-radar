# Loot Radar -- Gamescom

Crowd-sourced live loot map for Gamescom: report where you found booth
swag, tag it to a hall and booth number, and let other visitors confirm,
dispute, and rate it. Built for one show weekend, fast enough to hold up
under thousands of concurrent visitors on a single small instance.

## Stack

- Backend: FastAPI + asyncpg, single uvicorn worker (see `backend/db.py`'s
  module docstring for why -- the in-memory rate limiter and SSE pub/sub
  both assume one process).
- Frontend: vanilla HTML/CSS/JS, no build step, no external dependencies.
- Storage: Postgres (provisioned by zorc via `database: true` in
  `app.yaml`). Loot photos are stored as resized JPEG bytes in the
  database, capped at 400KB server-side (client resizes to ~900px/72%
  quality before upload).
- Live updates: Server-Sent Events (`/api/events`) push new loot and
  vote/rating changes to every connected browser without polling.

## Data model

- `loot_entries`: hall, booth, company, items, a normalized pin position
  within that hall's schematic canvas, an optional photo, a crowd
  validity score (confirm vs. dispute votes -- auto-hides an entry once
  disputes outnumber confirms past a small threshold), and an aggregate
  quality rating.
- `loot_votes` / `loot_ratings`: one row per device per loot entry (device
  identity is a random id generated client-side into `localStorage`, no
  accounts).

## Hall map

`frontend/halls.js` is a schematic layout of Gamescom's 11 halls + Confex
-- correct hall numbers, correct relative adjacency, and area-category
colors matching the official legend at gamescom.global/en/info/hall-plan,
but flat rectangles rather than a traced copy of Koelnmesse's own artwork.
It's a wayfinding aid (which hall, roughly where), not a certified
floorplan; loot pins within a hall are placed by tapping the schematic
canvas, which is precise enough for "go to this rough area" without
needing an official booth-level floorplan.

## Position tracking

There is no cm-accurate indoor GPS here -- that needs physical beacon
infrastructure (UWB/BLE) this show doesn't have. What's real:

1. Tap-to-set your position on the open hall's canvas (instant, exact).
2. Device motion (accelerometer step detection) nudges your dot forward
   between manual corrections -- real movement feedback, drifts over time
   like any dead-reckoning approach, correct anytime with another tap.
3. Device compass heading rotates the dot's direction arrow.
4. The browser's own Geolocation API (GPS/WiFi/cell, whatever the OS
   gives it) is shown as an honest accuracy figure, not asserted as
   hall-interior precision -- useful mainly outdoors/between halls.

## Local dev

```
cd backend
pip install -r requirements.txt
DATABASE_URL=postgresql://... uvicorn main:app --reload --port 8643
```

Serve `frontend/` with any static file server and point its `/api/*`
requests at the backend (see `nginx.conf` for the proxy shape used in
production).
