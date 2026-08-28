"use strict";

// Static venue geometry -- a schematic (not a traced copy of Koelnmesse's
// own proprietary hall-plan artwork) built to match the REAL relative
// layout and area-category colors published at gamescom.global/en/info/
// hall-plan: correct hall numbers, correct adjacency/clustering, correct
// legend colors per area type, and -- for halls covered by hallplan/
// index.json -- real proportional footprint sizes (see the resize script
// this file's own rect values came from: each hall's plan-footprint area,
// relative to the mean across all covered halls, scales its box around its
// original hand-placed center, clamped to +-15% so the layout never
// collides even though hall 10's real footprint is nearly twice the mean).
// Flat rectangles read better on a phone at a live event than trying to
// mimic irregular polygon shapes, and this top-level map is a wayfinding
// aid (which hall, roughly where) -- the REAL precision lives one level
// down, in hallplan/*.json's actual booth polygons (see loadHallPlan in
// app.js), not here.
//
// Coordinates are in a 1000x700 unit space; the SVG viewBox matches, so
// this data drives the top-level venue map. Loot pin_x/pin_y are saved
// normalized 0..1 within a hall's own rendered canvas -- for a hall with
// real plan data that canvas is the plan's own metre bounding box (plus
// outline.json's wall margin), for one without it's this rect.
const HALLS = [
  { id: "confex", number: "Confex", name: "Confex", category: "Business area", color: "#94a3b8", rect: { x: 230, y: 40, w: 190, h: 110 } },
  { id: "h1", number: "1", name: "Hall 1", category: "Event arena", color: "#ec4899", rect: { x: 460, y: 30, w: 200, h: 120 } },
  { id: "h2", number: "2", name: "Hall 2", category: "Business area", color: "#a855f7", rect: { x: 271.2, y: 173.2, w: 127.5, h: 93.5 } },
  { id: "h3", number: "3", name: "Hall 3", category: "Business area", color: "#a855f7", rect: { x: 120.5, y: 199.0, w: 119.0, h: 102.0 } },
  { id: "h4", number: "4", name: "Hall 4", category: "Business area", color: "#a855f7", rect: { x: 420.5, y: 165.5, w: 149.0, h: 149.0 } },
  { id: "h5", number: "5", name: "Hall 5", category: "Mixed zone", color: "#f472b6", rect: { x: 580.0, y: 164.9, w: 90.1, h: 150.1 } },
  { id: "h6", number: "6", name: "Hall 6", category: "Entertainment area", color: "#22d3ee", rect: { x: 672.2, y: 146.7, w: 185.6, h: 196.5 } },
  { id: "h7", number: "7", name: "Hall 7", category: "Entertainment area", color: "#22d3ee", rect: { x: 861.7, y: 177.5, w: 126.6, h: 185.0 } },
  { id: "h9", number: "9", name: "Hall 9", category: "Entertainment area", color: "#22d3ee", rect: { x: 691.9, y: 411.9, w: 146.1, h: 146.1 } },
  { id: "h8", number: "8", name: "Hall 8", category: "Entertainment area", color: "#22d3ee", rect: { x: 861.7, y: 432.5, w: 126.6, h: 185.0 }, accent: { color: "#ef4444", corner: "br", label: "Outdoor P8" } },
  { id: "h10", number: "10", name: "Hall 10", category: "Retro & family / Indie", color: "#fb923c", rect: { x: 401.2, y: 365.8, w: 287.5, h: 218.5 }, splitColor: "#2dd4bf" },
  { id: "h11", number: "11", name: "Hall 11", category: "Creator co-working", color: "#64748b", rect: { x: 20, y: 380, w: 170, h: 190 } },
];

const ENTRANCES = [
  { label: "West", x: 150, y: 20 },
  { label: "Süd", x: 10, y: 260 },
  { label: "Ost", x: 380, y: 590 },
  { label: "Nord", x: 990, y: 620 },
];

const VENUE_VIEWBOX = { w: 1000, h: 660 };

function hallById(id) {
  return HALLS.find((h) => h.id === id) || null;
}

// Which of our top-level hall ids have real booth-plan data (vendored from
// gc2026-guide, see frontend/hallplan/ATTRIBUTION.md), and which real
// hall-plan file(s) back it. A hall with two entries is a real two-storey
// building (confirmed live in outline.json's own note for hall 5: "the
// endpoint files both storeys of hall 5 against the same building frame")
// -- the hall-detail view offers a level switcher for those, see
// renderHallLevelSwitcher in app.js. Halls 1, 11, and Confex have no
// exhibitor-stand data in the source (event arena / co-working / no
// listed stands) and keep the plain schematic canvas.
const HALLPLAN_LEVELS = {
  h2: [{ file: "2.1", label: "Level 1" }, { file: "2.2", label: "Level 2" }],
  h3: [{ file: "3.2", label: "Hall 3" }],
  h4: [{ file: "4.1", label: "Level 1" }, { file: "4.2", label: "Level 2" }],
  h5: [{ file: "5.1", label: "Level 1" }, { file: "5.2", label: "Level 2" }],
  h6: [{ file: "6.1", label: "Hall 6" }],
  h7: [{ file: "7.1", label: "Hall 7" }],
  h8: [{ file: "8.1", label: "Hall 8" }],
  h9: [{ file: "9.1", label: "Hall 9" }],
  h10: [{ file: "10.1", label: "Level 1" }, { file: "10.2", label: "Level 2" }],
};
