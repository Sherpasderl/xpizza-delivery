'use strict';

// Rewards Redemption v2 — apply a validated ADD-FREE redemption to the order pricing + factura lines. Pure +
// fail-closed: ANY reconcile violation → { ok:false, error } so the handler makes the order non-payable.
// BOTH brands are add_free in v2: the reward item(s) are ADDED at L0, so the PAID total (what the customer is
// charged) is UNCHANGED.
//   X. Pizza (A-F fiscal treatment, restored): the comped pizza is a FULL-VALUE line on the platform SAR
//     factura + an explicit "Desc. y Reb. Otorg" (`desc_rebaja_cents` = FULL net − PAID net) that nets it to
//     L0. `factura_items` = the paid cart lines PLUS the comped full-value line (Σ line_gross === the FULL,
//     as-if-sold total); footing by construction (Σ base − rebaja === gravado === paid subtotal; subtotal +
//     ISV === paid total). The comped line carries `redeemed:true` and lands ONLY in `factura_items` — the
//     separate `items` (= the paid cart lines) is what feeds `order.items` / the earn base, so the free pizza
//     NEVER earns its own punch (X. Pizza earn = Σ qty of the PAID cart only).
//   La Musa: no platform factura (its POS issues the fiscal doc) → factura_items null; free items are 0-price
//     display lines (one per redeemed item, qty-aware).
const { orderBreakdownCents } = require('./order-money');
const { pricedLineItems } = require('./factura/pricing');
const { reconcileLineBases } = require('./factura/money');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, resolvePriceTables } = require('./menu-pricing');

// 1b-1b FISCAL (owner-approved): this produces the REDEEMED X. Pizza factura value (factura_items +
// desc_rebaja_cents). Threading `tables` moves only the SOURCE — the value is byte-identical while the
// parity guard holds. The NON-redeem factura path (index.js pricedLineItems / MENU_PRICES) stays on code
// until 1b-2 and is deliberately untouched here.
function applyRedemptionToPricing({ items, restaurantId, redemption, totalLempiras, tables = null }) {
  try {
    if (!redemption || redemption.ok !== true) return { ok: false, error: 'no_redemption' };
    if (redemption.model !== 'add_free') return { ok: false, error: 'model_restaurant_mismatch' };
    if (!Number.isFinite(Number(totalLempiras))) return { ok: false, error: 'bad_total' };
    if (restaurantId === 'x_pizza') return applyXPizza(items, redemption, Number(totalLempiras), tables);
    if (restaurantId === 'la_musa') return applyLaMusa(redemption, Number(totalLempiras));
    return { ok: false, error: 'model_restaurant_mismatch' };
  } catch (e) { console.warn('applyRedemptionToPricing:', e && e.message); return { ok: false, error: 'error' }; }
}

// free_lines from the calculator's freeItems — every reward item is a server-0 line (the customer never pays it).
function freeLinesFrom(redemption) {
  const fis = Array.isArray(redemption.freeItems) ? redemption.freeItems : [];
  return fis.map((fi) => ({ item_id: fi.item_id, qty: Number(fi.qty) || 1, price_cents: 0, added: true }));
}

function applyXPizza(items, redemption, totalLempiras, tables = null) {
  const t = resolvePriceTables('x_pizza', tables);                       // PIN B asserts the tag
  const menu = t.menu, extra = t.extraPrices;
  const priced = pricedLineItems(items, menu, extra);                                  // the PAID cart lines (mirrors computeServerTotal)
  if (priced.error) return { ok: false, error: priced.error };
  const free_lines = freeLinesFrom(redemption);
  if (free_lines.length !== 1 || !Object.prototype.hasOwnProperty.call(menu, free_lines[0].item_id)) return { ok: false, error: 'bad_free_item' };
  const freeName = free_lines[0].item_id;
  const freeQty = Number(free_lines[0].qty);
  if (!Number.isInteger(freeQty) || freeQty < 1) return { ok: false, error: 'bad_free_item' };
  const unitCents = menu[freeName] * 100;                                              // the server menu is the source of truth for value
  const fi0 = (redemption.freeItems || [])[0] || {};                                   // free_lines zeroes price_cents (0-price display); the real menu-derived price is on the canonical
  if (unitCents !== Number(fi0.price_cents)) return { ok: false, error: 'discount_mismatch' };   // the canonical's server-derived price MUST match the current server menu
  const compedGross = unitCents * freeQty;

  // A-F: the comped pizza is a FULL-VALUE factura line (the customer's chosen 12"; extras are NEVER comped),
  // marked `redeemed` so it lands ONLY in factura_items — never in `items` / order.items / the earn base.
  const compedLine = { qty: freeQty, description: freeName, line_gross_cents: compedGross, redeemed: true };
  const factura_items = priced.items.concat([compedLine]);

  const paid = orderBreakdownCents(totalLempiras, 'x_pizza');                          // PAID (what is charged) — money spine, UNCHANGED
  const full = orderBreakdownCents(totalLempiras + menu[freeName] * freeQty, 'x_pizza'); // FULL (paid + comped) — the as-if-sold breakdown

  // fail-closed money invariants (A-F): any violation → { ok:false } → non-payable order
  const fullGross = factura_items.reduce((s, l) => s + l.line_gross_cents, 0);
  if (fullGross !== full.total_cents) return { ok: false, error: 'reconcile_mismatch' };            // Σ line_gross === FULL total
  if (full.total_cents - paid.total_cents !== compedGross) return { ok: false, error: 'discount_reconcile' }; // full − paid === comped gross
  const desc_rebaja_cents = full.subtotal_cents - paid.subtotal_cents;                 // net comped value (exact residual → foots to the centavo)
  if (desc_rebaja_cents < 0) return { ok: false, error: 'rebaja_invariant' };
  const bases = reconcileLineBases(factura_items.map((l) => l.line_gross_cents), full.subtotal_cents);
  if (bases.some((b) => b < 0) || bases.reduce((a, b) => a + b, 0) !== full.subtotal_cents) return { ok: false, error: 'base_invariant' };

  // `items` (paid-only) → order.items / the earn base; `factura_items` (paid + comped) → order.factura_items / SAR factura.
  // discount_cents stays 0: add-free never discounts the CHARGED total (the customer-facing quote shows savings
  // separately); the comp is a FISCAL rebaja carried by desc_rebaja_cents, not a discount to the bill.
  return { ok: true, restaurant_id: 'x_pizza', total_lempiras: totalLempiras, total_cents: paid.total_cents,
    subtotal_cents: paid.subtotal_cents, tax_cents: paid.tax_cents, discount_cents: 0, desc_rebaja_cents,
    items: priced.items, factura_items, free_lines };
}

function applyLaMusa(redemption, totalLempiras) {
  const bd = orderBreakdownCents(totalLempiras, 'la_musa');                            // no ISV split: subtotal == total, tax 0
  const free_lines = freeLinesFrom(redemption);
  if (free_lines.length === 0) return { ok: false, error: 'bad_free_item' };
  return { ok: true, restaurant_id: 'la_musa', total_lempiras: totalLempiras, total_cents: bd.total_cents,
    subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents, discount_cents: 0, factura_items: null, free_lines };
}

module.exports = { applyRedemptionToPricing };
