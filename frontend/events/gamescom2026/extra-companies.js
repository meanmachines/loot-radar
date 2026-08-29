"use strict";

// Hand-maintained booth locations for exhibitors NOT present in the
// vendored official floor-plan data (see hallplan/ATTRIBUTION.md) --
// confirmed some other way (on-site report, exhibitor site) instead of
// sourced from Koelnmesse's own data dump. Merged into the searchable
// company index in app.js's buildCompanyIndex() -- this is the actual
// "local database" that lets the giveaway form resolve a typed company
// name straight to a real hall/booth without anyone having to tap the map
// first. pinX/pinY are normalized 0..1 within that hall's own floor plan
// (same convention as a loot entry's own pin_x/pin_y).
//
// hallId values match halls.js's own ids (h2..h10). Once a company's real
// booth is confirmed, add it here -- or just report/schedule something at
// their booth through the app itself, which indexes it automatically from
// then on (see app.js's indexCompany calls in the loot/giveaway SSE
// handlers) and this file never needs touching for that company again.
const EXTRA_COMPANIES = {
  // "Tripo AI": { hallId: "h10", boothNo: "?", pinX: 0.5, pinY: 0.5 },
};
