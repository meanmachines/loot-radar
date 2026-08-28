"use strict";

// ---------------------------------------------------------------------------
// loot-radar frontend -- vanilla JS, no build step (same philosophy as
// zBots' own frontend: fast to serve, nothing to break in a build
// pipeline on a tight deadline). API_BASE is relative -- nginx proxies
// /api/* to the backend, same pattern as zBots' /bots-api/ prefix.
// ---------------------------------------------------------------------------

const API_BASE = "/api";

function deviceId() {
  let id = localStorage.getItem("lr_device_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/-/g, "");
    localStorage.setItem("lr_device_id", id);
  }
  return id;
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path);
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
  const qs = new URLSearchParams(fields).toString();
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

function renderVenueMap() {
  const svg = document.getElementById("venue-svg");
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

    // Loot-count badge, top-right corner of the hall rect -- pulses when
    // the hall has any active entries so a scan of the whole venue shows
    // where loot has been reported at a glance.
    const count = hallLootCount(hall.id);
    if (count > 0) {
      const bx = hall.rect.x + hall.rect.w - 6;
      const by = hall.rect.y + 6;
      const ping = svgEl("circle", { cx: bx, cy: by, r: 14, class: "hall-badge-ping animate", stroke: hall.color });
      g.appendChild(ping);
      const bg = svgEl("circle", { cx: bx, cy: by, r: 14, class: "hall-badge-bg", stroke: hall.color });
      g.appendChild(bg);
      const countText = svgEl("text", { x: bx, y: by + 1, class: "hall-badge-count" });
      countText.textContent = String(count);
      g.appendChild(countText);
    }

    svg.appendChild(g);
  }

  for (const ent of ENTRANCES) {
    const t = svgEl("text", { x: ent.x, y: ent.y, class: "entrance-label" });
    t.textContent = ent.label + " entrance";
    svg.appendChild(t);
  }
}

function renderLegend() {
  const strip = document.getElementById("legend-strip");
  const seen = new Map();
  for (const h of HALLS) if (!seen.has(h.category)) seen.set(h.category, h.color);
  strip.innerHTML = [...seen.entries()]
    .map(([cat, color]) => `<div class="legend-chip"><span class="swatch" style="background:${color}"></span>${escapeHtml(cat)}</div>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Hall detail sheet
// ---------------------------------------------------------------------------

function openHall(hallId) {
  const hall = hallById(hallId);
  if (!hall) return;
  openHallId = hallId;
  pendingAction = null;
  document.getElementById("hall-sheet-title").textContent = `Hall ${hall.number}`;
  document.getElementById("hall-sheet-sub").textContent = hall.category;
  document.getElementById("hall-hint").textContent = "Tap Add loot, then tap the floor to drop a pin";
  document.getElementById("hall-sheet").classList.add("open");
  renderHallPins();
  positionMeDot();
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

document.getElementById("hall-canvas-inner").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (pendingAction === "placing-loot") {
    pendingPin = { x: clamp01(x), y: clamp01(y) };
    pendingAction = null;
    document.getElementById("hall-hint").textContent = "Tap Add loot, then tap the floor to drop a pin";
    openAddSheet();
  } else if (tracking) {
    setMePosition(clamp01(x), clamp01(y));
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

function openAddSheet() {
  const hall = hallById(openHallId);
  document.getElementById("form-hall-display").value = hall ? `Hall ${hall.number} -- ${hall.category}` : "";
  document.getElementById("form-booth").value = "";
  document.getElementById("form-company").value = "";
  document.getElementById("form-items").value = "";
  document.getElementById("form-name").value = localStorage.getItem("lr_display_name") || "";
  document.getElementById("photo-picker-text").style.display = "";
  const preview = document.getElementById("photo-picker").querySelector("img");
  if (preview) preview.remove();
  document.getElementById("form-photo").value = "";
  selectedPhotoBlob = null;
  document.getElementById("form-pin-hint").textContent = "Pin placed at the spot you tapped on the hall map.";
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
  const es = new EventSource(`${API_BASE}/events`);
  es.addEventListener("loot.created", (e) => {
    const entry = JSON.parse(e.data);
    lootById.set(entry.id, entry);
    if (openHallId === entry.hall_id) renderHallPins(entry.id);
    renderVenueMap();
    toast(`New loot: ${entry.company_name}`);
  });
  es.addEventListener("loot.updated", (e) => applyUpdate(JSON.parse(e.data)));
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
  renderVenueMap();
  await refreshAll();
  connectEvents();
})();
