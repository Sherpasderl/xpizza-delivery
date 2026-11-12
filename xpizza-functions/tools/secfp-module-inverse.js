'use strict';
// SECURITY null-fingerprint fix (NOTE-security-null-fp-tracking-token, advisor Option A 2026-11-12) — the test-only INVERSE for its ONE
// same-line edit to createorder-classify.js (pinned by older layers). NEWEST layer: applied FIRST (innermost) at every raw read of the
// file; any other file passes through untouched. secfp-wiring.guard pins that it returns the file to its base byte-for-byte.
const BASE = '53edc481';
const HUNKS = Object.freeze([
 {
  "file": "createorder-classify.js",
  "now": "    if (existing.payment_fingerprint && !incomingFp) return { action: '409', reason: 'cart_unverifiable' }; if (existing.payment_fingerprint && incomingFp && existing.payment_fingerprint !== incomingFp) {   // SECURITY (NOTE-security-null-fp, advisor Option A): an unverifiable incoming cart never matches a fingerprinted order — the canonical format's answer, never the 200 that returns its tracking token\n",
  "was": "    if (existing.payment_fingerprint && incomingFp && existing.payment_fingerprint !== incomingFp) {\n"
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
function unapplySecFpModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`secfp-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, FILES, unapplySecFpModule };
