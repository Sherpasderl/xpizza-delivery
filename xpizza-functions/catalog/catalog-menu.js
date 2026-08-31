'use strict';
// ---------------------------------------------------------------------------
// Phase 1c-a — the DISPLAY reader. Returns the full schema-v2 menu (per-item display records +
// the menu_structure doc) so 1c-b can generate the form bundle and the KDS manifest from the
// catalog instead of hand-syncing them.
//
// DORMANT in 1c-a: nothing calls this. It ships read-by-nothing so the schema, the seed and the
// round-trip proof can be gated before anything depends on them.
//
// Deliberately SEPARATE from getRestaurantDocs (the pricing reader), which stays byte-unchanged and
// keeps returning {key, price} only (PIN 1). Two readers over one store: pricing cannot be affected
// by a display field, and a display bug cannot reach the money path.
//
// Same trust-boundary discipline as the pricing reader — a missing, empty or malformed catalog
// throws rather than reading back as a plausible-empty menu, which would render as "no menu" instead
// of failing loudly.
// ---------------------------------------------------------------------------
async function getRestaurantMenu(db, restaurantId) {
  const rref = db.collection('restaurants').doc(restaurantId);
  const [profile, items, structureSnap] = await Promise.all([
    rref.get(),
    rref.collection('menu_items').get(),
    rref.collection('meta').doc('menu_structure').get(),
  ]);
  if (!profile.exists) throw new Error(`restaurant_not_found: ${restaurantId}`);
  if (items.empty) throw new Error(`catalog_empty: ${restaurantId}`);
  if (!structureSnap.exists) throw new Error(`menu_structure_missing: ${restaurantId}`);

  const structure = structureSnap.data() || {};
  if (!Array.isArray(structure.item_order) || structure.item_order.length === 0) {
    throw new Error(`menu_structure_bad: ${restaurantId} — item_order missing/empty`);
  }

  const seen = new Set();
  const records = items.docs.map((d) => {
    const v = d.data() || {};
    if (typeof v.key !== 'string' || !v.key) throw new Error(`catalog_bad_doc: ${restaurantId}/${d.id} — missing/non-string key`);
    if (seen.has(v.key)) throw new Error(`catalog_dup_key: ${restaurantId}/${v.key}`);
    seen.add(v.key);
    // A schema-v2 store must carry a display record for every item; a v1 doc here means the
    // schema-v2 seed did not complete, and a half-migrated menu must not render.
    if (!v.display || typeof v.display !== 'object') throw new Error(`catalog_missing_display: ${restaurantId}/${v.key}`);
    const rec = { key: v.key, price: v.price, display: v.display };
    if (v.has_photo !== undefined) rec.has_photo = v.has_photo;
    return rec;
  });

  // item_order is the regeneration contract, and it must be a genuine BIJECTION with the records.
  // Three checks, and all three are load-bearing — any two of them can be satisfied while the menu is
  // still wrong. Existence alone permits duplicates; existence + length permits [A,A] over records
  // [A,B], which passes (both exist, 2 === 2) and silently DROPS B — a partial menu, exactly what this
  // reader promises it cannot return. Uniqueness closes it: unique + all-exist + equal-length together
  // prove every stored item is emitted exactly once, in a defined order.
  const byKey = new Map(records.map((r) => [r.key, r]));
  if (new Set(structure.item_order).size !== structure.item_order.length) {
    throw new Error(`menu_structure_bad: ${restaurantId} — item_order has duplicate keys`);
  }
  for (const k of structure.item_order) {
    if (!byKey.has(k)) throw new Error(`menu_structure_bad: ${restaurantId} — item_order references missing item ${k}`);
  }
  if (structure.item_order.length !== records.length) {
    throw new Error(`menu_structure_bad: ${restaurantId} — item_order covers ${structure.item_order.length} of ${records.length} items`);
  }
  return { items: structure.item_order.map((k) => byKey.get(k)), structure };
}
module.exports = { getRestaurantMenu };
