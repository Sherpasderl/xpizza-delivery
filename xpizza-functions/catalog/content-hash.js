'use strict';
// ---------------------------------------------------------------------------
// Portal 1A Task 5 — THE VERSION CONTENT HASH: one fingerprint over the WHOLE served payload.
//
// 🔴 WHY THIS IS NOT integrityDescriptor. That descriptor hashes {key: price} and nothing else, which
// is correct for what it guards (money: a torn or tampered PRICE read). But it means two versions
// that differ only in a dish name, a category order, a badge, an option-group exposure or a variant
// list produce IDENTICAL menu_hash/extras_hash — they collide. Once 1B serves display data and 1C
// charges against it, "same prices" stops being the same thing as "same menu", and a version skew
// that changes what a customer SEES would be invisible to every check we have.
//
// So this covers everything the catalog serves: prices AND display records AND exposure AND ordering
// AND categories AND variants. The money descriptor is untouched and keeps its own narrow job — two
// hashes with two purposes, neither standing in for the other.
//
// ORDER IS CONTENT. The payload is hashed in SERVED order (item_order / extra_order), not in the
// order Firestore happened to return the docs — reordering a menu is a change a customer sees, and a
// hash that missed it would certify the reorder as "no change".
//
// ONE DEFINITION, THREE CALLERS. The reader (catalog-menu), the publisher (catalog-publish, which
// pins it into the version record) and the preview path all compute it here. A second copy anywhere
// would be a hash that agrees until someone edits one of them.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { canonicalJson } = require('./canonical-json');

// The exact projection that gets served, named field by field. Deliberately NOT a spread of the raw
// document: an unrelated field landing on a doc (a migration marker, a debug stamp) must not change
// the fingerprint of a menu nobody edited.
function servedPayload({ rid, schema_version, items, extras, structure }) {
  const item = (i) => {
    const out = { key: i.key, price: i.price, display: i.display };
    if (i.has_photo !== undefined) out.has_photo = i.has_photo;
    return out;
  };
  return {
    rid,
    schema_version,
    items: (items || []).map(item),
    extras: (extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })),
    structure: structure || {},
  };
}

// FULL SHA-256, never truncated — same rule as the money hashes: a prefix has a birthday bound far
// too weak to be evidence about which menu is live.
function contentHash(payload) {
  return crypto.createHash('sha256').update(canonicalJson(servedPayload(payload))).digest('hex');
}

module.exports = { contentHash, servedPayload };
