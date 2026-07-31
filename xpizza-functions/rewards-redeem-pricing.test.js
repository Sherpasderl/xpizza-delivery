'use strict';
// Golden test for applyRedemptionToPricing (rewards-redeem-pricing.js) — v2 ADD-FREE. Run: node rewards-redeem-pricing.test.js
// v2 money invariants: BOTH brands add_free → the paid total is UNCHANGED (no discount, no desc_rebaja). The
// reward item(s) are 0-price DISPLAY/kitchen lines (free_lines), never a sold/fiscal line. X. Pizza's factura is
// the FULL PAID cart (byte-identical to a non-redeemed order — the free pizza is a giveaway, not on the doc);
// La Musa skips the platform factura (its POS owns the fiscal doc).
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

// ── 1. X. Pizza add-free (qty>1 + extras): total UNCHANGED, factura = full paid cart, free pizza is a free_line ──
{
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const { r, total } = xpApply(items, 'Pepperoni');                       // free Pepperoni ADDED (not in cart)
  const full = orderBreakdownCents(total, 'x_pizza');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.discount_cents, 0); assert.strictEqual(r.desc_rebaja_cents, 0); ok('xp add-free: no discount, no rebaja');
  assert.strictEqual(r.total_cents, full.total_cents); assert.strictEqual(r.total_lempiras, total); ok('xp add-free: total UNCHANGED (= full paid total)');
  assert.strictEqual(r.factura_items.length, items.length);
  assert.strictEqual(sumGross(r.factura_items), full.total_cents); ok('xp add-free: factura = the FULL paid cart lines, Σ line_gross === total (foots)');
  assert.ok(!r.factura_items.some((l) => l.line_gross_cents === 0 || /Recompensa/.test(l.description || ''))); ok('xp add-free: the free pizza is NOT a fiscal line (no 0-price / Recompensa line on the factura)');
  assert.strictEqual(r.subtotal_cents + r.tax_cents, r.total_cents); ok('xp add-free: subtotal + tax === total (ISV identity, unchanged)');
  assert.deepStrictEqual(r.free_lines, [{ item_id: 'Pepperoni', qty: 1, price_cents: 0, added: true }]); ok('xp add-free: the chosen pizza is a single 0-price free_line');
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

// ── 5. buildFacturaRecord over a v2 add-free X. Pizza order: full-value items, NO rebaja (byte-identical to non-redeem) ──
{
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const { r } = xpApply(items, 'Pepperoni');
  const config = { restaurant_name: 'X. Pizza', legal_name: 'X PIZZA SA', rtn: '08011999123456', address_1: 'A', address_2: 'B',
    email: 'f@x.hn', phone: '+504', cai_code: 'ABC-123-CAI', prefix: '000-001-01', range_start: 1, range_end: 100000,
    fecha_limite: '2027-12-31', is_temp: false };
  const order = { orderId: 'PZX1', subtotal_cents: r.subtotal_cents, tax_cents: r.tax_cents, total_cents: r.total_cents,
    items: r.factura_items, payment_method: 'cash', customer_name: 'Cliente', cash_tendered_cents: r.total_cents };   // NO desc_rebaja (v2 add-free)
  const rec = buildFacturaRecord({ order, config, reserved: 42, now: 1700000000000 });
  assert.strictEqual(rec.cai_code, 'ABC-123-CAI'); assert.strictEqual(rec.fecha_limite, '31/12/2027'); ok('factura: CAI / fecha_limite from config');
  assert.strictEqual(rec.desc_rebaja_cents, 0); ok('factura: v2 add-free → NO Desc. y Reb. Otorg (the free pizza is a giveaway, not on the doc)');
  assert.strictEqual(rec.gravado_15_cents, r.subtotal_cents); assert.strictEqual(rec.isv_15_cents, r.tax_cents); assert.strictEqual(rec.total_cents, r.total_cents); ok('factura: gravado / ISV / total = the FULL (unchanged) breakdown');
  assert.strictEqual(rec.subtotal_cents + rec.isv_total_cents, rec.total_cents); ok('factura: subtotal + ISV === total');
  const sumBase = rec.items.reduce((a, i) => a + i.base_cents, 0);
  assert.strictEqual(sumBase, r.subtotal_cents); assert.ok(rec.items.every((i) => i.base_cents >= 0)); ok('factura: full-value bases foot to subtotal (no rebaja), all ≥ 0');
}

console.log(`\nrewards-redeem-pricing: ${n} assertions passed`);
