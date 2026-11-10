'use strict';
// F-1 platform-pending stamp (BRIEF-portal-stale-draft-clobber; Codex r1 + advisor ruling 2026-11-07, malformed (a)) — the
// FOLD-ONLY inverse. The slice's one edit inside portal/functions.js's MOVED block B is the getEditableCatalog `alertMalformed`
// dependency (a malformed stamp's ONE deduped owner alert); its import sits OUTSIDE the moved blocks, in the header (like
// add-product's and photos'), so foldPortalSplit's REQUIRE_REWRITES count is unchanged. index.js itself is untouched, so there is
// no unapplyPpIndex. It is the NEWEST layer: every base-pinned fold applies it FIRST (innermost, right after foldPortalSplit).
const FOLD_HUNKS = Object.freeze([
 {
  "file": "portal/functions.js (moved block B, in the fold)",
  "now": "        readActiveBuilt: readActiveBuiltForEdit, photoReads: editableIoForPortal(),   // 1D add-product A: assess the saved draft against what is serving; DISH PHOTOS A2 step 9 (E-P3)\n"
       + "        alertMalformed: (rid) => raiseMalformedAlert(getDatabase(), rid),   // F-1: a malformed stamp's ONE deduped owner alert\n",
  "was": "        readActiveBuilt: readActiveBuiltForEdit, photoReads: editableIoForPortal(),   // 1D add-product A: assess the saved draft against what is serving; DISH PHOTOS A2 step 9 (E-P3)\n"
 }
]);
function apply(src, hunks) {
  let out = src;
  for (const h of hunks) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`pp-inverse: the fold: an F-1 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplyPpFold = (src) => apply(src, FOLD_HUNKS);
module.exports = { FOLD_HUNKS, unapplyPpFold };
