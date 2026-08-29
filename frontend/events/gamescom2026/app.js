"use strict";

// ---------------------------------------------------------------------------
// loot-radar frontend -- vanilla JS, no build step (same philosophy as
// zBots' own frontend: fast to serve, nothing to break in a build
// pipeline on a tight deadline). API_BASE is relative -- nginx proxies
// /api/* to the backend (shared across every event, unlike the static
// frontend files -- see nginx.conf's own comment on why), same pattern as
// zBots' /bots-api/ prefix.
//
// EVENT_ID scopes every list/create call to this one event now that the
// backend serves more than one (see backend/db.py's event_id column) --
// this file is the Gamescom 2026 event experience specifically, mounted
// at /gamescom2026/ by the portal at /. A future event copies this whole
// directory and changes only this one constant plus its own halls.js/
// hallplan data -- nothing else in this file is Gamescom-specific.
// ---------------------------------------------------------------------------

const API_BASE = "/api";
const EVENT_ID = "gamescom2026";

function deviceId() {
  let id = localStorage.getItem("lr_device_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/-/g, "");
    localStorage.setItem("lr_device_id", id);
  }
  return id;
}

async function apiGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API_BASE}${path}${sep}event_id=${EVENT_ID}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function apiPostJson(path, body) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Id": deviceId() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function apiCreateLoot(fields, photoBlob) {
  const qs = new URLSearchParams({ ...fields, event_id: EVENT_ID }).toString();
  const form = new FormData();
  if (photoBlob) form.append("photo", photoBlob, "loot.jpg");
  const res = await fetch(`${API_BASE}/loot?${qs}`, {
    method: "POST",
    headers: { "X-Device-Id": deviceId() },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `create failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, isErr) {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.innerHTML = `<span class="dot"></span><span>${escapeHtml(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lootById = new Map(); // id -> entry
let openHallId = null;
let openLootId = null;
let pendingAction = null; // null | "placing-loot"
let pendingPin = null; // {x,y} normalized, set right before opening add-sheet
let leaderboardTab = "top_loot";
let leaderboardCache = null;

function lootForHall(hallId) {
  return [...lootById.values()].filter((l) => l.hall_id === hallId && l.status === "active");
}

function hallLootCount(hallId) {
  return lootForHall(hallId).length;
}

// ---------------------------------------------------------------------------
// Venue map
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

let mapViewMode = "3d"; // "3d" | "2d" -- see toggleMapViewMode

function renderVenueMap() {
  if (mapViewMode === "3d") renderVenueMapIso();
  else renderVenueMap2D();
}

function hallLootBadge(hall, cx, cy, g) {
  // Loot-count badge -- pulses when the hall has any active entries so a
  // scan of the whole venue shows where loot has been reported at a
  // glance. Shared between the 2D and 3D renderers (cx/cy is wherever the
  // caller wants the badge anchored -- top-right corner of the flat rect
  // for 2D, apex of the extruded block's top face for 3D).
  const count = hallLootCount(hall.id);
  if (count <= 0) return;
  const ping = svgEl("circle", { cx, cy, r: 14, class: "hall-badge-ping animate", stroke: hall.color });
  g.appendChild(ping);
  const bg = svgEl("circle", { cx, cy, r: 14, class: "hall-badge-bg", stroke: hall.color });
  g.appendChild(bg);
  const countText = svgEl("text", { x: cx, y: cy + 1, class: "hall-badge-count" });
  countText.textContent = String(count);
  g.appendChild(countText);
}

function renderVenueMap2D() {
  const svg = document.getElementById("venue-svg");
  svg.setAttribute("viewBox", `0 0 ${VENUE_VIEWBOX.w} ${VENUE_VIEWBOX.h}`);
  svg.innerHTML = "";

  for (const hall of HALLS) {
    const g = svgEl("g", {});
    const rect = svgEl("rect", {
      x: hall.rect.x, y: hall.rect.y, width: hall.rect.w, height: hall.rect.h,
      class: "hall-rect", fill: hall.color, stroke: hall.color, rx: 14,
    });
    rect.addEventListener("click", () => openHall(hall.id));
    g.appendChild(rect);

    if (hall.splitColor) {
      const half = svgEl("rect", {
        x: hall.rect.x + hall.rect.w / 2, y: hall.rect.y, width: hall.rect.w / 2, height: hall.rect.h,
        class: "hall-rect", fill: hall.splitColor, stroke: hall.splitColor, rx: 14,
      });
      half.addEventListener("click", () => openHall(hall.id));
      g.appendChild(half);
    }
    if (hall.accent) {
      const size = Math.min(hall.rect.w, hall.rect.h) * 0.42;
      const cx = hall.rect.x + hall.rect.w;
      const cy = hall.rect.y + hall.rect.h;
      const tri = svgEl("polygon", {
        points: `${cx},${cy - size} ${cx},${cy} ${cx - size},${cy}`,
        fill: hall.accent.color, opacity: 0.5, style: "pointer-events:none",
      });
      g.appendChild(tri);
    }

    const cx = hall.rect.x + hall.rect.w / 2;
    const cy = hall.rect.y + hall.rect.h / 2;
    const label = svgEl("text", { x: cx, y: cy - 6, class: "hall-label" });
    label.textContent = hall.number;
    g.appendChild(label);
    const sub = svgEl("text", { x: cx, y: cy + 20, class: "hall-sub" });
    sub.textContent = hall.category.length > 20 ? hall.name : hall.category;
    g.appendChild(sub);

    hallLootBadge(hall, hall.rect.x + hall.rect.w - 6, hall.rect.y + 6, g);
    svg.appendChild(g);
  }

  for (const ent of ENTRANCES) {
    const t = svgEl("text", { x: ent.x, y: ent.y, class: "entrance-label" });
    t.textContent = ent.label + " entrance";
    svg.appendChild(t);
  }
}

// ---------------------------------------------------------------------------
// Isometric 3D venue overview -- standard 2:1 dimetric tile projection
// (the same math any isometric tile game uses), applied to each hall's own
// flat rect instead of tracing new geometry, so this stays in sync with
// halls.js automatically. No WebGL/3D library -- three flat SVG polygons
// per hall (top/left/right faces) reads as a convincing "block city" at
// this scale and is far cheaper to build and to ship today.
// ---------------------------------------------------------------------------

const ISO_ANGLE = Math.PI / 6; // 30 degrees -- standard isometric tile angle
const ISO_COS = Math.cos(ISO_ANGLE);
const ISO_SIN = Math.sin(ISO_ANGLE);

function isoProject(x, y, z) {
  // Standard isometric projection: screen.x from (x - y), screen.y from
  // (x + y) compressed vertically, then z lifts straight up the screen.
  return {
    x: (x - y) * ISO_COS,
    y: (x + y) * ISO_SIN - z,
  };
}

function isoHeightForHall(hall) {
  const levels = HALLPLAN_LEVELS[hall.id];
  const count = levels
    ? (INDEX_CACHE ? levels.reduce((s, lvl) => s + (INDEX_CACHE.byFile[lvl.file]?.stands || 0), 0) : 40)
    : 25;
  return 26 + Math.min(46, Math.sqrt(count) * 5.2);
}

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

function renderVenueMapIso() {
  const svg = document.getElementById("venue-svg");
  const halls = [...HALLS].sort((a, b) => (a.rect.x + a.rect.y) - (b.rect.x + b.rect.y)); // back-to-front paint order
  const pts = [];
  const blocks = [];
  for (const hall of halls) {
    const { x, y, w, h } = hall.rect;
    const height = isoHeightForHall(hall);
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const top = corners.map(([px, py]) => isoProject(px, py, height));
    const base = corners.map(([px, py]) => isoProject(px, py, 0));
    top.forEach((p) => pts.push(p));
    base.forEach((p) => pts.push(p));
    blocks.push({ hall, top, base, height });
  }
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const pad = 24;
  svg.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`);
  svg.innerHTML = "";

  const poly = (points) => points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  for (const { hall, top, base } of blocks) {
    const g = svgEl("g", { class: "iso-hall-group" });
    g.addEventListener("click", () => openHall(hall.id));

    // Right face: top[1]-top[2]-base[2]-base[1] (east-facing side)
    const right = svgEl("polygon", { points: poly([top[1], top[2], base[2], base[1]]), class: "iso-right", fill: shade(hall.color, 0.55), stroke: shade(hall.color, 0.4) });
    // Left/front face: top[2]-top[3]-base[3]-base[2] (south-facing side)
    const left = svgEl("polygon", { points: poly([top[2], top[3], base[3], base[2]]), class: "iso-left", fill: shade(hall.color, 0.75), stroke: shade(hall.color, 0.55) });
    // Top face
    const face = svgEl("polygon", { points: poly(top), class: "iso-top", fill: hall.color, stroke: shade(hall.color, 1.25) });
    g.appendChild(right);
    g.appendChild(left);
    g.appendChild(face);

    const centerTop = { x: (top[0].x + top[2].x) / 2, y: (top[0].y + top[2].y) / 2 };
    const label = svgEl("text", { x: centerTop.x, y: centerTop.y - 2, class: "hall-label", style: "font-size:20px" });
    label.textContent = hall.number;
    g.appendChild(label);

    hallLootBadge(hall, top[1].x, top[1].y, g);
    svg.appendChild(g);
  }
}

function toggleMapViewMode() {
  mapViewMode = mapViewMode === "3d" ? "2d" : "3d";
  document.getElementById("btn-3d-toggle").classList.toggle("on", mapViewMode === "3d");
  renderVenueMap();
}
document.getElementById("btn-3d-toggle").innerHTML = icon("cube");
document.getElementById("btn-3d-toggle").addEventListener("click", toggleMapViewMode);

function renderLegend() {
  const strip = document.getElementById("legend-strip");
  const seen = new Map();
  for (const h of HALLS) if (!seen.has(h.category)) seen.set(h.category, h.color);
  strip.innerHTML = [...seen.entries()]
    .map(([cat, color]) => `<div class="legend-chip"><span class="swatch" style="background:${color}"></span>${escapeHtml(cat)}</div>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Real hall-plan data -- vendored from gc2026-guide (MIT), see
// frontend/hallplan/ATTRIBUTION.md. index.json lists every covered hall's
// real size + stand count (used above for isoHeightForHall); outline.json
// supplies wall margins and door positions layered on top of Koelnmesse's
// own stand/block-only endpoint data (see that file's own `note` field for
// full provenance). Loaded lazily and cached -- most sessions only ever
// open a handful of halls, no reason to fetch all fifteen files up front.
// ---------------------------------------------------------------------------

let INDEX_CACHE = null;
const hallPlanCache = new Map(); // file id -> parsed plan json
let outlineCache = null;
let outlinePromise = null;
let currentHallLevel = null; // {hallId, file, plan, margin, extent} while a real-plan hall is open

async function loadHallplanIndex() {
  if (INDEX_CACHE) return INDEX_CACHE;
  const res = await fetch("hallplan/index.json");
  const data = await res.json();
  const byFile = {};
  for (const h of data.halls) byFile[h.id] = h;
  INDEX_CACHE = { ...data, byFile };
  return INDEX_CACHE;
}

async function loadHallPlanFile(fileId) {
  if (hallPlanCache.has(fileId)) return hallPlanCache.get(fileId);
  const res = await fetch(`hallplan/hall-${fileId}.json`);
  if (!res.ok) throw new Error(`plan fetch failed for ${fileId}`);
  const data = await res.json();
  hallPlanCache.set(fileId, data);
  return data;
}

async function loadOutline() {
  if (outlineCache) return outlineCache;
  if (!outlinePromise) outlinePromise = fetch("hallplan/outline.json").then((r) => r.json());
  outlineCache = await outlinePromise;
  return outlineCache;
}

function marginFor(outline, fileId) {
  const base = outline.margin;
  const override = (outline.halls[fileId] && outline.halls[fileId].margin) || {};
  return {
    n: override.n ?? base.n,
    e: override.e ?? base.e,
    s: override.s ?? base.s,
    w: override.w ?? base.w,
  };
}

function planExtent(plan, margin) {
  return { w: margin.w + plan.size[0] + margin.e, h: margin.n + plan.size[1] + margin.s };
}

async function renderRealHallPlan(hallId, fileId) {
  const [plan, outline] = await Promise.all([loadHallPlanFile(fileId), loadOutline()]);
  const margin = marginFor(outline, fileId);
  const extent = planExtent(plan, margin);
  currentHallLevel = { hallId, file: fileId, plan, margin, extent };

  const svg = document.getElementById("hall-plan-svg");
  svg.setAttribute("viewBox", `0 0 ${extent.w} ${extent.h}`);
  svg.innerHTML = "";

  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: extent.w, height: extent.h, class: "hallplan-wall" }));

  for (const block of plan.blocks || []) {
    const points = block.map(([x, y]) => `${x + margin.w},${y + margin.n}`).join(" ");
    svg.appendChild(svgEl("polygon", { points, class: "hallplan-block" }));
  }

  const doors = (outline.halls[fileId] && outline.halls[fileId].doors) || [];
  for (const door of doors) {
    const seg = doorSegment(door, margin, extent);
    if (seg) svg.appendChild(svgEl("line", { ...seg, class: "hallplan-door" }));
  }

  // Real gap found live, TWICE: (1) some stands share the exact same four
  // corners as a "g"-suffix twin, just listed in a different order/
  // winding, so a naive in-order dedup key missed the match -- fixed
  // below with an order-independent bounding-box key. (2) a "g"-suffix
  // stand is NOT always an exact duplicate -- confirmed live against the
  // real data (e.g. hall 10.1's "D-040g E-041g") that most of these are
  // instead a larger unnamed GROUP/ZONE box that overlaps several real
  // individual booths inside it (152 of 158 "g" stands across every hall
  // have zero names -- a real, named booth essentially never carries a
  // "g" suffix). Labeling both produced overlapping text even after the
  // exact-duplicate fix. isGroupZoneStand catches this whole class by what
  // the data actually says (no exhibitor, "g"-suffixed id) rather than by
  // geometry, which is simpler and correctly covers the exact-duplicate
  // case too as a side effect.
  function isGroupZoneStand(s) {
    const hasNames = s.names && s.names.length > 0;
    const allTokensGrouped = s.nr.split(/\s+/).every((tok) => tok.endsWith("g"));
    return !hasNames && allTokensGrouped;
  }

  for (const stand of plan.stands || []) {
    const shifted = stand.poly.map(([x, y]) => [x + margin.w, y + margin.n]);
    const named = stand.names && stand.names.length > 0;
    const poly = svgEl("polygon", {
      points: shifted.map(([x, y]) => `${x},${y}`).join(" "),
      class: "hallplan-stand" + (named ? " named" : ""),
    });
    poly.addEventListener("click", (e) => {
      e.stopPropagation();
      onBoothTap(stand, shifted, extent);
    });
    svg.appendChild(poly);

    if (!isGroupZoneStand(stand)) appendStandLabels(svg, stand, shifted);
  }
}

// Real gap found live: booth polygons rendered with zero visible text --
// the map read as a wall of blank colored rectangles until someone
// discovered tapping opened a detail panel. Company/booth number now
// render directly on the polygon so the map is informative at a glance,
// not just on tap.
function boundsOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Real design bug, not just the earlier px-unit sizing bug: font size was
// scaled to EACH booth's own box dimensions, so labels came out a
// different size on every single booth (a 2m booth next to a 24m one
// reads two wildly different type sizes) -- direct feedback: "text can be
// badge type or something that's same size for all uniformity instead of
// size of booth." A fixed-size badge -- constant dimensions and font
// everywhere, a dark pill that sits on top of the booth's own fill color
// rather than text scaled to disappear into a tiny box or balloon to fill
// a big one -- reads as one consistent wayfinding layer across the whole
// map, the way a real map's point labels do, instead of text that's
// literally sized by geography.
const STAND_BADGE_W = 9;
const STAND_BADGE_H = 3.6;
const STAND_BADGE_FONT = 2.15;

// Truncates to however many characters fit the FIXED badge width at the
// FIXED font size -- constant for every stand now, not computed per box,
// since the whole point is a uniform label instead of one sized to its
// own booth.
function fitLabelText(text) {
  const approxCharWidth = STAND_BADGE_FONT * 0.62;
  const maxChars = Math.max(2, Math.floor((STAND_BADGE_W - 1) / approxCharWidth));
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, maxChars - 1)) + "…";
}

