'use strict';
// Golden test for applyRedemptionToPricing (rewards-redeem-pricing.js) — v2 ADD-FREE. Run: node rewards-redeem-pricing.test.js
// Money invariants: BOTH brands add_free → the PAID total (what the customer is charged) is UNCHANGED.
//   X. Pizza (A-F fiscal): the comped pizza is a FULL-VALUE line on the SAR factura + an explicit
//   desc_rebaja_cents (= FULL net − PAID net) that nets it to L0. `items` (paid-only) is the earn base;
//   `factura_items` (paid + comped) is the SAR doc; Σ factura line_gross === the FULL (as-if-sold) total.
//   La Musa skips the platform factura (its POS owns the fiscal doc).
const assert = require('assert');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
const { computeRedemption } = require('./rewards-redeem');
const { computeServerTotal } = require('./menu-pricing');
const { orderBreakdownCents } = require('./order-money');
const { buildFacturaRecord } = require('./factura/build-record');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const sumGross = (its) => its.reduce((s, l) => s + l.line_gross_cents, 0);
const xpApply = (items, pizza) => {
  const total = computeServerTotal(items, 'x_pizza').total;
  const redemption = computeRedemption({ redeem: { type: 'free_pizza_choice', item_id: pizza }, items, restaurantId: 'x_pizza' });
  return { r: applyRedemptionToPricing({ items, restaurantId: 'x_pizza', redemption, totalLempiras: total }), total, redemption };
};

// ── 1. X. Pizza add-free (A-F fiscal): PAID total UNCHANGED; comped pizza = a FULL-VALUE factura line + rebaja;
//       `items` (paid-only) is the earn base, `factura_items` (paid + comped) is the SAR doc ──
{
  const menu = require('./menu-pricing').MENU_BY_RESTAURANT.x_pizza;
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const { r, total } = xpApply(items, 'Pepperoni');                       // free Pepperoni ADDED (not in the paid cart)
  const paid = orderBreakdownCents(total, 'x_pizza');
  const full = orderBreakdownCents(total + menu['Pepperoni'], 'x_pizza');
  const compedGross = menu['Pepperoni'] * 100;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total_lempiras, total); assert.strictEqual(r.total_cents, paid.total_cents); ok('xp A-F: PAID total UNCHANGED (customer charged the cart total; the free pizza nets to L0)');
  assert.strictEqual(r.discount_cents, 0); ok('xp A-F: discount_cents 0 (add-free never discounts the charged total; the comp is a fiscal rebaja)');
  assert.strictEqual(r.desc_rebaja_cents, full.subtotal_cents - paid.subtotal_cents); assert.ok(r.desc_rebaja_cents > 0); ok('xp A-F: desc_rebaja_cents === FULL net − PAID net (> 0)');
  assert.strictEqual(r.items.length, items.length); assert.ok(!r.items.some((l) => l.redeemed)); ok('xp A-F: `items` = the PAID cart only (earn base — NO comped line)');
  assert.strictEqual(r.factura_items.length, items.length + 1); ok('xp A-F: `factura_items` = paid cart + 1 comped line');
  assert.strictEqual(sumGross(r.factura_items), full.total_cents); ok('xp A-F: Σ factura line_gross === the FULL (as-if-sold) total (foots)');
  const comped = r.factura_items.filter((l) => l.redeemed);
  assert.strictEqual(comped.length, 1); assert.strictEqual(comped[0].description, 'Pepperoni'); assert.strictEqual(comped[0].qty, 1); assert.strictEqual(comped[0].line_gross_cents, compedGross); ok('xp A-F: the comped pizza is a FULL-VALUE factura line (redeemed:true)');
  assert.strictEqual(r.subtotal_cents + r.tax_cents, r.total_cents); ok('xp A-F: PAID subtotal + tax === PAID total (ISV identity on the charged amount)');
  assert.deepStrictEqual(r.free_lines, [{ item_id: 'Pepperoni', qty: 1, price_cents: 0, added: true }]); ok('xp A-F: the chosen pizza is still a single 0-price free_line (KDS/display, separate from the factura)');
}

// ── 1b. X. Pizza — an empty PAID cart fails closed (the ≥1-paid-item guard makes a fully-comped $0 order
//        unreachable in v2 add-free; a straight comped-only factura is never silently issued) ──
{
  const redemption = computeRedemption({ redeem: { type: 'free_pizza_choice', item_id: 'Pepperoni' }, items: [{ name: 'Margherita', qty: 1 }], restaurantId: 'x_pizza' });
  assert.strictEqual(applyRedemptionToPricing({ items: [], restaurantId: 'x_pizza', redemption, totalLempiras: 0 }).ok, false); ok('xp A-F: empty paid cart → ok:false (fail-closed; no $0 comped-only factura)');
}

// ── 2. X. Pizza — ineligible free pizza (NY) never reaches pricing (calculator rejects) ──
{
  const items = [{ name: 'Ham', qty: 1 }];
  const redemption = computeRedemption({ redeem: { type: 'free_pizza_choice', item_id: 'Margherita NY' }, items, restaurantId: 'x_pizza' });
  assert.strictEqual(redemption.ok, false);
  assert.strictEqual(applyRedemptionToPricing({ items, restaurantId: 'x_pizza', redemption, totalLempiras: 282 }).ok, false); ok('xp: an ineligible (NY) free pizza → calculator rejects → pricing no-op (ok:false)');
}

