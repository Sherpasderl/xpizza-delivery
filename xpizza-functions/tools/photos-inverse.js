'use strict';
// DISH PHOTOS A1 step 6 (advisor ruling 2026-10-26: a NEW index.js isolation group, inverse folded INNERMOST at every fold site — the
// O1b / portal-ui pattern). Two SAME-LINE hunks (no line inserted ⇒ no R3 call-site line shifts): the photos early branch inserted on
// the PORTAL_ISOLATED_TARGETS line right after the ops branch's `return; }` (before its trailing comment), and the full-load re-exports
// inserted on the resetDraftToLive line after the last ops re-export (before its trailing comment). unapplyPhotosIndex swaps both back,
// so the result === the base index.js byte-for-byte (photos-wiring.guard). unapplyPhotosFold strips ONLY the re-export hunk:
// foldPortalSplit() already drops the whole early-branch region (the top hunk lives inside it). It is the NEWEST slice: every index.js
// fold applies it FIRST (innermost).
const BASE = '743277de';   // DRYRUN R-WIRE (2e): the 2 index.js hunks are RE-CUT onto the assembled line (now = with O1b's lifecycle names + photos; was = the pre-photos dry line, O1b kept) — O1b then folds next; regenerate at the real assembly   // A2 base: Plan 4's tip 743277de merged with A1 b908d443 (the photo hunks are unchanged; their base re-pointed)
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats'])); const PORTAL_OPS_TARGETS = Object.freeze(new Set(['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice', 'createBranchDraft', 'updateBranchProfile', 'setBranchActive', 'deleteBranchDraft'])); if (PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('portal_ops_entry', process.env.FUNCTION_TARGET); module.exports = require('./portal/ops-functions'); return; } const PHOTOS_TARGETS = Object.freeze(new Set(['photoUploadStart', 'photoProcess', 'photoSweep'])); if (PHOTOS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('photos_entry', process.env.FUNCTION_TARGET); module.exports = require('./photos/functions'); return; }   // PORTAL-UI 1a + slice 2: the branch-ops functions, isolated the same way (portal/ops-functions.js)\n",
  "was": "const PORTAL_ISOLATED_TARGETS = Object.freeze(new Set(['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats'])); const PORTAL_OPS_TARGETS = Object.freeze(new Set(['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice', 'createBranchDraft', 'updateBranchProfile', 'setBranchActive', 'deleteBranchDraft'])); if (PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('portal_ops_entry', process.env.FUNCTION_TARGET); module.exports = require('./portal/ops-functions'); return; }   // PORTAL-UI 1a + slice 2: the branch-ops functions, isolated the same way (portal/ops-functions.js)\n"
 },
 {
  "file": "index.js",
  "now": "exports.resetDraftToLive = require('./portal/reset-draft').resetDraftToLive; exports.getMyBranches = require('./portal/ops-functions').getMyBranches; exports.updateBranch = require('./portal/ops-functions').updateBranch; exports.setBranchPause = require('./portal/ops-functions').setBranchPause; exports.getBranchAvailability = require('./portal/ops-functions').getBranchAvailability; exports.setBranchAvailability = require('./portal/ops-functions').setBranchAvailability; exports.getBranchDevices = require('./portal/ops-functions').getBranchDevices; exports.revokeBranchDevice = require('./portal/ops-functions').revokeBranchDevice; exports.createBranchDraft = require('./portal/ops-functions').createBranchDraft; exports.updateBranchProfile = require('./portal/ops-functions').updateBranchProfile; exports.setBranchActive = require('./portal/ops-functions').setBranchActive; exports.deleteBranchDraft = require('./portal/ops-functions').deleteBranchDraft; exports.photoUploadStart = require('./photos/functions').photoUploadStart; exports.photoProcess = require('./photos/functions').photoProcess; exports.photoSweep = require('./photos/functions').photoSweep;   // PORTAL-UI 1a + slice 2: + the branch-ops endpoints (portal/ops-functions.js, full load) \u00b7 1D add-product A \u00a70.1: \"Volver al men\u00fa publicado\" (full load; not an isolated portal fn)\n",
  "was": "exports.resetDraftToLive = require('./portal/reset-draft').resetDraftToLive; exports.getMyBranches = require('./portal/ops-functions').getMyBranches; exports.updateBranch = require('./portal/ops-functions').updateBranch; exports.setBranchPause = require('./portal/ops-functions').setBranchPause; exports.getBranchAvailability = require('./portal/ops-functions').getBranchAvailability; exports.setBranchAvailability = require('./portal/ops-functions').setBranchAvailability; exports.getBranchDevices = require('./portal/ops-functions').getBranchDevices; exports.revokeBranchDevice = require('./portal/ops-functions').revokeBranchDevice; exports.createBranchDraft = require('./portal/ops-functions').createBranchDraft; exports.updateBranchProfile = require('./portal/ops-functions').updateBranchProfile; exports.setBranchActive = require('./portal/ops-functions').setBranchActive; exports.deleteBranchDraft = require('./portal/ops-functions').deleteBranchDraft;   // PORTAL-UI 1a + slice 2: + the branch-ops endpoints (portal/ops-functions.js, full load) \u00b7 1D add-product A \u00a70.1: \"Volver al men\u00fa publicado\" (full load; not an isolated portal fn)\n"
 }
]);
function apply(src, hunks) {
  let out = src;
  for (const h of hunks) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`photos-inverse: index.js: a photos hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplyPhotosIndex = (src) => apply(src, HUNKS);
// DISH PHOTOS A2 step 8 — FOLD-ONLY hunks: edits inside portal/functions.js's MOVED blocks exist only in the fold (foldPortalSplit
// inlines those blocks back into index form), never in index.js itself, so unapplyPhotosIndex never sees them. (The A2 header import
// of photoIoForEdit sits OUTSIDE the moved blocks, like add-product's, and is pinned by portal-split's skeleton check instead.)
const FOLD_HUNKS = Object.freeze([
 {
  "file": "portal/functions.js (moved block A, in the fold)",
  "now": "        addProduct: addProductIoForEdit(), photos: photoIoForEdit(),   // 1D add-product A; DISH PHOTOS A2 step 8: the draft photo map\n",
  "was": "        addProduct: addProductIoForEdit(),   // 1D add-product A\n"
 },
 {
  "file": "portal/functions.js (moved block B, in the fold)",
  "now": "        readActiveBuilt: readActiveBuiltForEdit, photoReads: editableIoForPortal(),   // 1D add-product A: assess the saved draft against what is serving; DISH PHOTOS A2 step 9 (E-P3)\n",
  "was": "        readActiveBuilt: readActiveBuiltForEdit,   // 1D add-product A: assess the saved draft against what is serving\n"
 },
 {
  "file": "portal/functions.js (moved block A — publishEdited, in the fold)",
  "now": "        addProduct: addProductIoForEdit(), photos: photoPublishIoForEdit(),   // 1D add-product A; DISH PHOTOS A2 step 10: the photo publish\n",
  "was": "        addProduct: addProductIoForEdit(),   // 1D add-product A\n"
 }
]);
const unapplyPhotosFold = (src) => apply(apply(src, HUNKS.slice(1)), FOLD_HUNKS);   // the early-branch hunk is consumed by foldPortalSplit
module.exports = { BASE, HUNKS, FOLD_HUNKS, unapplyPhotosIndex, unapplyPhotosFold };