function appendStandLabels(svg, stand, shifted) {
  const b = boundsOf(shifted);
  const boxW = b.maxX - b.minX;
  const boxH = b.maxY - b.minY;
  // Skip only booths too small to sensibly carry even a compact fixed
  // badge -- a badge visibly overlapping its own tiny booth's edges reads
  // worse than no badge at all, but it no longer needs to actually FIT
  // the box the way scaled-to-fit text did.
  if (Math.min(boxW, boxH) < 3.5) return;

  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  const badge = svgEl("rect", {
    x: cx - STAND_BADGE_W / 2, y: cy - STAND_BADGE_H / 2,
    width: STAND_BADGE_W, height: STAND_BADGE_H,
    rx: STAND_BADGE_H / 2,
    class: "hallplan-stand-badge",
  });
  svg.appendChild(badge);

  const boothLabel = svgEl("text", {
    x: cx, y: cy,
    class: "hallplan-stand-label",
    "font-size": STAND_BADGE_FONT,
  });
  boothLabel.textContent = fitLabelText(stand.nr);
  svg.appendChild(boothLabel);
}

// Door "at"/"span" are documented (outline.json's own note field) as
// metres along the wall, centered on the opening, in the SAME raw frame as
// stand/block coordinates (0 at the tight box's own corner, can run
// negative into the margin) -- so the same +margin.w/+margin.n shift
// applied to every other coordinate in this file places a door correctly
// too. The wall itself sits at the extent box's own edges (x=0/x=extent.w
// for west/east, y=0/y=extent.h for north/south) since that's exactly what
// the outer <rect> is drawn at. Purely a visual wayfinding cue (a short
// cyan tick where an opening is), not asserted as survey-precise.
function doorSegment(door, margin, extent) {
  const half = door.span / 2;
  if (door.edge === "n" || door.edge === "s") {
    const x1 = door.at - half + margin.w;
    const x2 = door.at + half + margin.w;
    const y = door.edge === "n" ? 0 : extent.h;
    return { x1, y1: y, x2, y2: y };
  }
  if (door.edge === "e" || door.edge === "w") {
    const y1 = door.at - half + margin.n;
    const y2 = door.at + half + margin.n;
    const x = door.edge === "w" ? 0 : extent.w;
    return { x1: x, y1, x2: x, y2 };
  }
  return null;
}

