'use strict';

// Rewards Phase B1 — apply a validated redemption to the order pricing + the ONE legal factura line
// representation. Pure + fail-closed: ANY reconcile violation → { ok:false, error } so the handler makes the
// order non-payable (all-or-nothing). line_gross_cents are TAX-INCLUSIVE.
//
//   X. Pizza (discount, A-F): the factura shows the FULL-VALUE line items UNCHANGED (Σ line_gross === the
//     FULL, pre-discount total) plus an explicit "Desc. y Reb. Otorg" (desc_rebaja_cents) for the comped
//     base unit. SAR: a discount stated on the factura leaves the base gravable → ISV computes on the NET
//     (paid) amount, the comped ISV is 0, a fully-comped order issues 0/0/0. The DISCOUNTED breakdown
//     (subtotal/tax/total) is the money spine and preserves subtotal + tax === total; the comp is carried by
//     desc_rebaja_cents (= FULL net − paid net), never baked into 0-price lines. extras are NEVER comped.
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
  if (origGross - menu[name] * Q * 100 < 0) return { ok: false, error: 'extras_invariant' };           // the line must cover its own base units

  // A-F: factura_items are the FULL-VALUE lines, untouched (no 0-price split). The comp is carried by an
  // explicit desc_rebaja_cents; the item PRECIOs print at full value, the rebaja line states the discount.
  const factura_items = priced.items;

  const discountedLempiras = totalLempiras - menu[name];
  if (!(discountedLempiras >= 0)) return { ok: false, error: 'negative_total' };
  const bd = orderBreakdownCents(discountedLempiras, 'x_pizza');                        // DISCOUNTED (paid) — money spine
  const full = orderBreakdownCents(totalLempiras, 'x_pizza');                           // FULL (pre-discount) breakdown

  // fail-closed money invariants
  const fullGross = factura_items.reduce((s, l) => s + l.line_gross_cents, 0);
  if (fullGross !== full.total_cents) return { ok: false, error: 'reconcile_mismatch' };            // Σ line_gross === FULL total
  if (full.total_cents - bd.total_cents !== redemption.discount_cents) return { ok: false, error: 'discount_reconcile' }; // full − paid === comped gross
  const desc_rebaja_cents = full.subtotal_cents - bd.subtotal_cents;                    // net comped value (exact residual → foots)
  if (desc_rebaja_cents < 0) return { ok: false, error: 'rebaja_invariant' };
  // full-value bases foot to the FULL net; gravado = paid net = FULL net − rebaja (the factura reconciles both)
  const bases = reconcileLineBases(factura_items.map((l) => l.line_gross_cents), full.subtotal_cents);
  if (bases.some((b) => b < 0) || bases.reduce((a, b) => a + b, 0) !== full.subtotal_cents) return { ok: false, error: 'base_invariant' };

  return { ok: true, restaurant_id: 'x_pizza', total_lempiras: discountedLempiras, total_cents: bd.total_cents,
    subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents, discount_cents: redemption.discount_cents,
    desc_rebaja_cents, factura_items };
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
