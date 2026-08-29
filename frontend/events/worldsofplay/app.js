"use strict";

// ---------------------------------------------------------------------------
// Lootemall -- Worlds of Play. Same backend/platform as gamescom2026 (see
// that event's own app.js for the full architecture notes: shared Postgres,
// event_id-scoped rows, one SSE broadcaster, same OAuth flow). This event's
// own frontend is deliberately much smaller: a single-venue exhibition has
// no hall map or floor plan to render, so this file skips every bit of
// gamescom2026's own isometric-venue/hall-canvas/pinch-zoom machinery and is
// just a loot feed + leaderboard + account sheet.
//
// hall_id/booth_no still exist on every loot row (shared schema with every
// other event) but are fixed constants here, never shown to the user --
// see events_registry.py's own note on why "main"/"General" specifically.
// ---------------------------------------------------------------------------

const API_BASE = "/api";
const EVENT_ID = "worldsofplay";
const FIXED_HALL_ID = "main";
const FIXED_BOOTH_NO = "General";

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
  const qs = new URLSearchParams({ ...fields, hall_id: FIXED_HALL_ID, booth_no: FIXED_BOOTH_NO, event_id: EVENT_ID }).toString();
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

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lootById = new Map();
let openLootId = null;
let leaderboardTab = "top_loot";
let leaderboardCache = null;

// ---------------------------------------------------------------------------
// Loot feed
// ---------------------------------------------------------------------------

function goldForRating(avg) {
  if (avg == null) return null;
  if (avg >= 4) return "#ffd23f";
  if (avg >= 2.5) return "#22e6ff";
  return "#ff2ecb";
}

function renderLootFeed(filterQuery) {
  const feed = document.getElementById("loot-feed");
  let entries = [...lootById.values()].filter((l) => l.status === "active").sort((a, b) => b.created_at - a.created_at);
  if (filterQuery) {
    const needle = filterQuery.toLowerCase();
    entries = entries.filter((l) => l.company_name.toLowerCase().includes(needle) || l.items.toLowerCase().includes(needle));
  }
  if (!entries.length) {
    feed.innerHTML = `<div class="empty-state">${icon("chest")}<span>${filterQuery ? "No matches" : "No loot reported yet -- be the first."}</span></div>`;
    return;
  }
  feed.innerHTML = entries.map((l) => {
    const stars = l.avg_quality != null ? `${icon("star")} ${l.avg_quality}` : "Not rated yet";
    const thumb = l.has_photo
      ? `<img class="booth-loot-thumb" style="width:56px;height:56px" src="${API_BASE}/loot/${l.id}/photo" alt="" data-id="${l.id}" />`
      : `<div class="booth-loot-thumb" style="width:56px;height:56px" data-id="${l.id}"></div>`;
    const ratingColor = goldForRating(l.avg_quality);
    return `<div class="booth-loot-card" data-id="${l.id}"${ratingColor ? ` style="border-color:${ratingColor}"` : ""}>
      ${thumb}
      <div class="booth-loot-info">
        <div class="booth-loot-title">${escapeHtml(l.company_name)}</div>
        <div class="booth-loot-sub">${escapeHtml(l.items)}</div>
        <div class="booth-loot-sub">${stars}${l.submitted_by ? ` &middot; found by ${escapeHtml(l.submitted_by)}` : ""}</div>
      </div>
    </div>`;
  }).join("");
  feed.querySelectorAll(".booth-loot-card").forEach((card) => {
    card.addEventListener("click", () => openLoot(Number(card.dataset.id)));
  });
}

function runSearch(q) {
  renderLootFeed(q || null);
}

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
  renderLootFeed();
});

