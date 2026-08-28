"""The events catalog -- what makes loot-radar a platform rather than a
one-off Gamescom tool. One backend + one Postgres instance serves every
event (see db.py's own event_id column); each event is one entry here plus
its own self-contained frontend directory under frontend/events/<id>/ (own
index.html/app.js/halls.js/hallplan data, following gamescom2026's own
EVENT_ID constant and relative-asset-path convention -- see that
directory's app.js for the pattern a new event copies).

Deliberately a plain Python dict, not a database table: the catalog itself
changes on a deploy cadence (a human adds a new event's frontend directory
and a matching entry here, then redeploys), not at runtime, so there's no
real need for an admin UI or a migration just to list what events exist.
"""

from __future__ import annotations

EVENTS = {
    "gamescom2026": {
        "id": "gamescom2026",
        "name": "gamescom 2026",
        "subtitle": "Koelnmesse, Cologne -- Aug 26-30, 2026",
        "status": "live",
        "path": "/gamescom2026/",
        # Matches frontend/events/gamescom2026/halls.js's own HALLS list --
        # validated server-side so a malformed hall_id can never reach the
        # database (see create_loot in main.py).
        "hall_ids": {
            "confex", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "h11",
        },
    },
}

EVENT_HALL_IDS = {eid: e["hall_ids"] for eid, e in EVENTS.items()}
VALID_EVENT_IDS = set(EVENTS.keys())


def public_catalog() -> list[dict]:
    """Everything the portal needs, none of the server-only bits (hall_ids
    is validation-only data a landing page has no use for)."""
    return [
        {"id": e["id"], "name": e["name"], "subtitle": e["subtitle"], "status": e["status"], "path": e["path"]}
        for e in EVENTS.values()
    ]
