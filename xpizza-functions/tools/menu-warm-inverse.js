'use strict';
// PLAN 2 (docs/superpowers/plans/2026-10-26-menu-load-latency.md) — the test-only index.js INVERSE for the warm getPublicMenu.
// ONE same-line hunk (no R3 call-site line shifts): `minInstances: 1` appended to getPublicMenu's options line.
// unapplyMenuWarmIndex swaps it back, so the result === BASE:index.js byte-for-byte (menu-warm-wiring.guard). The hunk's line
// survives foldPortalSplit unchanged, so the same function also strips it from a FOLD. It is the NEWEST slice: every index.js
// chain and every fold applies it FIRST.
const BASE = '6fcd7ff2';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "  { region: 'us-central1', cors: PUBLIC_MENU_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 20, minInstances: 1 },   // PLAN 2: one warm instance — the live menu must not wait on a cold start\n",
  "was": "  { region: 'us-central1', cors: PUBLIC_MENU_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 20 },\n"
 }
]);
function unapplyMenuWarmIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`menu-warm-inverse: index.js: the menu-warm hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, unapplyMenuWarmIndex };
