'use strict';
// ENDPOINT MEMORY 256 → 512MiB (TRAIN-NEXT-INVENTORY assembly obligation 9; owner-approved 2026-10-31; evidence
// NOTE-createorder-warm-boot.md: memory p99 0.86–0.92 of 256Mi, warm-boot p99 242 s / 151 s) — the test-only index.js INVERSE.
// FOUR same-line hunks (no line inserted or removed): createOrder, chargeOnlineOrder, getPublicMenu, quoteOrder each go from
// memory '256MiB' to '512MiB'. unapplyMem512Index swaps them back, so every older fold sees the pre-mem512 bytes.
// It is the NEWEST layer: every index.js chain and every fold applies it FIRST (innermost).
// HUNK 5 (advisor ruling 10-31, STOP 4): formSignal 256MiB → 128MiB — NOT part of this train's change: it is MAIN-SHIPPED
// 8a31e2a3 (D5 OOM fix) and had no inverse, so a guard whose parent predates 8a31e2a3 (s4hours-wiring, 638d42f5) saw it.
// COMPOSE, DON'T RE-CUT (advisor ruling 10-31): getPublicMenu's options line is INSIDE menu-warm-inverse.js's pinned hunk. That
// tool stays byte-unchanged; this inverse runs before it and restores '256MiB', so menu-warm's pinned 'now' text matches as is.
// Run in the other order and menu-warm's exactly-once check throws (mem512-inverse.test.js, the ORDER mutant).
// Each hunk's 'now' is the changed line plus the fewest preceding lines that make it unique; none overlaps another inverse's
// pinned span except getPublicMenu ⊂ menu-warm (the hard pre-step overlap check, re-run on the assembled tree).
const HUNKS = Object.freeze([
 {
  "fn": "createOrder",
  "file": "index.js",
  "now": "    cors: true,            // browser-callable — order form posts directly (no Make.com relay)\n    timeoutSeconds: 30,\n    memory: '512MiB',\n",
  "was": "    cors: true,            // browser-callable — order form posts directly (no Make.com relay)\n    timeoutSeconds: 30,\n    memory: '256MiB',\n"
 },
 {
  "fn": "chargeOnlineOrder",
  "file": "index.js",
  "now": "    cors: true,\n    timeoutSeconds: 30,\n    memory: '512MiB',\n",
  "was": "    cors: true,\n    timeoutSeconds: 30,\n    memory: '256MiB',\n"
 },
 {
  "fn": "getPublicMenu",
  "file": "index.js",
  "now": "  { region: 'us-central1', cors: PUBLIC_MENU_ORIGINS, timeoutSeconds: 20, memory: '512MiB', maxInstances: 20, minInstances: 1 },   // PLAN 2: one warm instance — the live menu must not wait on a cold start\n",
  "was": "  { region: 'us-central1', cors: PUBLIC_MENU_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 20, minInstances: 1 },   // PLAN 2: one warm instance — the live menu must not wait on a cold start\n"
 },
 {
  "fn": "quoteOrder",
  "file": "index.js",
  "now": "  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '512MiB', maxInstances: 10 },\n",
  "was": "  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },\n"
 },
 {
  "fn": "formSignal",
  "file": "index.js",
  "shipped": "main-shipped 8a31e2a3 (D5: formSignal 128MiB → 256MiB, startup OOM in prod)",
  "now": "  { region: 'us-central1', cors: FORM_SIGNAL_ORIGINS, timeoutSeconds: 10, memory: '256MiB', maxInstances: 5, concurrency: 40 },\n",
  "was": "  { region: 'us-central1', cors: FORM_SIGNAL_ORIGINS, timeoutSeconds: 10, memory: '128MiB', maxInstances: 5, concurrency: 40 },\n"
 }
].map(Object.freeze));
function unapplyMem512Index(src) {
  let out = src;
  for (const h of HUNKS) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`mem512-inverse: index.js: the ${h.fn} memory hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { HUNKS, unapplyMem512Index };
