'use strict';
// WAHEALTH (WhatsApp gateway health, OWNER-approved 2026-10-22) — the test-only INVERSE of this slice's index.js footprint (the
// split-file fold pattern, as tools/unassign-inverse.js). Proof: unapplyWaHealthIndex(index.js) === e2266b24:index.js byte-for-byte
// (wahealth-wiring.guard.test.js). It is applied INNERMOST (first) in every index.js fold consumer, since this slice is newest.
// The hunk: the /* wahealth:begin */ … /* wahealth:end */ block appended after /* h1c:end */ (a pure tail addition → base "").
// It must occur EXACTLY once, else this throws (a moved, duplicated or edited hunk is never tolerated).
// GENERATED from the base (e2266b24) vs candidate index.js; JSON-quoted strings.

const INDEX_HUNKS = [
 [
  "\n/* wahealth:begin */\n// WhatsApp gateway health (OWNER-approved 2026-10-22) — every 30 min, ONE severity=ERROR line per UNLINKED UltraMsg instance\n// (the owner's error alert emails it). Logic in whatsapp/instance-health.js; the restaurant ids come from the registry (data).\nexports.whatsappInstanceHealth = require('./whatsapp/instance-health').makeHealthFunction({ knownRids: async () => { await restaurantRegistry().ready(); return [...restaurantRegistry().known()]; }, getDb: getDatabase });\n/* wahealth:end */\n",
  ""
 ]
];

function apply(src, hunks, label) {
  let out = src;
  for (const [cand, base] of hunks) {
    const n = out.split(cand).length - 1;
    if (n !== 1) throw new Error(`${label}: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(cand.slice(0, 120))}`);
    out = out.replace(cand, () => base);
  }
  return out;
}
const unapplyWaHealthIndex = (indexSrc) => apply(indexSrc, INDEX_HUNKS, 'wahealth-inverse index.js');

// The block is a pure tail addition, so it survives tools/portal-split.js foldPortalSplit verbatim: the same hunk reverses the fold.
const unapplyWaHealthFold = (foldSrc) => apply(foldSrc, INDEX_HUNKS, 'wahealth-inverse portal fold');

module.exports = { unapplyWaHealthIndex, unapplyWaHealthFold, INDEX_HUNKS, BEGIN: '/* wahealth:begin */', END: '/* wahealth:end */' };
