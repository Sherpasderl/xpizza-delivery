'use strict';
// ---------------------------------------------------------------------------
// Phase 1c-a — the DISPLAY reader. Returns the full schema-v2 menu (per-item display records +
// the menu_structure doc) so 1c-b generates the form bundle and the KDS manifest from the catalog.
//
// 1c-b2 — resolves the SAME `active_version` pointer the pricing reader uses (via getActiveVersionId),
// so one consistent path: a version's menu_items + its own meta/menu_structure. Same POINTER-ABSENT vs
// ERROR split — a clean pointer-absent falls back to the flat layout (un-migrated); a malformed pointer /
// read error / version-missing / completeness fail THROWS (a display fault renders "no menu" loudly rather
// than a plausible-empty). Non-money, but shares resolveActiveVersion for coherence with the money path.
//
// Deliberately SEPARATE from getRestaurantDocs (the pricing reader) — pricing cannot be affected by a
// display field, and a display bug cannot reach the money path.
// ---------------------------------------------------------------------------
const { buildTablesFromDocs } = require('./catalog-transform');
const { getActiveVersionId } = require('./catalog-firestore');
const { assertComplete } = require('./catalog-integrity');

// Shared: validate the schema-v2 menu_items snapshot + the menu_structure doc into { items, structure }.
// A missing/empty menu, a v1 (display-less) doc, a dup key, or a non-bijective item_order all THROW —
// a half-migrated menu must never render. `where` tags errors with the flat-rid or the version path.
function buildMenuFromSnapshot(items, structureSnap, where) {
  if (items.empty) throw new Error(`catalog_empty: ${where}`);
  if (!structureSnap.exists) throw new Error(`menu_structure_missing: ${where}`);
  const structure = structureSnap.data() || {};
  if (!Array.isArray(structure.item_order) || structure.item_order.length === 0) {
    throw new Error(`menu_structure_bad: ${where} — item_order missing/empty`);
  }
  const seen = new Set();
  const records = items.docs.map((d) => {
    const v = d.data() || {};
    if (typeof v.key !== 'string' || !v.key) throw new Error(`catalog_bad_doc: ${where}/${d.id} — missing/non-string key`);
    if (seen.has(v.key)) throw new Error(`catalog_dup_key: ${where}/${v.key}`);
    seen.add(v.key);
    if (!v.display || typeof v.display !== 'object') throw new Error(`catalog_missing_display: ${where}/${v.key}`);
    const rec = { key: v.key, price: v.price, display: v.display };
    if (v.has_photo !== undefined) rec.has_photo = v.has_photo;
    return rec;
  });
  // item_order must be a genuine BIJECTION with the records (unique + all-exist + equal-length).
  const byKey = new Map(records.map((r) => [r.key, r]));
  if (new Set(structure.item_order).size !== structure.item_order.length) {
    throw new Error(`menu_structure_bad: ${where} — item_order has duplicate keys`);
  }
  for (const k of structure.item_order) {
    if (!byKey.has(k)) throw new Error(`menu_structure_bad: ${where} — item_order references missing item ${k}`);
  }
  if (structure.item_order.length !== records.length) {
    throw new Error(`menu_structure_bad: ${where} — item_order covers ${structure.item_order.length} of ${records.length} items`);
  }
  return { items: structure.item_order.map((k) => byKey.get(k)), structure, records };
}

async function readVersionMenu(db, restaurantId, versionId) {
  const vref = db.collection('restaurants').doc(restaurantId).collection('versions').doc(versionId);
  const [recSnap, items, structureSnap, extras] = await Promise.all([
    vref.get(), vref.collection('menu_items').get(), vref.collection('meta').doc('menu_structure').get(), vref.collection('extras').get(),
  ]);
  if (!recSnap.exists) throw new Error(`version_missing: ${restaurantId}/${versionId}`);
  const where = `${restaurantId}/versions/${versionId}`;
  const built = buildMenuFromSnapshot(items, structureSnap, where);
  // Completeness-on-read (defense-in-depth, shares the integrity descriptor with the pricing reader):
  // the version's menu_items + extras must match the record's counts + full hashes.
  const menuTable = {}; for (const r of built.records) menuTable[r.key] = r.price;
  const { extras: extraTable } = buildTablesFromDocs([], extras.docs.map((d) => d.data() || {}));
  assertComplete(recSnap.data() || {}, menuTable, extraTable, where);
  return { items: built.items, structure: built.structure };
}

async function readFlatMenu(db, restaurantId) {
  const rref = db.collection('restaurants').doc(restaurantId);
  const [profile, items, structureSnap] = await Promise.all([
    rref.get(), rref.collection('menu_items').get(), rref.collection('meta').doc('menu_structure').get(),
  ]);
  if (!profile.exists) throw new Error(`restaurant_not_found: ${restaurantId}`);
  const built = buildMenuFromSnapshot(items, structureSnap, restaurantId);
  return { items: built.items, structure: built.structure };
}

async function getRestaurantMenu(db, restaurantId) {
  const versionId = await getActiveVersionId(db, restaurantId);   // throws on malformed / read error
  if (versionId == null) return readFlatMenu(db, restaurantId);    // clean-absent → flat (throws if profile absent)
  return readVersionMenu(db, restaurantId, versionId);
}
module.exports = { getRestaurantMenu };
