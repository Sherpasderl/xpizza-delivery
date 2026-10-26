'use strict';
// PLAN-public-menu-display r2 — the slice's INVERSE for the MODULES older slices pin byte-for-byte
// (catalog/identity-integrity-guards: source-store.js by sha; catalog/context-guards and catalog/identity-record-guards read
// it through the same fold; extras-wiring.guard.test.js: source-store.js minus the extras hunks is 537bbbc). Every fold site
// applies unapplyPmdisplayModule INNERMOST (newest first), then the older inverses, so any byte outside these exact hunks
// still fails them. pmdisplay-wiring.guard.test.js proves this inverse reproduces acf32fc8 for each file byte-for-byte.
// Generated from `git diff -U1 acf32fc8` (one context line); each `now` occurs exactly once.
const HUNKS = Object.freeze([
 {
  "file": "catalog/source-store.js",
  "now": "  };\n  // PLAN-public-menu-display r2 T1: where names are OPTIONAL (the renderer prints none), they are all-or-nothing — a\n  // partially named set is never coherent. Where they are REQUIRED (above), the per-category rule already says more.\n  if (!contract.categoriesNamed) {\n    const namedCount = st.categories.filter((cat) => cat && cat.name !== undefined).length;\n    if (namedCount !== 0 && namedCount !== st.categories.length) fail(`${rid} — structure.categories names are all-or-nothing (${namedCount} of ${st.categories.length} named)`);\n  }\n  for (const c of st.categories) {\n",
  "was": "  };\n  for (const c of st.categories) {\n"
 }
]);

function unapplyPmdisplayModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`pmdisplay-module-inverse: ${file}: a public-menu-display hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { HUNKS, FILES, unapplyPmdisplayModule };
