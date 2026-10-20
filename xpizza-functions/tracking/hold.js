'use strict';
// TRACKER FIXES (BUILD r1.5 §3.1) — the TEST-ONLY async hold seam reachable through the REAL trigger exports. A no-op unless a test
// installs `globalThis.__trackerHold` (async (name, ctx) => …). INERT in production: no production file assigns it
// (tracker-hold-inertness.guard.test.js), and an absent hook costs one property read per hold point.
async function trackerHold(name, ctx) {
  const h = globalThis.__trackerHold;
  if (typeof h === 'function') await h(name, ctx);
}
module.exports = { trackerHold };