function centroidNormalized(pts, extent) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return { x: clamp01(cx / extent.w), y: clamp01(cy / extent.h) };
}

function onBoothTap(stand, shiftedPts, extent) {
  const company = stand.names && stand.names[0] ? stand.names[0] : "";
  if (pendingAction === "placing-loot") {
    pendingPin = centroidNormalized(shiftedPts, extent);
    pendingAction = null;
    document.getElementById("hall-hint").textContent = "Tap Add loot, then tap a booth (or the floor)";
    openAddSheet({ booth: stand.nr, company });
  } else if (!tracking) {
    openBoothDetail(stand, shiftedPts, extent);
  }
}

// Booth-number matching between the official plan (stand.nr, sometimes a
// compound like "A-080 C-081" for a shared/double stand) and a loot
// entry's own free-typed booth_no -- token-overlap rather than exact
// string equality so either side typing just one of the two numbers still
// matches the other.
function boothNumbersMatch(a, b) {
  const ta = new Set(String(a).toUpperCase().split(/\s+/).filter(Boolean));
  const tb = new Set(String(b).toUpperCase().split(/\s+/).filter(Boolean));
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

let boothDetailContext = null; // {hallId, stand, pin} while the booth sheet is open

function openBoothDetail(stand, shiftedPts, extent) {
  const company = stand.names && stand.names[0] ? stand.names[0] : "";
  boothDetailContext = { hallId: openHallId, stand, pin: centroidNormalized(shiftedPts, extent) };

  document.getElementById("booth-sheet-title").textContent = company || `Booth ${stand.nr}`;
  const hall = hallById(openHallId);
  document.getElementById("booth-sheet-sub").textContent = `Booth ${stand.nr}${hall ? ` -- Hall ${hall.number}` : ""}`;

  const matches = lootForHall(openHallId).filter((l) => boothNumbersMatch(l.booth_no, stand.nr));
  const body = document.getElementById("booth-sheet-body");
  let html = `<div class="booth-official-badge">${icon("check")} From the official Gamescom floor plan</div>`;
  if (!matches.length) {
    html += `<div class="empty-state">${icon("chest")}<span>No loot reported at this booth yet -- be the first.</span></div>`;
  } else {
    html += matches.map((l) => {
      const stars = l.avg_quality != null ? `${icon("star")} ${l.avg_quality}` : "Not rated yet";
      const thumb = l.has_photo
        ? `<img class="booth-loot-thumb" src="${API_BASE}/loot/${l.id}/photo" alt="" data-id="${l.id}" />`
        : `<div class="booth-loot-thumb" data-id="${l.id}"></div>`;
      return `<div class="booth-loot-card" data-id="${l.id}">
        ${thumb}
        <div class="booth-loot-info">
          <div class="booth-loot-title">${escapeHtml(l.items)}</div>
          <div class="booth-loot-sub">${stars}${l.submitted_by ? ` &middot; found by ${escapeHtml(l.submitted_by)}` : ""}</div>
        </div>
      </div>`;
    }).join("");
  }
  body.innerHTML = html;
  body.querySelectorAll(".booth-loot-card").forEach((card) => {
    card.addEventListener("click", () => openLoot(Number(card.dataset.id)));
  });

  document.getElementById("booth-sheet").classList.add("open");
}

function closeBoothDetail() {
  document.getElementById("booth-sheet").classList.remove("open");
  boothDetailContext = null;
}
document.getElementById("booth-sheet-back").addEventListener("click", closeBoothDetail);
document.getElementById("booth-report-btn").addEventListener("click", () => {
  if (!boothDetailContext) return;
  const { stand, pin } = boothDetailContext;
  const company = stand.names && stand.names[0] ? stand.names[0] : "";
  pendingPin = pin;
  closeBoothDetail();
  openAddSheet({ booth: stand.nr, company });
});

// ---------------------------------------------------------------------------
// Hall detail sheet
// ---------------------------------------------------------------------------

async function openHall(hallId) {
  const hall = hallById(hallId);
  if (!hall) return;
  openHallId = hallId;
  pendingAction = null;
  resetHallZoom();
  document.getElementById("hall-sheet-title").textContent = `Hall ${hall.number}`;
  document.getElementById("hall-sheet-sub").textContent = hall.category;
  document.getElementById("hall-sheet").classList.add("open");

  const levels = HALLPLAN_LEVELS[hallId];
  const switcher = document.getElementById("hall-level-switcher");
  if (levels) {
    document.getElementById("hall-hint").textContent = "Tap Add loot, then tap a booth (or the floor)";
    switcher.style.display = levels.length > 1 ? "flex" : "none";
    renderLevelSwitcherButtons(hallId, levels);
    await openHallLevel(hallId, levels[0].file);
  } else {
    document.getElementById("hall-hint").textContent = "Tap Add loot, then tap the floor to drop a pin";
    switcher.style.display = "none";
    currentHallLevel = null;
    document.getElementById("hall-plan-svg").innerHTML = "";
    renderHallPins();
  }
  positionMeDot();
}

async function openHallLevel(hallId, fileId) {
  updateLevelSwitcherActive(fileId);
  resetHallZoom(); // switching floors resets the view -- the old zoom/pan has no reason to still make sense on a different level's own layout
  try {
    await renderRealHallPlan(hallId, fileId);
  } catch (e) {
    toast("Real floor plan unavailable -- using free placement", true);
    currentHallLevel = null;
    document.getElementById("hall-plan-svg").innerHTML = "";
  }
  renderHallPins();
}

function renderLevelSwitcherButtons(hallId, levels) {
  const switcher = document.getElementById("hall-level-switcher");
  switcher.innerHTML = "";
  for (const lvl of levels) {
    const btn = document.createElement("button");
    btn.className = "level-btn";
    btn.textContent = lvl.label;
    btn.dataset.file = lvl.file;
    btn.addEventListener("click", () => openHallLevel(hallId, lvl.file));
    switcher.appendChild(btn);
  }
}
function updateLevelSwitcherActive(fileId) {
  document.querySelectorAll("#hall-level-switcher .level-btn").forEach((b) => b.classList.toggle("active", b.dataset.file === fileId));
}

function closeHall() {
  document.getElementById("hall-sheet").classList.remove("open");
  openHallId = null;
  pendingAction = null;
}

function renderHallPins(newId) {
  const inner = document.getElementById("hall-canvas-inner");
  [...inner.querySelectorAll(".hall-pin")].forEach((el) => el.remove());
  const entries = lootForHall(openHallId);

  let nearestId = null;
  if (tracking && me) {
    let best = Infinity;
    for (const e of entries) {
      const d = Math.hypot(e.pin_x - me.x, e.pin_y - me.y);
      if (d < best) { best = d; nearestId = e.id; }
    }
  }

  for (const entry of entries) {
    const pin = document.createElement("div");
    pin.className = "hall-pin" + (entry.status !== "active" ? " hidden-entry" : "") + (entry.id === newId ? " new-pin" : "") + (entry.id === nearestId ? " nearest" : "");
    pin.style.left = `${entry.pin_x * 100}%`;
    pin.style.top = `${entry.pin_y * 100}%`;
    pin.innerHTML = `<div class="pin-glow"></div>${icon("pin")}`;
    pin.style.color = entry.quality_count ? goldForRating(entry.avg_quality) : "#fff";
    pin.addEventListener("click", (e) => { e.stopPropagation(); openLoot(entry.id); });
    inner.appendChild(pin);
  }
}

function goldForRating(avg) {
  if (avg == null) return "#ffffff";
  if (avg >= 4) return "#ffd23f";
  if (avg >= 2.5) return "#22e6ff";
  return "#ff2ecb";
}

// Real bug found live: with a real plan loaded, #hall-plan-svg uses
// preserveAspectRatio="xMidYMid meet", which can letterbox the SVG's
// content inside #hall-canvas-inner's own box whenever their aspect
// ratios don't match -- a plain click-fraction-of-container calculation
// would then land off the real floor plan by however much letterboxing is
// happening. getScreenCTM().inverse() asks the SVG itself where a screen
// point falls in its own user-space (viewBox/metre) coordinates, which is
// correct regardless of letterboxing. Falls back to the simple
// container-fraction math for a schematic-only hall (no SVG plan drawn
// under it at all, so there's no letterboxing question to begin with).
function clickToNormalizedPosition(e) {
  if (currentHallLevel) {
    const svg = document.getElementById("hall-plan-svg");
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: clamp01(svgPt.x / currentHallLevel.extent.w), y: clamp01(svgPt.y / currentHallLevel.extent.h) };
  }
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
}