// ── 3. La Musa MULTISET add-free → no platform factura, N 0-price lines, subtotal = paid items ──
{
  const items = [{ id: 'dimsum_01', qty: 1 }];   // 223
  const total = computeServerTotal(items, 'la_musa').total;
  const redemption = computeRedemption({ redeem: { type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 2 }, { id: 'rice_white', qty: 1 }] }, items, restaurantId: 'la_musa' });
  const r = applyRedemptionToPricing({ items, restaurantId: 'la_musa', redemption, totalLempiras: total });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.factura_items, null); ok('lm: NO platform-factura line items (factura_items null — POS owns the fiscal doc)');
  assert.strictEqual(r.discount_cents, 0); assert.strictEqual(r.total_cents, 22300); assert.strictEqual(r.subtotal_cents, 22300); assert.strictEqual(r.tax_cents, 0); ok('lm: total unchanged, subtotal = paid items, no ISV split');
  assert.deepStrictEqual(r.free_lines, [
    { item_id: 'rice_white', qty: 1, price_cents: 0, added: true },
    { item_id: 'soft_01', qty: 2, price_cents: 0, added: true },
  ]); ok('lm: N 0-price free lines (sorted by id, qty-aware)');
}

// ── 4. Non-redeemed / bad redemption → ok:false (handler keeps the byte-identical non-redeem pricing path) ──
{
  assert.strictEqual(applyRedemptionToPricing({ items: [{ name: 'Ham', qty: 1 }], restaurantId: 'x_pizza', redemption: { ok: false }, totalLempiras: 282 }).ok, false);
  assert.strictEqual(applyRedemptionToPricing({ items: [{ name: 'Ham', qty: 1 }], restaurantId: 'x_pizza', redemption: null, totalLempiras: 282 }).ok, false);
  assert.strictEqual(applyRedemptionToPricing({ items: [{ id: 'dimsum_01', qty: 1 }], restaurantId: 'la_musa', redemption: { ok: true, model: 'discount' }, totalLempiras: 223 }).ok, false);   // legacy model → rejected
  assert.strictEqual(applyRedemptionToPricing({ items: [{ name: 'Ham', qty: 1 }], restaurantId: 'x_pizza', redemption: { ok: true, model: 'add_free', freeItems: [] }, totalLempiras: 282 }).ok, false);   // empty set
  ok('non-redeem / legacy model / empty set → ok:false');
}

// ── 5. buildFacturaRecord over an A-F redeemed X. Pizza order: the comped pizza prints as a FULL-VALUE line,
//       DESC. Y REB. OTORG === the comped value, gravado/ISV/total = the PAID (charged) breakdown, foots ──
{
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const { r } = xpApply(items, 'Pepperoni');
  const config = { restaurant_name: 'X. Pizza', legal_name: 'X PIZZA SA', rtn: '08011999123456', address_1: 'A', address_2: 'B',
    email: 'f@x.hn', phone: '+504', cai_code: 'ABC-123-CAI', prefix: '000-001-01', range_start: 1, range_end: 100000,
    fecha_limite: '2027-12-31', is_temp: false };
  // Prod wiring: order.items = paid-only (earn), order.factura_items = paid + comped (SAR); build-record reads factura_items || items.
  const order = { orderId: 'PZX1', subtotal_cents: r.subtotal_cents, tax_cents: r.tax_cents, total_cents: r.total_cents,
    items: r.items, factura_items: r.factura_items, desc_rebaja_cents: r.desc_rebaja_cents,
    payment_method: 'cash', customer_name: 'Cliente', cash_tendered_cents: r.total_cents };
  const rec = buildFacturaRecord({ order, config, reserved: 42, now: 1700000000000 });
  assert.strictEqual(rec.cai_code, 'ABC-123-CAI'); assert.strictEqual(rec.fecha_limite, '31/12/2027'); ok('factura: CAI / fecha_limite from config');
  assert.strictEqual(rec.desc_rebaja_cents, r.desc_rebaja_cents); assert.ok(rec.desc_rebaja_cents > 0); ok('factura: DESC. Y REB. OTORG === the comped value (> 0)');
  assert.strictEqual(rec.gravado_15_cents, r.subtotal_cents); assert.strictEqual(rec.isv_15_cents, r.tax_cents); assert.strictEqual(rec.total_cents, r.total_cents); ok('factura: gravado / ISV / total = the PAID (charged) breakdown');
  assert.strictEqual(rec.subtotal_cents + rec.isv_total_cents, rec.total_cents); ok('factura: subtotal + ISV === total (the charged amount)');
  assert.strictEqual(rec.items.length, r.factura_items.length); assert.ok(rec.items.some((i) => i.description === 'Pepperoni')); ok('factura: the comped pizza prints as its own PRECIO line');
  const sumBase = rec.items.reduce((a, i) => a + i.base_cents, 0);
  assert.strictEqual(sumBase, r.subtotal_cents + r.desc_rebaja_cents); assert.ok(rec.items.every((i) => i.base_cents >= 0)); ok('factura: FULL-value bases foot to the FULL net (paid subtotal + rebaja), all ≥ 0');
  assert.strictEqual(sumBase - rec.desc_rebaja_cents, rec.gravado_15_cents); ok('factura: Σ base − rebaja === gravado === PAID subtotal (foots to the centavo)');
}

console.log(`\nrewards-redeem-pricing: ${n} assertions passed`);
