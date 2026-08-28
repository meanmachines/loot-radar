"use strict";

// Small inline SVG icon set -- no icon font/external asset, so nothing to
// fetch at a venue on patchy wifi. Deliberately no emoji anywhere in this
// app; these fill that role instead.
const ICONS = {
  pin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.6 2 4 5.6 4 10c0 6 8 12 8 12s8-6 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.1 6.7 7.4.8-5.5 5 1.6 7.3L12 18.3 5.4 21.8 7 14.5 1.5 9.5l7.4-.8L12 2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22V4c0 0 2-2 5-2s4 2 7 2 5-2 5-2v12c0 0-2 2-5 2s-4-2-7-2-5 2-5 2"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 4.9H19l-4 2.9 1.5 4.9L12 11.8 7.5 14.7 9 9.8 5 6.9h5.4z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  crosshair: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M12 12L18 7"/></svg>',
  chest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="10" width="18" height="10" rx="1.5"/><path d="M3 10c0-3.5 4-6 9-6s9 2.5 9 6"/><rect x="9.5" y="13" width="5" height="4" rx="0.6"/></svg>',
};

function icon(name, extraClass) {
  const svg = ICONS[name] || "";
  return extraClass ? svg.replace("<svg ", `<svg class="${extraClass}" `) : svg;
}
