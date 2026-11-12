'use strict';
// «Quitar del menú» (PLAN-portal-remove-product-r1 P-R5, decision D-4) — THE platform switch for removing a dish from the menu: ONE value
// for every restaurant (no brand branch), OFF at ship. OFF = today exactly: a removal that takes a dish's own override / extras_by_item /
// item-level reward entry with it is refused (structure_changed), a declared removal still rename-pairs in the review diff, and the
// editor read carries none of productRemoval / pendingRemovals / rewardKeys. ON (a one-line flip, the portal's rollback lever with no
// portal deploy): P-R1..P-R4 apply. Read by the comparator's callers, the diff's callers and getEditableCatalog.
const PRODUCT_REMOVAL = false;

function removalCapabilities() {
  return { productRemoval: PRODUCT_REMOVAL === true };
}

module.exports = { removalCapabilities };
