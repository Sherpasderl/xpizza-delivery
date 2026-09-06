'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2a — THE PRE-FLIP PARITY GATE. The cornerstone of the cutover's safety claim.
//
// The claim is that publishing from the source store is a provable NO-OP. That is only true if
// something explicitly compares what the STORE builds against what the CODE builds and refuses the
// flip unless they are canonically identical.
//
// WHY publishVersion's OWN INTEGRITY CHECK IS NOT ENOUGH. That check recomputes the descriptor from
// the docs it just wrote and compares it to the record it just wrote — it proves the write round-
// tripped intact. It is SELF-consistency, and a store carrying a wrong-but-positive price is perfectly
// self-consistent: it publishes, hashes cleanly, verifies cleanly, and charges the wrong price. The 1a
// value guard does not see it either, because the wrong price is still a positive integer. This gate
// is the only thing standing there, so it runs BEFORE flipPointer and throws rather than returning
// false — a caller must not be able to ignore it.
// ---------------------------------------------------------------------------
const { integrityDescriptor } = require('./catalog-integrity');
const { canonicalize } = require('./source-store');

// Everything that defines "the same catalog": the counts and both full content hashes (from
// catalog-integrity, so publisher and reader compute byte-identical values), plus the STRUCTURE —
// item_order, categories, variants, gate cats — which the hashes do not cover. A reordered menu has
// identical price hashes and is not the same catalog.
function catalogDescriptor(restaurantId, built) {
  const menuTable = {};
  for (const i of built.items) menuTable[i.key] = i.price;
  const extraTable = built.extras || {};
  return {
    restaurant_id: restaurantId,
    ...integrityDescriptor(menuTable, extraTable),
    structure: canonicalize(built.structure),
    display_hash: displayHash(built.items),
  };
}

// The display records are menu content too — a portal edit to a description or photo flag changes what
// customers see, and no price hash would notice. Canonicalized so property order cannot fake a
// difference, but ORDER-SENSITIVE across items, because item order is content.
function displayHash(items) {
  const crypto = require('crypto');
  const payload = items.map((i) => canonicalize({ key: i.key, display: i.display, has_photo: i.has_photo === undefined ? null : i.has_photo }));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// Throw unless the two builds are canonically identical. Names the diverging field: an operator
// aborting a cutover at 2am needs to know WHAT differed, not just that something did.
function assertStoreCodeParity(restaurantId, storeBuilt, codeBuilt) {
  const s = catalogDescriptor(restaurantId, storeBuilt);
  const c = catalogDescriptor(restaurantId, codeBuilt);
  const diffs = [];
  for (const field of ['item_count', 'extra_count', 'menu_hash', 'extras_hash', 'display_hash']) {
    if (s[field] !== c[field]) diffs.push(`${field}: store ${String(s[field]).slice(0, 16)} != code ${String(c[field]).slice(0, 16)}`);
  }
  if (JSON.stringify(s.structure) !== JSON.stringify(c.structure)) diffs.push('structure: item_order/categories/variants/gate-cats differ');
  if (diffs.length) {
    throw new Error(`parity_mismatch: ${restaurantId} — build-from-store differs from build-from-code; the flip is REFUSED. ${diffs.join(' | ')}`);
  }
  return true;
}

module.exports = { catalogDescriptor, assertStoreCodeParity, displayHash };