document.getElementById("btn-refresh").innerHTML = icon("refresh");
document.getElementById("btn-refresh").addEventListener("click", refreshAll);

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
  const body = document.getElementById("loot-sheet-body");
  const items = entry.items.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  const validityGood = entry.confirm_count > entry.dispute_count;
  const validityKnown = entry.confirm_count + entry.dispute_count > 0;

  body.innerHTML = `
    ${entry.has_photo ? `<img class="loot-photo" src="${API_BASE}/loot/${entry.id}/photo" alt="" />` : ""}
    <div class="loot-title">${escapeHtml(entry.company_name)}</div>
    <div class="loot-meta">${entry.submitted_by ? `found by ${escapeHtml(entry.submitted_by)}` : "Anonymous scout"}</div>
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

function applyUpdate(entry) {
  lootById.set(entry.id, entry);
  renderLootFeed();
  if (openLootId === entry.id) renderLootSheet(entry);
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
  document.getElementById("form-company").value = "";
  document.getElementById("form-items").value = "";
  document.getElementById("form-name").value = localStorage.getItem("lr_display_name") || "";
  document.getElementById("photo-picker-text").style.display = "";
  const preview = document.getElementById("photo-picker").querySelector("img");
  if (preview) preview.remove();
  document.getElementById("form-photo").value = "";
  selectedPhotoBlob = null;
  document.getElementById("add-sheet").classList.add("open");
}

function closeAddSheet() {
  document.getElementById("add-sheet").classList.remove("open");
}
document.getElementById("add-sheet-back").addEventListener("click", closeAddSheet);
document.getElementById("add-cancel").addEventListener("click", closeAddSheet);
document.getElementById("btn-add-global").addEventListener("click", openAddSheet);

document.getElementById("form-photo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    selectedPhotoBlob = await resizeImage(file, 1280, 0.82);
    const picker = document.getElementById("photo-picker");
    document.getElementById("photo-picker-text").style.display = "none";
    let preview = picker.querySelector("img");
    if (!preview) {
      preview = document.createElement("img");
      preview.style.cssText = "width:100%;max-height:180px;object-fit:cover;border-radius:10px;";
      picker.appendChild(preview);
    }
    preview.src = URL.createObjectURL(selectedPhotoBlob);
  } catch (e) {
    toast("Could not process photo", true);
  }
});

function resizeImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else { width = Math.round((width * maxDim) / height); height = maxDim; }
      }
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
  const company = document.getElementById("form-company").value.trim();
  const items = document.getElementById("form-items").value.trim();
  const name = document.getElementById("form-name").value.trim();
  if (!company || !items) { toast("Fill in where it's from and what the loot is", true); return; }

  const btn = document.getElementById("add-submit");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting';
  try {
    if (name) localStorage.setItem("lr_display_name", name);
    const entry = await apiCreateLoot(
      { company_name: company, items, pin_x: 0.5, pin_y: 0.5, submitted_by: name },
      selectedPhotoBlob
    );
    lootById.set(entry.id, entry);
    closeAddSheet();
    renderLootFeed();
    toast("Loot added to the feed");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Submit loot";
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
    list.innerHTML = rows.map((r, i) => `<div class="lb-card" data-id="${r.id}">
        <div class="lb-rank${rankClass(i)}">${i + 1}</div>
        <div class="lb-info">
          <div class="lb-title">${escapeHtml(r.company_name)}</div>
          <div class="lb-sub">${escapeHtml(r.items)}</div>
        </div>
        <div class="lb-score">${icon("star")}${r.avg_quality}</div>
      </div>`).join("");
    list.querySelectorAll(".lb-card").forEach((card) => {
      card.addEventListener("click", () => openLoot(Number(card.dataset.id)));
    });
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
// Live updates (SSE) -- same shared broadcaster as every other event, see
// gamescom2026/app.js's own comment on why filtering happens client-side.
// ---------------------------------------------------------------------------

function connectEvents() {
  const es = new EventSource(`${API_BASE}/events?event_id=${EVENT_ID}`);
  es.addEventListener("loot.created", (e) => {
    const entry = JSON.parse(e.data);
    if (entry.event_id && entry.event_id !== EVENT_ID) return;
    lootById.set(entry.id, entry);
    renderLootFeed();
    toast(`New loot: ${entry.company_name}`);
  });
  es.addEventListener("loot.updated", (e) => {
    const entry = JSON.parse(e.data);
    if (entry.event_id && entry.event_id !== EVENT_ID) return;
    applyUpdate(entry);
  });
  es.onerror = () => {
    // EventSource auto-reconnects on its own.
  };
}

// ---------------------------------------------------------------------------
// Accounts -- identical flow to gamescom2026, minus hall/booth in "my loot"
// (this event has none).
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
    // Sign-in buttons just stay hidden.
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
      const thumb = l.has_photo
        ? `<img class="booth-loot-thumb" src="${API_BASE}/loot/${l.id}/photo" alt="" />`
        : `<div class="booth-loot-thumb"></div>`;
      return `<div class="booth-loot-card" data-id="${l.id}">
        ${thumb}
        <div class="booth-loot-info">
          <div class="booth-loot-title">${escapeHtml(l.company_name)}</div>
          <div class="booth-loot-sub">${escapeHtml(l.items)}</div>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll(".booth-loot-card").forEach((card) => {
      card.addEventListener("click", () => {
        const entry = lootById.get(Number(card.dataset.id));
        if (entry) { closeAccountSheet(); openLoot(entry.id); }
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
document.getElementById("btn-account").addEventListener("click", openAccountSheet);
document.getElementById("account-sheet-back").addEventListener("click", closeAccountSheet);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function refreshAll() {
  try {
    const list = await apiGet("/loot");
    lootById = new Map(list.map((l) => [l.id, l]));
    renderLootFeed();
  } catch (e) {
    toast("Could not reach Lootemall -- retrying", true);
  }
}

(async function init() {
  // Site-wide sign-in gate (see auth-gate.js's own module comment) -- runs
  // before any data fetch or SSE connect. A successful sign-in reloads the
  // page, so returning here just leaves the gate showing.
  const signedIn = await window.ensureAuthGate();
  if (!signedIn) return;

  renderLootFeed();
  await refreshAll();
  loadLeaderboard();
  connectEvents();
  loadMe();
  loadProviders();
})();
