'use strict';

// Rewards Phase B1 — apply a validated redemption to the order pricing + the ONE legal factura line
// representation. Pure + fail-closed: ANY reconcile violation → { ok:false, error } so the handler makes the
// order non-payable (all-or-nothing). line_gross_cents are TAX-INCLUSIVE (Σ === total_cents); per-line bases
// (reconcileLineBases) foot to subtotal_cents; all bases ≥ 0 (subtotal ≠ total under the x_pizza ISV split).
//
//   X. Pizza (discount): SPLIT the cheapest pizza's line into (a) a FREE base unit at 0, (b) the paid
//     remainder (qty−1 base units), (c) a PAID extras line (extras are NEVER freed). discountedTotal =
//     total − baseUnit. The free 0-line is placed FIRST so reconcileLineBases' residual always lands on a
//     PAID line → no base can go negative.
//   La Musa (add_free): breakdown UNCHANGED (the free item is a 0-price line, total unaffected); NO platform
//     factura (la_musa's POS issues its own) — factura_items is null, the free item is a display-only line.
const { orderBreakdownCents } = require('./order-money');
const { pricedLineItems } = require('./factura/pricing');
const { reconcileLineBases } = require('./factura/money');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');

function applyRedemptionToPricing({ items, restaurantId, redemption, totalLempiras }) {
  try {
    if (!redemption || redemption.ok !== true) return { ok: false, error: 'no_redemption' };
    if (!Number.isFinite(Number(totalLempiras))) return { ok: false, error: 'bad_total' };
    if (redemption.model === 'discount' && restaurantId === 'x_pizza') return applyXPizza(items, redemption, Number(totalLempiras));
    if (redemption.model === 'add_free' && restaurantId === 'la_musa') return applyLaMusa(redemption, Number(totalLempiras));
    return { ok: false, error: 'model_restaurant_mismatch' };
  } catch (e) { console.warn('applyRedemptionToPricing:', e && e.message); return { ok: false, error: 'error' }; }
}

function applyXPizza(items, redemption, totalLempiras) {
  const menu = MENU_BY_RESTAURANT.x_pizza, extra = EXTRAS_BY_RESTAURANT.x_pizza;
  const priced = pricedLineItems(items, menu, extra);                                 // mirrors computeServerTotal exactly
  if (priced.error) return { ok: false, error: priced.error };
  const idx = redemption.freeItem && redemption.freeItem.line_index;
  const name = redemption.freeItem && redemption.freeItem.line_key;
  if (!Number.isInteger(idx) || idx < 0 || idx >= priced.items.length || !Object.prototype.hasOwnProperty.call(menu, name)) return { ok: false, error: 'bad_free_item' };
  const cartLine = items[idx];
  const Q = Number(cartLine && cartLine.qty);
  if (!Number.isInteger(Q) || Q < 1) return { ok: false, error: 'bad_free_item' };
  const baseUnitCents = menu[name] * 100;
  if (baseUnitCents !== redemption.discount_cents) return { ok: false, error: 'discount_mismatch' };   // canonical must match the server menu
  const origGross = priced.items[idx].line_gross_cents;
  const extrasCents = origGross - menu[name] * Q * 100;                               // folded extras (added once, qty-independent)
  if (extrasCents < 0) return { ok: false, error: 'extras_invariant' };
  const extraNames = (Array.isArray(cartLine.extras) ? cartLine.extras : []).map((e) => e && e.name).filter(Boolean);

  // Split: free base unit first (0), then paid remainder + paid extras, then the untouched other lines.
  const freeLine = { qty: 1, description: `${name} (Recompensa)`, line_gross_cents: 0 };
  const paid = [];
  priced.items.forEach((ln, i) => {
    if (i !== idx) { paid.push(ln); return; }
    if (Q > 1) paid.push({ qty: Q - 1, description: name, line_gross_cents: menu[name] * (Q - 1) * 100 });
    if (extrasCents > 0) paid.push({ qty: 1, description: extraNames.length ? `${name} (+${extraNames.join(', ')})` : `${name} (adicionales)`, line_gross_cents: extrasCents });
  });
  const factura_items = [freeLine, ...paid];

  const discountedLempiras = totalLempiras - menu[name];
  if (!(discountedLempiras >= 0)) return { ok: false, error: 'negative_total' };
  const bd = orderBreakdownCents(discountedLempiras, 'x_pizza');

  // fail-closed money invariants
  const sum = factura_items.reduce((s, l) => s + l.line_gross_cents, 0);
  if (sum !== bd.total_cents) return { ok: false, error: 'reconcile_mismatch' };       // Σ line_gross === total_cents
  const bases = reconcileLineBases(factura_items.map((l) => l.line_gross_cents), bd.subtotal_cents);
  if (bases.some((b) => b < 0) || bases.reduce((a, b) => a + b, 0) !== bd.subtotal_cents) return { ok: false, error: 'base_invariant' };

  return { ok: true, restaurant_id: 'x_pizza', total_lempiras: discountedLempiras, total_cents: bd.total_cents,
    subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents, discount_cents: redemption.discount_cents, factura_items, free_line: freeLine };
}

function applyLaMusa(redemption, totalLempiras) {
  const bd = orderBreakdownCents(totalLempiras, 'la_musa');                            // no ISV split: subtotal == total, tax 0
  const itemId = redemption.freeItem && redemption.freeItem.item_id;
  if (!itemId) return { ok: false, error: 'bad_free_item' };
  // No platform factura for la_musa (its POS issues the fiscal doc) → factura_items null. The free item is a
  // 0-price DISPLAY line (name plumbed from the redeem request in Task 5/6 — money-safe, price is server-0).
  return { ok: true, restaurant_id: 'la_musa', total_lempiras: totalLempiras, total_cents: bd.total_cents,
    subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents, discount_cents: 0, factura_items: null,
    free_line: { item_id: itemId, qty: 1, price_cents: 0, added: true } };
}

module.exports = { applyRedemptionToPricing };