// ---------------------------------------------------------------------------
// Pinch-zoom + pan on the hall canvas -- real usability gap found live: a
// dense real hall (100+ booths, confirmed against the actual vendored
// data) crammed into one fixed-size viewport makes individual booths too
// small to read or tap precisely on a phone, screenshots included. A
// single CSS transform on #hall-canvas-inner moves BOTH the SVG floor
// plan and the absolutely-positioned loot pins together (they're both its
// children), so this needs no changes to how either renders -- and
// clickToNormalizedPosition already resolves taps through the SVG's own
// getScreenCTM(), which reflects whatever transform is actually on
// screen, so tap-to-place-pin and booth taps stay correct at any zoom/pan
// with no changes there either.
// ---------------------------------------------------------------------------

const HALL_ZOOM_MIN = 1;
const HALL_ZOOM_MAX = 5;
let hallZoom = { scale: 1, x: 0, y: 0 };
let hallGesture = null; // active pointer/touch gesture state, or null

function applyHallTransform() {
  const inner = document.getElementById("hall-canvas-inner");
  inner.style.transform = `translate(${hallZoom.x}px, ${hallZoom.y}px) scale(${hallZoom.scale})`;
  document.getElementById("hall-zoom-reset").classList.toggle("show", hallZoom.scale > 1.02);
}

function resetHallZoom() {
  hallZoom = { scale: 1, x: 0, y: 0 };
  applyHallTransform();
}

