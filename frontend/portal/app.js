"use strict";

// Loot Radar portal -- the global entry point. Fetches the live event
// catalog from the shared backend (see backend/events_registry.py) and
// renders one card per event; each event owns its own self-contained
// frontend directory (frontend/events/<id>/) that this page just links to.
// Adding a second event means adding a registry entry and a new
// frontend/events/<id>/ directory -- nothing here needs to change.

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderEvents(events) {
  const container = document.getElementById("events");
  if (!events.length) {
    container.innerHTML = '<div class="empty-catalog">No events live right now -- check back soon.</div>';
    return;
  }
  container.innerHTML = events.map((ev) => `
    <a class="event-card" href="${escapeHtml(ev.path)}">
      <div class="event-card-top">
        <span class="event-status ${ev.status}">${ev.status === "live" ? '<span class="dot"></span>' : ""}${escapeHtml(ev.status)}</span>
        <span class="event-arrow">${icon("arrow")}</span>
      </div>
      <div class="event-name">${escapeHtml(ev.name)}</div>
      <div class="event-subtitle">${escapeHtml(ev.subtitle)}</div>
    </a>
  `).join("");
}

async function init() {
  // Site-wide sign-in gate (see auth-gate.js's own module comment) -- the
  // portal itself is gated too, not just the event apps, so this fetches
  // nothing and shows nothing beyond the gate until signed in.
  const signedIn = await window.ensureAuthGate();
  if (!signedIn) return;

  try {
    const res = await fetch("/api/event-catalog");
    const events = await res.json();
    renderEvents(events);
  } catch (e) {
    document.getElementById("events").innerHTML = '<div class="empty-catalog">Could not load events -- try refreshing.</div>';
  }
}

init();
