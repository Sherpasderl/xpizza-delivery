'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §6) — the slice's test-only index.js INVERSE. Two SAME-LINE hunks (no line
// inserted, so no R3 call-site line shifts): the ops early branch appended to the PORTAL_ISOLATED_TARGETS line, and the full-load
// re-export appended to the resetDraftToLive line. unapplyPortalUiIndex swaps both back, so the result === BASE:index.js
// byte-for-byte (portalui-wiring.guard). unapplyPortalUiFold strips ONLY the re-export hunk: foldPortalSplit() already drops
// the whole early-branch region (the top hunk lives inside it). It is the NEWEST slice: every index.js fold applies it FIRST.
const BASE = '613f7e08';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats'])); const PORTAL_OPS_TARGETS = Object.freeze(new Set(['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability'])); if (PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('portal_ops_entry', process.env.FUNCTION_TARGET); module.exports = require('./portal/ops-functions'); return; }   // PORTAL-UI 1a: the five branch-ops functions, isolated the same way (portal/ops-functions.js)\n",
  "was": "const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats']));\n"
 },
 {
  "file": "index.js",
  "now": "exports.resetDraftToLive = require('./portal/reset-draft').resetDraftToLive; exports.getMyBranches = require('./portal/ops-functions').getMyBranches; exports.updateBranch = require('./portal/ops-functions').updateBranch; exports.setBranchPause = require('./portal/ops-functions').setBranchPause; exports.getBranchAvailability = require('./portal/ops-functions').getBranchAvailability; exports.setBranchAvailability = require('./portal/ops-functions').setBranchAvailability;   // PORTAL-UI 1a: + the five branch-ops endpoints (portal/ops-functions.js, full load) · 1D add-product A §0.1: \"Volver al menú publicado\" (full load; not an isolated portal fn)\n",
  "was": "exports.resetDraftToLive = require('./portal/reset-draft').resetDraftToLive;   // 1D add-product A §0.1: \"Volver al menú publicado\" (full load; not an isolated portal fn)\n"
 }
]);
function apply(src, hunks) {
  let out = src;
  for (const h of hunks) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`portalui-inverse: index.js: a portal-ui hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplyPortalUiIndex = (src) => apply(src, HUNKS);
const unapplyPortalUiFold = (src) => apply(src, HUNKS.slice(1));   // the early-branch hunk is consumed by foldPortalSplit
module.exports = { BASE, HUNKS, unapplyPortalUiIndex, unapplyPortalUiFold };