function clampHallPan() {
  const wrap = document.getElementById("hall-canvas-wrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  // How far content can drift before empty space would show past the
  // wrap's own edge, at the current scale.
  const maxX = Math.max(0, (hallZoom.scale - 1) * w);
  const maxY = Math.max(0, (hallZoom.scale - 1) * h);
  hallZoom.x = Math.min(0, Math.max(-maxX, hallZoom.x));
  hallZoom.y = Math.min(0, Math.max(-maxY, hallZoom.y));
}

// Zooms so the point under (screenX, screenY) stays visually fixed --
// standard "zoom toward cursor/pinch center" feel, not zoom-from-corner.
function zoomHallAt(screenX, screenY, newScale) {
  const wrap = document.getElementById("hall-canvas-wrap");
  const rect = wrap.getBoundingClientRect();
  const localX = screenX - rect.left;
  const localY = screenY - rect.top;
  const clamped = Math.max(HALL_ZOOM_MIN, Math.min(HALL_ZOOM_MAX, newScale));
  const ratio = clamped / hallZoom.scale;
  hallZoom.x = localX - (localX - hallZoom.x) * ratio;
  hallZoom.y = localY - (localY - hallZoom.y) * ratio;
  hallZoom.scale = clamped;
  clampHallPan();
  applyHallTransform();
}

document.getElementById("hall-canvas-wrap").addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomHallAt(e.clientX, e.clientY, hallZoom.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18));
}, { passive: false });

function touchDist(t0, t1) {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}
function touchMid(t0, t1) {
  return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
}

const HALL_WRAP = document.getElementById("hall-canvas-wrap");

HALL_WRAP.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    hallGesture = {
      mode: "pinch",
      startDist: touchDist(e.touches[0], e.touches[1]),
      startScale: hallZoom.scale,
      moved: true,
    };
  } else if (e.touches.length === 1) {
    hallGesture = {
      mode: "pan",
      startX: e.touches[0].clientX, startY: e.touches[0].clientY,
      originX: hallZoom.x, originY: hallZoom.y,
      moved: false,
    };
  }
}, { passive: true });

HALL_WRAP.addEventListener("touchmove", (e) => {
  if (!hallGesture) return;
  if (hallGesture.mode === "pinch" && e.touches.length === 2) {
    e.preventDefault();
    const dist = touchDist(e.touches[0], e.touches[1]);
    const mid = touchMid(e.touches[0], e.touches[1]);
    zoomHallAt(mid.x, mid.y, hallGesture.startScale * (dist / hallGesture.startDist));
  } else if (hallGesture.mode === "pan" && e.touches.length === 1) {
    const dx = e.touches[0].clientX - hallGesture.startX;
    const dy = e.touches[0].clientY - hallGesture.startY;
    if (Math.hypot(dx, dy) > 6) hallGesture.moved = true;
    if (hallZoom.scale > 1.02 && hallGesture.moved) {
      e.preventDefault();
      hallZoom.x = hallGesture.originX + dx;
      hallZoom.y = hallGesture.originY + dy;
      clampHallPan();
      applyHallTransform();
    }
  }
}, { passive: false });

HALL_WRAP.addEventListener("touchend", () => {
  // A real drag (moved past the threshold) must not also register as a
  // tap-to-place-pin/tap-to-track on the click event that follows a touch
  // sequence -- suppressHallClick consumes exactly one click for that.
  if (hallGesture && hallGesture.moved && hallGesture.mode === "pan") suppressHallClick = true;
  hallGesture = null;
});

// Desktop mouse-drag pan -- same drag-vs-click distinction as touch above,
// via the mousedown/mousemove/mouseup sequence instead of touch events.
let mouseDragState = null;
HALL_WRAP.addEventListener("mousedown", (e) => {
  mouseDragState = { startX: e.clientX, startY: e.clientY, originX: hallZoom.x, originY: hallZoom.y, moved: false };
});
window.addEventListener("mousemove", (e) => {
  if (!mouseDragState) return;
  const dx = e.clientX - mouseDragState.startX;
  const dy = e.clientY - mouseDragState.startY;
  if (Math.hypot(dx, dy) > 6) mouseDragState.moved = true;
  if (hallZoom.scale > 1.02 && mouseDragState.moved) {
    hallZoom.x = mouseDragState.originX + dx;
    hallZoom.y = mouseDragState.originY + dy;
    clampHallPan();
    applyHallTransform();
  }
});
window.addEventListener("mouseup", () => {
  if (mouseDragState && mouseDragState.moved) suppressHallClick = true;
  mouseDragState = null;
});

document.getElementById("hall-zoom-reset").addEventListener("click", resetHallZoom);

let suppressHallClick = false;

document.getElementById("hall-canvas-inner").addEventListener("click", (e) => {
  if (suppressHallClick) { suppressHallClick = false; return; }
  if (pendingAction === "placing-loot") {
    pendingPin = clickToNormalizedPosition(e);
    pendingAction = null;
    document.getElementById("hall-hint").textContent = currentHallLevel
      ? "Tap Add loot, then tap a booth (or the floor)"
      : "Tap Add loot, then tap the floor to drop a pin";
    openAddSheet();
  } else if (tracking) {
    const pos = clickToNormalizedPosition(e);
    setMePosition(pos.x, pos.y);
  }
});

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

document.getElementById("hall-add-btn").addEventListener("click", () => {
  pendingAction = "placing-loot";
  document.getElementById("hall-hint").textContent = "Tap the floor where the loot is";
});

document.getElementById("hall-sheet-back").addEventListener("click", closeHall);

// ---------------------------------------------------------------------------
// Loot detail sheet
// ---------------------------------------------------------------------------

function openLoot(id) {
  const entry = lootById.get(id);
  if (!entry) return;
  openLootId = id;
  renderLootSheet(entry);
  document.getElementById("loot-sheet").classList.add("open");
}

function closeLoot() {
  document.getElementById("loot-sheet").classList.remove("open");
  openLootId = null;
}
document.getElementById("loot-sheet-back").addEventListener("click", closeLoot);

function renderLootSheet(entry) {
  const hall = hallById(entry.hall_id);
  const body = document.getElementById("loot-sheet-body");
  const items = entry.items.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  const validityGood = entry.confirm_count > entry.dispute_count;
  const validityKnown = entry.confirm_count + entry.dispute_count > 0;

  body.innerHTML = `
    ${entry.has_photo ? `<img class="loot-photo" src="${API_BASE}/loot/${entry.id}/photo" alt="" />` : ""}
    <div class="loot-title">${escapeHtml(entry.company_name)}</div>
    <div class="loot-meta">Hall ${hall ? hall.number : "?"} &middot; Booth ${escapeHtml(entry.booth_no)}${entry.submitted_by ? ` &middot; found by ${escapeHtml(entry.submitted_by)}` : ""}</div>
    <div class="chip-row">${items.map((i) => `<span class="chip">${escapeHtml(i)}</span>`).join("")}</div>

    <div class="field">
      <label>Quality rating</label>
      <div class="stars-row" id="stars-row"></div>
      <div class="field-hint">${entry.quality_count ? `${entry.avg_quality} avg from ${entry.quality_count} rating${entry.quality_count === 1 ? "" : "s"}` : "No ratings yet -- be first"}</div>
    </div>

    <div class="validity-row">
      <button class="validity-btn confirm" id="btn-confirm">${icon("check")} Still here (${entry.confirm_count})</button>
      <button class="validity-btn dispute" id="btn-dispute">${icon("flag")} Wrong / gone (${entry.dispute_count})</button>
    </div>
    <span class="validity-badge ${validityGood ? "good" : "unverified"}">${validityKnown ? (validityGood ? "Crowd-confirmed" : "Disputed") : "Unverified"}</span>
  `;

  const starsRow = document.getElementById("stars-row");
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button");
    btn.className = "star-btn" + (entry.avg_quality != null && i <= Math.round(entry.avg_quality) ? " filled" : "");
    btn.innerHTML = icon("star");
    btn.addEventListener("click", () => rateLoot(entry.id, i));
    starsRow.appendChild(btn);
  }

  document.getElementById("btn-confirm").addEventListener("click", () => voteLoot(entry.id, "confirm"));
  document.getElementById("btn-dispute").addEventListener("click", () => voteLoot(entry.id, "dispute"));
}

