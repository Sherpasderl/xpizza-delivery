'use strict';
// ---------------------------------------------------------------------------
// «Quitar del menú» (advisor 11-13, portal-ui T22/T22b) — THE one reading of a deletion claim's ids, in both shapes the save accepts
// (edit-catalog-handler.js, `declaredIds`): an OBJECT { ids, … } (what the store keeps) → its `ids`; anything else as sent — the
// ARRAY the portal's ONE writer (xpizza-portal/editor.js mergeDeletionClaim) sends is the ids themselves. A reader that runs BEFORE
// the save normalizes the claim reads it through here, never `.ids` alone (removalDiffOptions at the photo gate did, and refused
// a real portal removal with photo_change_disabled). Not an array ⇒ no ids: the save's own checks refuse a malformed claim. Pure.
// ---------------------------------------------------------------------------
function claimIds(claim) {
  return claim && typeof claim === 'object' && !Array.isArray(claim) ? claim.ids : claim;
}

module.exports = { claimIds };
