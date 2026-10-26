'use strict';
// ORCHESTRATION O1b (PLAN-orch-o1b r3 T9) — the test-only INVERSE of this slice's index.js footprint: the four lifecycle endpoint
// names in the ops early branch's PORTAL_OPS_TARGETS (line 6) and their re-exports on the portal-ops export line.
// unapplyO1bIndex(index.js) removes BOTH hunks (raw index.js reads); unapplyO1bFold(foldPortalSplit()) removes only the export
// hunk — foldPortalSplit drops the early-branch region (with line 6 in it), and the fold must not contain the top hunk at all.
// Newest layer → applied INNERMOST at every index.js fold site: unapplyPortalUiIndex(unapplyO1bIndex(<source>)).
// Each hunk must occur EXACTLY once, else this throws. GENERATED from base (acf32fc8) vs candidate; JSON-quoted [now, was] pairs.

const BASE = 'acf32fc8';
const INDEX_HUNKS = [
 [
  "const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats'])); const PORTAL_OPS_TARGETS = Object.freeze(new Set(['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice', 'createBranchDraft', 'updateBranchProfile', 'setBranchActive', 'deleteBranchDraft'])); if (PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('portal_ops_entry', process.env.FUNCTION_TARGET); module.exports = require('./portal/ops-functions'); return; }   // PORTAL-UI 1a + slice 2: the branch-ops functions, isolated the same way (portal/ops-functions.js)\n",
  "const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats'])); const PORTAL_OPS_TARGETS = Object.freeze(new Set(['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice'])); if (PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('portal_ops_entry', process.env.FUNCTION_TARGET); module.exports = require('./portal/ops-functions'); return; }   // PORTAL-UI 1a + slice 2: the branch-ops functions, isolated the same way (portal/ops-functions.js)\n"
 ],
 [
  "exports.resetDraftToLive = require('./portal/reset-draft').resetDraftToLive; exports.getMyBranches = require('./portal/ops-functions').getMyBranches; exports.updateBranch = require('./portal/ops-functions').updateBranch; exports.setBranchPause = require('./portal/ops-functions').setBranchPause; exports.getBranchAvailability = require('./portal/ops-functions').getBranchAvailability; exports.setBranchAvailability = require('./portal/ops-functions').setBranchAvailability; exports.getBranchDevices = require('./portal/ops-functions').getBranchDevices; exports.revokeBranchDevice = require('./portal/ops-functions').revokeBranchDevice; exports.createBranchDraft = require('./portal/ops-functions').createBranchDraft; exports.updateBranchProfile = require('./portal/ops-functions').updateBranchProfile; exports.setBranchActive = require('./portal/ops-functions').setBranchActive; exports.deleteBranchDraft = require('./portal/ops-functions').deleteBranchDraft;   // PORTAL-UI 1a + slice 2: + the branch-ops endpoints (portal/ops-functions.js, full load) · 1D add-product A §0.1: \"Volver al menú publicado\" (full load; not an isolated portal fn)\n",
  "exports.resetDraftToLive = require('./portal/reset-draft').resetDraftToLive; exports.getMyBranches = require('./portal/ops-functions').getMyBranches; exports.updateBranch = require('./portal/ops-functions').updateBranch; exports.setBranchPause = require('./portal/ops-functions').setBranchPause; exports.getBranchAvailability = require('./portal/ops-functions').getBranchAvailability; exports.setBranchAvailability = require('./portal/ops-functions').setBranchAvailability; exports.getBranchDevices = require('./portal/ops-functions').getBranchDevices; exports.revokeBranchDevice = require('./portal/ops-functions').revokeBranchDevice;   // PORTAL-UI 1a + slice 2: + the branch-ops endpoints (portal/ops-functions.js, full load) · 1D add-product A §0.1: \"Volver al menú publicado\" (full load; not an isolated portal fn)\n"
 ]
];

function apply(src, hunks, label) {
  let out = src;
  for (const [now, was] of hunks) {
    const n = out.split(now).length - 1;
    if (n !== 1) throw new Error(`o1b-inverse ${label}: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(now.slice(0, 120))}`);
    out = out.replace(now, () => was);
  }
  return out;
}
const isTop = ([now]) => now.includes('PORTAL_OPS_TARGETS');
function unapplyO1bIndex(src) { return apply(src, INDEX_HUNKS, 'index.js'); }
function unapplyO1bFold(fold) {
  for (const h of INDEX_HUNKS.filter(isTop)) if (fold.includes(h[0])) throw new Error('o1b-inverse fold: the early-branch hunk survived foldPortalSplit');
  return apply(fold, INDEX_HUNKS.filter((h) => !isTop(h)), 'fold');
}

module.exports = { unapplyO1bIndex, unapplyO1bFold, INDEX_HUNKS, BASE };