async function voteLoot(id, voteType) {
  try {
    const updated = await apiPostJson(`/loot/${id}/vote`, { vote_type: voteType });
    applyUpdate(updated);
    toast(voteType === "confirm" ? "Marked as still here" : "Flagged as wrong or gone");
  } catch (e) {
    toast(e.message, true);
  }
}

async function rateLoot(id, stars) {
  try {
    const updated = await apiPostJson(`/loot/${id}/rate`, { stars });
    applyUpdate(updated);
    toast(`Rated ${stars} star${stars === 1 ? "" : "s"}`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------------------
// Add loot sheet
// ---------------------------------------------------------------------------

let selectedPhotoBlob = null;

function openAddSheet(prefill) {
  const hall = hallById(openHallId);
  document.getElementById("form-hall-display").value = hall ? `Hall ${hall.number} -- ${hall.category}` : "";
  document.getElementById("form-booth").value = (prefill && prefill.booth) || "";
  document.getElementById("form-company").value = (prefill && prefill.company) || "";
  document.getElementById("form-items").value = "";
  document.getElementById("form-name").value = localStorage.getItem("lr_display_name") || "";
  document.getElementById("photo-picker-text").style.display = "";
  const preview = document.getElementById("photo-picker").querySelector("img");
  if (preview) preview.remove();
  document.getElementById("form-photo").value = "";
  selectedPhotoBlob = null;
  // Real-plan halls prefill booth/company straight from the tapped booth's
  // own official data (see onBoothTap) -- worth telling the user so they
  // trust it's not a guess, and know to double-check/correct it if the
  // booth's real occupant differs from what's on file.
  document.getElementById("form-pin-hint").textContent = prefill && prefill.booth
    ? "Booth number and company pre-filled from the official floor plan -- edit if it's wrong."
    : "Pin placed at the spot you tapped on the hall map.";
  document.getElementById("add-sheet").classList.add("open");
}

function closeAddSheet() {
  document.getElementById("add-sheet").classList.remove("open");
}
document.getElementById("add-sheet-back").addEventListener("click", closeAddSheet);
document.getElementById("add-cancel").addEventListener("click", closeAddSheet);

document.getElementById("btn-add-global").addEventListener("click", () => {
  if (!openHallId) {
    toast("Pick a hall on the map first, then tap Add loot");
    switchView("map");
    return;
  }
  pendingAction = "placing-loot";
  document.getElementById("hall-hint").textContent = "Tap the floor where the loot is";
});

document.getElementById("form-photo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    selectedPhotoBlob = await resizeImageToBlob(file, 900, 0.72);
    const picker = document.getElementById("photo-picker");
    const existing = picker.querySelector("img");
    if (existing) existing.remove();
    const img = document.createElement("img");
    img.src = URL.createObjectURL(selectedPhotoBlob);
    picker.insertBefore(img, picker.firstChild);
    document.getElementById("photo-picker-text").style.display = "none";
  } catch (err) {
    toast("Could not read that photo", true);
  }
});

function resizeImageToBlob(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/jpeg", quality);
    };
    img.onerror = reject;
    img.src = url;
  });
}

document.getElementById("add-submit").addEventListener("click", async () => {
  const booth = document.getElementById("form-booth").value.trim();
  const company = document.getElementById("form-company").value.trim();
  const items = document.getElementById("form-items").value.trim();
  const name = document.getElementById("form-name").value.trim();
  if (!openHallId || !pendingPin) { toast("Tap a spot on the hall map first", true); return; }
  if (!booth || !company || !items) { toast("Booth, company, and items are required", true); return; }

  const btn = document.getElementById("add-submit");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting';
  try {
    if (name) localStorage.setItem("lr_display_name", name);
    const entry = await apiCreateLoot(
      { hall_id: openHallId, booth_no: booth, company_name: company, items, pin_x: pendingPin.x, pin_y: pendingPin.y, submitted_by: name },
      selectedPhotoBlob
    );
    lootById.set(entry.id, entry);
    closeAddSheet();
    renderHallPins(entry.id);
    renderVenueMap();
    toast("Loot added to the map");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Submit loot";
    pendingPin = null;
  }
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

document.querySelectorAll(".lb-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    leaderboardTab = tab.dataset.tab;
    document.querySelectorAll(".lb-tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderLeaderboardList();
  });
});

async function loadLeaderboard() {
  try {
    leaderboardCache = await apiGet("/leaderboard");
    renderLeaderboardList();
  } catch (e) {
    toast("Could not load leaderboard", true);
  }
}

function renderLeaderboardList() {
  const list = document.getElementById("leaderboard-list");
  if (!leaderboardCache) { list.innerHTML = ""; return; }
  const rows = leaderboardCache[leaderboardTab] || [];
  if (!rows.length) {
    list.innerHTML = `<div class="empty-state">${icon("trophy")}<span>No entries yet -- go find some loot</span></div>`;
    return;
  }
  const rankClass = (i) => (i === 0 ? " r1" : i === 1 ? " r2" : i === 2 ? " r3" : "");

  if (leaderboardTab === "top_loot") {
    list.innerHTML = rows.map((r, i) => {
      const hall = hallById(r.hall_id);
      return `<div class="lb-card" data-id="${r.id}">
        <div class="lb-rank${rankClass(i)}">${i + 1}</div>
        <div class="lb-info">
          <div class="lb-title">${escapeHtml(r.company_name)}</div>
          <div class="lb-sub">Hall ${hall ? hall.number : "?"} &middot; Booth ${escapeHtml(r.booth_no)}</div>
        </div>
        <div class="lb-score">${icon("star")}${r.avg_quality}</div>
      </div>`;
    }).join("");
    list.querySelectorAll(".lb-card").forEach((card) => {
      card.addEventListener("click", () => {
        const id = Number(card.dataset.id);
        const entry = lootById.get(id);
        if (entry) { openHall(entry.hall_id); openLoot(id); }
      });
    });
  } else if (leaderboardTab === "top_halls") {
    list.innerHTML = rows.map((r, i) => {
      const hall = hallById(r.hall_id);
      return `<div class="lb-card" data-hall="${r.hall_id}">
        <div class="lb-rank${rankClass(i)}">${i + 1}</div>
        <div class="lb-info">
          <div class="lb-title">Hall ${hall ? hall.number : r.hall_id} -- ${hall ? escapeHtml(hall.category) : ""}</div>
          <div class="lb-sub">${r.loot_count} loot report${r.loot_count === 1 ? "" : "s"}</div>
        </div>
        <div class="lb-score">${icon("chest")}${r.loot_count}</div>
      </div>`;
    }).join("");
    list.querySelectorAll(".lb-card").forEach((card) => card.addEventListener("click", () => openHall(card.dataset.hall)));
  } else {
    list.innerHTML = rows.map((r, i) => `<div class="lb-card">
        <div class="lb-rank${rankClass(i)}">${i + 1}</div>
        <div class="lb-info">
          <div class="lb-title">${escapeHtml(r.name)}</div>
          <div class="lb-sub">${r.loot_count} loot report${r.loot_count === 1 ? "" : "s"}</div>
        </div>
        <div class="lb-score">${icon("trophy")}</div>
      </div>`).join("");
  }
}

