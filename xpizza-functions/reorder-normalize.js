'use strict';

// P3 reorder recipe — shared pure normalizer. Mirrors computeServerTotal's per-restaurant matching
// (menu-pricing.js itemPricingKey: x_pizza keys by item.name, la_musa by item.id). Produces a
// MENU-ALLOWLISTED recipe: every item key + option key is validated against the CURRENT menu; anything
// the menu doesn't recognize is DROPPED, never stored. NO raw client names/prices are persisted (they
// would be an XSS/trust vector) — only menu-recognized keys + qty. Display uses the sanitized
// items_text; reorder re-resolves today's name/price from the menu by key. Guest/empty/malformed → [].
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, itemPricingKey } = require('./menu-pricing');

const MAX_LINES = 100;   // bounded to a real order's line count (defensive cap)

function normalizeReorderItems(bodyItems, restaurantId) {
  const menu = MENU_BY_RESTAURANT[restaurantId];
  const extraPrices = EXTRAS_BY_RESTAURANT[restaurantId] || {};
  if (!menu || !Array.isArray(bodyItems)) return [];
  const byId = restaurantId === 'la_musa';   // la_musa extras are id-keyed/qty-aware; x_pizza name-keyed/count-once
  const out = [];
  for (const it of bodyItems) {
    if (out.length >= MAX_LINES) break;
    const key = itemPricingKey(it, restaurantId);
    if (!key || !Object.prototype.hasOwnProperty.call(menu, key)) continue;   // unknown item → drop
    const qty = Number(it && it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) continue;              // invalid qty → drop
    const line = { key, qty };
    const extras = Array.isArray(it && it.extras) ? it.extras : [];
    const opts = [];
    const seen = new Set();
    for (const ex of extras) {
      if (byId) {
        const eid = ex && ex.id;
        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid) || seen.has(eid)) continue;
        const eqty = Number(ex && ex.qty);
        if (!Number.isInteger(eqty) || eqty < 1 || eqty > 50) continue;
        seen.add(eid);
        opts.push({ id: eid, qty: eqty });
      } else {
        const ename = ex && ex.name;
        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename) || seen.has(ename)) continue;
        seen.add(ename);
        opts.push({ name: ename });
      }
    }
    if (opts.length) line.options = opts;
    out.push(line);
  }
  return out;
}

module.exports = { normalizeReorderItems };
