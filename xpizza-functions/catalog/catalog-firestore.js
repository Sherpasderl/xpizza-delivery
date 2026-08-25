'use strict';
// Real Firestore read adapter for the catalog. Returns the {itemDocs, extraDocs} shape the pure
// buildTablesFromDocs (catalog-transform.js) consumes. Wired into createCatalogReader in 1b (not yet live).
// The TRUST BOUNDARY (Codex): malformed data must NEVER read back as a plausible success. Distinguishes
// restaurant_not_found (no profile) from catalog_empty (profile but no items) from a genuine read; and
// VALIDATES every doc — non-string/missing key, duplicate key, and any price that isn't a non-negative
// INTEGER are rejected (a non-integer price would reach `total += menu[key]*qty` in 1b → {total:NaN, error:null}).
async function getRestaurantDocs(db, restaurantId) {
  const rref = db.collection('restaurants').doc(restaurantId);
  const [profile, items, extras] = await Promise.all([rref.get(), rref.collection('menu_items').get(), rref.collection('extras').get()]);
  if (!profile.exists) throw new Error(`restaurant_not_found: ${restaurantId}`);   // not-found ≠ empty
  if (items.empty) throw new Error(`catalog_empty: ${restaurantId}`);              // known restaurant, no menu items
  const map = (snap) => {
    const seen = new Set();
    return snap.docs.map((d) => {
      const v = d.data() || {};
      if (typeof v.key !== 'string' || !v.key) throw new Error(`catalog_bad_doc: ${restaurantId}/${d.id} — missing/non-string key`);
      if (!Number.isInteger(v.price) || v.price < 0) throw new Error(`catalog_bad_doc: ${restaurantId}/${v.key} — price not a non-negative integer`);
      if (seen.has(v.key)) throw new Error(`catalog_dup_key: ${restaurantId}/${v.key}`);
      seen.add(v.key);
      return { key: v.key, price: v.price };
    });
  };
  return { itemDocs: map(items), extraDocs: map(extras) };
}
module.exports = { getRestaurantDocs };