// ---------------------------------------------------------------------------
// Bottom nav / view switching
// ---------------------------------------------------------------------------

function switchView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".nav-btn[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "leaderboard") loadLeaderboard();
}
document.querySelectorAll(".nav-btn[data-view]").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searchTimer = null;
document.getElementById("search-input").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  document.getElementById("search-clear").classList.toggle("show", q.length > 0);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(q), 150);
});
document.getElementById("search-clear").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear").classList.remove("show");
  renderVenueMap();
});

function runSearch(q) {
  if (!q) { renderVenueMap(); return; }
  const needle = q.toLowerCase();
  const matches = [...lootById.values()].filter(
    (l) => l.status === "active" && (l.company_name.toLowerCase().includes(needle) || l.items.toLowerCase().includes(needle))
  );
  const matchHalls = new Set(matches.map((m) => m.hall_id));
  document.querySelectorAll(".hall-rect").forEach((rect) => {
    // best-effort dim non-matching halls -- rect elements aren't keyed by
    // hall id directly, so this recomputes from stored fill color; simplest
    // robust approach is a full re-render pass instead.
  });
  renderVenueMap();
  const svg = document.getElementById("venue-svg");
  [...svg.querySelectorAll("g")].forEach((g, i) => {
    const hall = HALLS[i];
    if (!hall) return;
    g.style.opacity = matchHalls.size === 0 || matchHalls.has(hall.id) ? "1" : "0.25";
  });
  if (matches.length === 1) {
    toast(`Found in Hall ${hallById(matches[0].hall_id)?.number}`);
  }
}

// ---------------------------------------------------------------------------
// Live updates (SSE)
// ---------------------------------------------------------------------------

function applyUpdate(entry) {
  lootById.set(entry.id, entry);
  if (openHallId === entry.hall_id) renderHallPins();
  if (openLootId === entry.id) renderLootSheet(entry);
  renderVenueMap();
}

function connectEvents() {
  // The SSE stream is shared across every event on the backend (one
  // process, one broadcaster -- see main.py's own _subscribers set); every
  // payload carries its own event_id, and a client filters out anything
  // that isn't for the event it's actually showing rather than relying on
  // the server to split subscribers by event. Simpler and correct even
  // before a second event exists to actually need the filter.
  const es = new EventSource(`${API_BASE}/events?event_id=${EVENT_ID}`);
  es.addEventListener("loot.created", (e) => {
    const entry = JSON.parse(e.data);
    if (entry.event_id && entry.event_id !== EVENT_ID) return;
    lootById.set(entry.id, entry);
    if (openHallId === entry.hall_id) renderHallPins(entry.id);
    renderVenueMap();
    toast(`New loot: ${entry.company_name}`);
  });
  es.addEventListener("loot.updated", (e) => {
    const entry = JSON.parse(e.data);
    if (entry.event_id && entry.event_id !== EVENT_ID) return;
    applyUpdate(entry);
  });
  es.onerror = () => {
    // EventSource auto-reconnects on its own; nothing to do here beyond
    // not crashing the rest of the app if the venue wifi hiccups.
  };
}

// ---------------------------------------------------------------------------
// Position tracking -- see the project's own design notes: real GPS mostly
// doesn't work inside a steel-structure hall, so this is intentionally NOT
// claiming cm-precision indoor GPS. Three honest, real signals combined:
//   1. Manual tap-to-set position on the open hall's canvas (instant, exact).
//   2. Device motion (accelerometer step-detection) nudges the dot forward
//      in the current heading between manual corrections -- real movement
//      feedback, will drift over time like any dead-reckoning approach.
//   3. Device compass heading rotates the dot's direction arrow.
//   4. Real navigator.geolocation (GPS/WiFi/cell fusion, whatever the OS
//      gives the browser) reported honestly as an accuracy figure -- useful
//      outdoors/between halls, not asserted as hall-interior precision.
// ---------------------------------------------------------------------------

let tracking = false;
let me = null; // {x, y} normalized within the currently open hall's canvas
let heading = 0; // degrees, 0 = up
let geoWatchId = null;
let motionBaseline = null;
let lastStepAt = 0;

async function toggleTracking() {
  if (tracking) {
    stopTracking();
    return;
  }
  tracking = true;
  document.getElementById("btn-track-me").classList.add("on");
  if (!me && openHallId) me = { x: 0.5, y: 0.5 };
  positionMeDot();
  toast("Position tracking on -- tap the floor to set your spot");

  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
    try { await DeviceOrientationEvent.requestPermission(); } catch (_) { /* denied -- heading just won't update */ }
  }
  window.addEventListener("deviceorientation", onOrientation);
  window.addEventListener("devicemotion", onMotion);

  if (navigator.geolocation) {
    geoWatchId = navigator.geolocation.watchPosition(onGeo, onGeoError, { enableHighAccuracy: true, maximumAge: 4000 });
  }
}

function stopTracking() {
  tracking = false;
  document.getElementById("btn-track-me").classList.remove("on");
  document.getElementById("me-dot").classList.remove("show");
  document.getElementById("hall-accuracy").classList.remove("show");
  window.removeEventListener("deviceorientation", onOrientation);
  window.removeEventListener("devicemotion", onMotion);
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = null;
}

document.getElementById("btn-track-me").innerHTML = icon("radar");
document.getElementById("btn-track-me").addEventListener("click", toggleTracking);
document.getElementById("btn-refresh").innerHTML = icon("refresh");
document.getElementById("btn-refresh").addEventListener("click", refreshAll);

// ---------------------------------------------------------------------------
// Account -- Google/GitHub sign-in (backend/auth.py). A full-page redirect
// to the provider, not a fetch -- that's the actual OAuth flow, there's no
// way to do it as a background request. return_to brings the visitor back
// to exactly where they were; device_id rides along in the login URL so
// the backend can retroactively link this browser's past anonymous
// activity to whichever account it comes back signed in as.
// ---------------------------------------------------------------------------

let currentUser = null;
let availableProviders = { google: false, github: false };

async function loadMe() {
  try {
    const res = await fetch(`${API_BASE}/auth/me`);
    const data = await res.json();
    currentUser = data.user;
  } catch (e) {
    currentUser = null;
  }
  updateAccountButton();
}

async function loadProviders() {
  try {
    availableProviders = await (await fetch(`${API_BASE}/auth/providers`)).json();
  } catch (e) {
    // Sign-in buttons just stay hidden -- see renderAccountSheet's own
    // "neither provider configured" fallback.
  }
}

function updateAccountButton() {
  const btn = document.getElementById("btn-account");
  if (currentUser && currentUser.avatar_url) {
    btn.innerHTML = `<img src="${escapeHtml(currentUser.avatar_url)}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;" alt="" />`;
  } else {
    btn.innerHTML = icon("user");
  }
  btn.classList.toggle("on", !!currentUser);
}

