'use strict';
// S2-srv-app (Customer App S2, PLAN-capp-S2-r4 §2.1) — the test-only INVERSE of the slice's index.js hunk (hot-file
// invariant, see memory index-js-inverse-fold-invariant). ONE SAME-LINE hunk (no line inserted, so no R3 region line shifts):
// chargeOnlineOrder hands the request's Origin to resolveReturnBaseForCharge (the app's Origin-selected return base; direct
// ignores it). Put back to its cb7e9bfd text, so every *-wiring.guard fold chain reconstructs its frozen base. This slice is
// the NEWEST: it is composed INNERMOST (stripped first, before tools/s2tip-inverse.js). Proof: unapplyS2appIndex(index.js) ===
// cb7e9bfd:index.js byte-for-byte (s2app-wiring.guard). Each hunk must occur EXACTLY once, else this throws. GENERATED from
// `git diff cb7e9bfd -- index.js` (context grown until unique); JSON-quoted strings.

const HUNKS = [
  [
    "  const returnBase = await resolveReturnBaseForCharge(restaurantId, process.env, { identity: s3bIdentity, entryMode: body.entry_mode, requestOrigin: req.get('origin'), readBrandId: () => db.ref(`restaurants/${restaurantId}/identity/brand_id`).get().then((s) => s.val()) });\n",
    "  const returnBase = await resolveReturnBaseForCharge(restaurantId, process.env, { identity: s3bIdentity, entryMode: body.entry_mode, readBrandId: () => db.ref(`restaurants/${restaurantId}/identity/brand_id`).get().then((s) => s.val()) });\n"
  ]
];

function unapplyS2appIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`s2app-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyS2appIndex, HUNKS, BASE: 'cb7e9bfd' };
