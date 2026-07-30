'use strict';

// Rewards Redemption v2 — apply a validated ADD-FREE redemption to the order pricing + factura lines. Pure +
// fail-closed: ANY reconcile violation → { ok:false, error } so the handler makes the order non-payable.
// BOTH brands are add_free in v2: the reward item(s) are ADDED at L0, so the PAID total is UNCHANGED — no
// discount math, no desc_rebaja. The free items are DISPLAY/kitchen lines (`free_lines`), never a sold line.
//   X. Pizza: the platform SAR factura shows the FULL-VALUE PAID line items, untouched — the comped pizza is a
//     giveaway, NOT a sale, so it is not a fiscal line. Σ line_gross === the (unchanged) total.
//   La Musa: no platform factura (its POS issues the fiscal doc) → factura_items null; free items are 0-price
//     display lines (one per redeemed item, qty-aware).
const { orderBreakdownCents } = require('./order-money');
const { pricedLineItems } = require('./factura/pricing');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');

function applyRedemptionToPricing({ items, restaurantId, redemption, totalLempiras }) {
  try {
    if (!redemption || redemption.ok !== true) return { ok: false, error: 'no_redemption' };
    if (redemption.model !== 'add_free') return { ok: false, error: 'model_restaurant_mismatch' };
    if (!Number.isFinite(Number(totalLempiras))) return { ok: false, error: 'bad_total' };
    if (restaurantId === 'x_pizza') return applyXPizza(items, redemption, Number(totalLempiras));
    if (restaurantId === 'la_musa') return applyLaMusa(redemption, Number(totalLempiras));
    return { ok: false, error: 'model_restaurant_mismatch' };
  } catch (e) { console.warn('applyRedemptionToPricing:', e && e.message); return { ok: false, error: 'error' }; }
}

// free_lines from the calculator's freeItems — every reward item is a server-0 line (the customer never pays it).
function freeLinesFrom(redemption) {
  const fis = Array.isArray(redemption.freeItems) ? redemption.freeItems : [];
  return fis.map((fi) => ({ item_id: fi.item_id, qty: Number(fi.qty) || 1, price_cents: 0, added: true }));
}

function applyXPizza(items, redemption, totalLempiras) {
  const menu = MENU_BY_RESTAURANT.x_pizza, extra = EXTRAS_BY_RESTAURANT.x_pizza;
  const priced = pricedLineItems(items, menu, extra);                                  // mirrors computeServerTotal exactly
  if (priced.error) return { ok: false, error: priced.error };
  const free_lines = freeLinesFrom(redemption);
  if (free_lines.length !== 1 || !Object.prototype.hasOwnProperty.call(menu, free_lines[0].item_id)) return { ok: false, error: 'bad_free_item' };
  // The free pizza is a giveaway → NOT a fiscal line. Factura = the FULL-VALUE PAID items; total unchanged.
  const factura_items = priced.items;
  const bd = orderBreakdownCents(totalLempiras, 'x_pizza');                             // UNCHANGED total (no discount)
  const fullGross = factura_items.reduce((s, l) => s + l.line_gross_cents, 0);
  if (fullGross !== bd.total_cents) return { ok: false, error: 'reconcile_mismatch' };  // Σ line_gross === total (foots)
  return { ok: true, restaurant_id: 'x_pizza', total_lempiras: totalLempiras, total_cents: bd.total_cents,
    subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents, discount_cents: 0, desc_rebaja_cents: 0, factura_items, free_lines };
}

function applyLaMusa(redemption, totalLempiras) {
  const bd = orderBreakdownCents(totalLempiras, 'la_musa');                            // no ISV split: subtotal == total, tax 0
  const free_lines = freeLinesFrom(redemption);
  if (free_lines.length === 0) return { ok: false, error: 'bad_free_item' };
  return { ok: true, restaurant_id: 'la_musa', total_lempiras: totalLempiras, total_cents: bd.total_cents,
    subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents, discount_cents: 0, factura_items: null, free_lines };
}

module.exports = { applyRedemptionToPricing };
