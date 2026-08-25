'use strict';
const { buildTablesFromDocs } = require('./catalog-transform');
// Reads a restaurant's pricing tables from the (injected) Firestore doc source, shaped exactly like
// menu-pricing.js's MENU_BY_RESTAURANT[rid]/EXTRAS_BY_RESTAURANT[rid]. Per-restaurant cache.
// CONTRACT (grill Q5): a read failure / not-found from getRestaurantDocs PROPAGATES (throws) and is
// NEVER cached — only SUCCESSFUL lookups are cached. So 1b can fall back to the code tables on failure
// instead of caching a plausible-empty non-answer (which would mislead as "unknown menu item" during a
// catalog outage and downgrade the "unknown restaurant" guard, since {} is truthy).
function createCatalogReader({ getRestaurantDocs, cacheTtlMs = 300000, now = Date.now }) {
  const cache = new Map(); // restaurantId -> { at, tables }
  async function getTables(restaurantId) {
    const hit = cache.get(restaurantId);
    if (hit && (now() - hit.at) < cacheTtlMs) return hit.tables;
    const { itemDocs, extraDocs } = await getRestaurantDocs(restaurantId); // throw propagates → NOT cached
    const tables = buildTablesFromDocs(itemDocs, extraDocs);
    cache.set(restaurantId, { at: now(), tables });                        // cache ONLY on success
    return tables;
  }
  return { getTables };
}
module.exports = { createCatalogReader };