function signInWith(provider) {
  const returnTo = window.location.pathname + window.location.search;
  window.location.href = `${API_BASE}/auth/${provider}/login?device_id=${encodeURIComponent(deviceId())}&return_to=${encodeURIComponent(returnTo)}`;
}

async function signOut() {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST" });
  } catch (e) { /* cookie may already be gone -- treat as signed out either way */ }
  currentUser = null;
  updateAccountButton();
  renderAccountSheet();
  toast("Signed out");
}

async function renderAccountSheet() {
  const body = document.getElementById("account-sheet-body");
  if (!currentUser) {
    const anyProvider = availableProviders.google || availableProviders.github;
    body.innerHTML = `
      <div class="signin-intro">
        ${icon("user")}
        <h3>Track your own finds</h3>
        <p>Sign in to keep your loot history and scout name with you across devices.</p>
      </div>
      ${availableProviders.google ? `<button class="oauth-btn" id="btn-signin-google">${icon("google")}Continue with Google</button>` : ""}
      ${availableProviders.github ? `<button class="oauth-btn" id="btn-signin-github">${icon("github")}Continue with GitHub</button>` : ""}
      ${!anyProvider ? `<div class="oauth-unavailable-note">Sign-in is being set up -- check back soon.</div>` : ""}
    `;
    const gBtn = document.getElementById("btn-signin-google");
    if (gBtn) gBtn.addEventListener("click", () => signInWith("google"));
    const hBtn = document.getElementById("btn-signin-github");
    if (hBtn) hBtn.addEventListener("click", () => signInWith("github"));
    return;
  }

  const avatar = currentUser.avatar_url
    ? `<img class="profile-avatar" src="${escapeHtml(currentUser.avatar_url)}" alt="" />`
    : `<div class="profile-avatar profile-avatar-fallback">${icon("user")}</div>`;
  body.innerHTML = `
    <div class="profile-header">
      ${avatar}
      <div>
        <div class="profile-name">${escapeHtml(currentUser.display_name || "Scout")}</div>
        ${currentUser.email ? `<div class="profile-email">${escapeHtml(currentUser.email)}</div>` : ""}
      </div>
    </div>
    <div class="my-loot-section-title">My loot finds</div>
    <div id="my-loot-list"><div class="empty-state">${icon("chest")}<span>Loading...</span></div></div>
    <button class="btn btn-ghost" id="btn-signout" style="width:100%;margin-top:1.2rem">${icon("logout")} Sign out</button>
  `;
  document.getElementById("btn-signout").addEventListener("click", signOut);
  loadMyLoot();
}

async function loadMyLoot() {
  const list = document.getElementById("my-loot-list");
  if (!list) return;
  try {
    const rows = await apiGet("/my/loot");
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state">${icon("chest")}<span>Nothing reported yet -- go find some loot.</span></div>`;
      return;
    }
    list.innerHTML = rows.map((l) => {
      const hall = hallById(l.hall_id);
      const thumb = l.has_photo
        ? `<img class="booth-loot-thumb" src="${API_BASE}/loot/${l.id}/photo" alt="" />`
        : `<div class="booth-loot-thumb"></div>`;
      return `<div class="booth-loot-card" data-id="${l.id}">
        ${thumb}
        <div class="booth-loot-info">
          <div class="booth-loot-title">${escapeHtml(l.company_name)}</div>
          <div class="booth-loot-sub">Hall ${hall ? hall.number : "?"} &middot; Booth ${escapeHtml(l.booth_no)}</div>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll(".booth-loot-card").forEach((card) => {
      card.addEventListener("click", () => {
        const entry = lootById.get(Number(card.dataset.id));
        if (entry) { closeAccountSheet(); openHall(entry.hall_id); openLoot(entry.id); }
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state">${icon("chest")}<span>Could not load your loot right now.</span></div>`;
  }
}

function openAccountSheet() {
  document.getElementById("account-sheet").classList.add("open");
  renderAccountSheet();
}
function closeAccountSheet() {
  document.getElementById("account-sheet").classList.remove("open");
}
document.getElementById("btn-account").innerHTML = icon("user");
document.getElementById("btn-account").addEventListener("click", openAccountSheet);
document.getElementById("account-sheet-back").addEventListener("click", closeAccountSheet);

function onOrientation(e) {
  const h = e.webkitCompassHeading != null ? e.webkitCompassHeading : (e.alpha != null ? 360 - e.alpha : null);
  if (h == null) return;
  heading = h;
  document.documentElement.style.setProperty("--heading-live", `${h}deg`);
  const dot = document.getElementById("me-dot");
  const arrow = dot.querySelector(".me-dot-heading");
  if (arrow) arrow.style.setProperty("--heading", `${h}deg`);
}

function onMotion(e) {
  const acc = e.accelerationIncludingGravity;
  if (!acc) return;
  const mag = Math.sqrt((acc.x || 0) ** 2 + (acc.y || 0) ** 2 + (acc.z || 0) ** 2);
  if (motionBaseline == null) { motionBaseline = mag; return; }
  motionBaseline = motionBaseline * 0.9 + mag * 0.1; // slow-moving baseline (gravity + walking cadence)
  const now = Date.now();
  if (Math.abs(mag - motionBaseline) > 3.2 && now - lastStepAt > 320) {
    lastStepAt = now;
    stepNudge();
  }
}

function stepNudge() {
  if (!me || !openHallId) return;
  const rad = (heading * Math.PI) / 180;
  const stepSize = 0.012; // normalized canvas units per detected step -- tuned for "visible motion", not measured distance
  me.x = clamp01(me.x + Math.sin(rad) * stepSize);
  me.y = clamp01(me.y - Math.cos(rad) * stepSize);
  positionMeDot();
  renderHallPins();
}

function onGeo(pos) {
  const acc = Math.round(pos.coords.accuracy);
  const pill = document.getElementById("hall-accuracy");
  pill.textContent = `GPS ~${acc}m`;
  pill.classList.add("show");
}

function onGeoError() {
  const pill = document.getElementById("hall-accuracy");
  pill.textContent = "GPS unavailable indoors";
  pill.classList.add("show");
}

function setMePosition(x, y) {
  me = { x, y };
  positionMeDot();
  renderHallPins();
}

function positionMeDot() {
  const dot = document.getElementById("me-dot");
  if (!tracking || !me || !openHallId) { dot.classList.remove("show"); return; }
  dot.classList.add("show");
  dot.style.left = `${me.x * 100}%`;
  dot.style.top = `${me.y * 100}%`;
  const arrow = dot.querySelector(".me-dot-heading");
  if (arrow) arrow.style.setProperty("--heading", `${heading}deg`);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function refreshAll() {
  try {
    const [halls, list] = await Promise.all([Promise.resolve(HALLS), apiGet("/loot")]);
    lootById = new Map(list.map((l) => [l.id, l]));
    renderVenueMap();
    if (openHallId) renderHallPins();
  } catch (e) {
    toast("Could not reach loot-radar -- retrying", true);
  }
}

(async function init() {
  renderLegend();
  try {
    await loadHallplanIndex();
  } catch (e) {
    // Real hall sizes just fall back to isoHeightForHall's own defaults --
    // the venue map still renders fine, blocks are just less proportional.
  }
  renderVenueMap();
  await refreshAll();
  connectEvents();
  loadMe();
  loadProviders();
})();
