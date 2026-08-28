"use strict";

// Static venue geometry -- a schematic (not a traced copy of Koelnmesse's
// own proprietary hall-plan artwork) built to match the REAL relative
// layout and area-category colors published at gamescom.global/en/info/
// hall-plan: correct hall numbers, correct adjacency/clustering, correct
// legend colors per area type. Flat rectangles read better on a phone at
// a live event than trying to mimic irregular polygon shapes, and this is
// a wayfinding aid (which hall, roughly where), not a certified floorplan.
//
// Coordinates are in a 1000x700 unit space; the SVG viewBox matches, so
// this data drives both the top-level venue map and the pin-placement math
// (pin_x/pin_y saved with a loot entry are normalized 0..1 WITHIN a hall's
// own rect, not the venue space -- see hallRectToViewport in app.js).
const HALLS = [
  { id: "confex", number: "Confex", name: "Confex", category: "Business area", color: "#94a3b8", rect: { x: 230, y: 40, w: 190, h: 110 } },
  { id: "h1", number: "1", name: "Hall 1", category: "Event arena", color: "#ec4899", rect: { x: 460, y: 30, w: 200, h: 120 } },
  { id: "h2", number: "2", name: "Hall 2", category: "Business area", color: "#a855f7", rect: { x: 260, y: 165, w: 150, h: 110 } },
  { id: "h3", number: "3", name: "Hall 3", category: "Business area", color: "#a855f7", rect: { x: 110, y: 190, w: 140, h: 120 } },
  { id: "h4", number: "4", name: "Hall 4", category: "Business area", color: "#a855f7", rect: { x: 420, y: 165, w: 150, h: 150 } },
  { id: "h5", number: "5", name: "Hall 5", category: "Mixed zone", color: "#f472b6", rect: { x: 580, y: 165, w: 90, h: 150 } },
  { id: "h6", number: "6", name: "Hall 6", category: "Entertainment area", color: "#22d3ee", rect: { x: 680, y: 155, w: 170, h: 180 } },
  { id: "h7", number: "7", name: "Hall 7", category: "Entertainment area", color: "#22d3ee", rect: { x: 860, y: 175, w: 130, h: 190 } },
  { id: "h9", number: "9", name: "Hall 9", category: "Entertainment area", color: "#22d3ee", rect: { x: 680, y: 345, w: 170, h: 170 } },
  { id: "h8", number: "8", name: "Hall 8", category: "Entertainment area", color: "#22d3ee", rect: { x: 860, y: 375, w: 130, h: 190 }, accent: { color: "#ef4444", corner: "br", label: "Outdoor P8" } },
  { id: "h10", number: "10", name: "Hall 10", category: "Retro & family / Indie", color: "#fb923c", rect: { x: 420, y: 325, w: 250, h: 190 }, splitColor: "#2dd4bf" },
  { id: "h11", number: "11", name: "Hall 11", category: "Creator co-working", color: "#64748b", rect: { x: 20, y: 325, w: 170, h: 190 } },
];

const ENTRANCES = [
  { label: "West", x: 150, y: 20 },
  { label: "Süd", x: 10, y: 210 },
  { label: "Ost", x: 400, y: 530 },
  { label: "Nord", x: 990, y: 480 },
];

const VENUE_VIEWBOX = { w: 1000, h: 700 };

function hallById(id) {
  return HALLS.find((h) => h.id === id) || null;
}
