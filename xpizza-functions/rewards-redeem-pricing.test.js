'use strict';
// Golden test for applyRedemptionToPricing (rewards-redeem-pricing.js). Run: node rewards-redeem-pricing.test.js
// Money invariants: Σ line_gross_cents === total_cents (tax-inclusive); reconcileLineBases foots to
// subtotal_cents; all bases ≥ 0; extras stay paid; CAI/factura fields unchanged; La Musa skips platform factura.
const assert = require('assert');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
const { computeRedemption } = require('./rewards-redeem');
const { computeServerTotal } = require('./menu-pricing');
const { reconcileLineBases } = require('./factura/money');
const { buildFacturaRecord } = require('./factura/build-record');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const sumGross = (its) => its.reduce((s, l) => s + l.line_gross_cents, 0);
const xpApply = (items) => {
  const total = computeServerTotal(items, 'x_pizza').total;
  const redemption = computeRedemption({ redeem: { type: 'discount_cheapest_pizza' }, items, restaurantId: 'x_pizza' });
  return { r: applyRedemptionToPricing({ items, restaurantId: 'x_pizza', redemption, totalLempiras: total }), total, redemption };
};

// ── 1. X. Pizza, qty>1 pizza WITH extras (the hardened golden) ──
{
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const { r, total } = xpApply(items);                                   // Margherita 299 cheapest; total 299*2+50+418 = 1066
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.discount_cents, 29900); assert.strictEqual(r.total_lempiras, 1066 - 299);
  assert.strictEqual(sumGross(r.factura_items), r.total_cents); ok('xp qty>1+extras: Σ line_gross_cents === total_cents (discounted)');
  const bases = reconcileLineBases(r.factura_items.map((l) => l.line_gross_cents), r.subtotal_cents);
  assert.strictEqual(bases.reduce((a, b) => a + b, 0), r.subtotal_cents); ok('xp: reconcileLineBases.sum === subtotal_cents (foots to SUB TOTAL)');
  assert.ok(bases.every((b) => b >= 0)); ok('xp: ALL per-line bases ≥ 0');
  // the freed unit is a single 0 line; the pizza's extras stay a PAID line; the remainder base stays paid
  assert.ok(r.factura_items.some((l) => l.line_gross_cents === 0 && /Recompensa/.test(l.description) && l.qty === 1));
  assert.ok(r.factura_items.some((l) => /Mozzarella/.test(l.description) && l.line_gross_cents === 5000)); ok('xp: extras STAY charged (Mozzarella 5000 on its own line — never freed)');
  assert.ok(r.factura_items.some((l) => l.description === 'Margherita' && l.qty === 1 && l.line_gross_cents === 29900)); ok('xp: paid remainder present (1 × Margherita base, 29900)');
  assert.ok(r.factura_items.some((l) => l.description === 'Anchovies' && l.line_gross_cents === 41800)); ok('xp: other pizza line untouched (Anchovies 41800)');
  assert.strictEqual(r.subtotal_cents + r.tax_cents, r.total_cents); ok('xp: subtotal_cents + tax_cents === total_cents (ISV identity holds on the discount)');
}

// ── 2. X. Pizza single pizza qty1 WITH extras (no remainder; extras stay) ──
{
  const items = [{ name: 'Ham', qty: 1, extras: [{ name: 'Prosciutto' }] }];   // Ham 282, Prosciutto 94 → total 376
  const { r } = xpApply(items);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.total_lempiras, 94);
  assert.strictEqual(sumGross(r.factura_items), r.total_cents); assert.strictEqual(r.total_cents, 9400);
  assert.ok(!r.factura_items.some((l) => l.line_gross_cents > 0 && /^Ham$/.test(l.description))); // no bare-base remainder (qty was 1)
  assert.ok(r.factura_items.some((l) => /Prosciutto/.test(l.description) && l.line_gross_cents === 9400)); ok('xp qty1+extras: no remainder line, extras (9400) stay paid, Σ===total_cents');
  const bases = reconcileLineBases(r.factura_items.map((l) => l.line_gross_cents), r.subtotal_cents);
  assert.ok(bases.every((b) => b >= 0) && bases.reduce((a, b) => a + b, 0) === r.subtotal_cents); ok('xp qty1: bases foot to subtotal, all ≥ 0');
}

// ── 3. X. Pizza fully-free order (single cheapest pizza, qty1, no extras) ──
{
  const items = [{ name: 'Nutella', qty: 1 }];   // 251 → cheapest → free → total 0
  const { r } = xpApply(items);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.total_cents, 0); assert.strictEqual(r.subtotal_cents, 0); assert.strictEqual(r.tax_cents, 0);
  assert.deepStrictEqual(r.factura_items.map((l) => l.line_gross_cents), [0]);
  const bases = reconcileLineBases([0], 0); assert.deepStrictEqual(bases, [0]); ok('xp fully-free: total 0, single 0-line, base 0 (no negative residual)');
}

// ── 4. La Musa redeemed → no platform factura, 0-price line, subtotal = paid items ──
{
  const items = [{ id: 'dimsum_01', qty: 1 }];   // 223
  const total = computeServerTotal(items, 'la_musa').total;
  const redemption = computeRedemption({ redeem: { type: 'free_item', level: 1, item_id: 'soft_01' }, items, restaurantId: 'la_musa' });
  const r = applyRedemptionToPricing({ items, restaurantId: 'la_musa', redemption, totalLempiras: total });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.factura_items, null); ok('lm: NO platform-factura line items (factura_items null — Soft Restaurant POS owns the fiscal doc)');
  assert.strictEqual(r.discount_cents, 0); assert.strictEqual(r.total_cents, 22300); assert.strictEqual(r.subtotal_cents, 22300); assert.strictEqual(r.tax_cents, 0); ok('lm: total unchanged, subtotal = paid items, no ISV split');
  assert.deepStrictEqual(r.free_line, { item_id: 'soft_01', qty: 1, price_cents: 0, added: true }); ok('lm: 0-price free line present (item_id soft_01, price_cents 0)');
}

// ── 5. Non-redeemed → applyRedemptionToPricing is a no-op gate (handler falls back to the normal path) ──
{
  assert.strictEqual(applyRedemptionToPricing({ items: [{ name: 'Ham', qty: 1 }], restaurantId: 'x_pizza', redemption: { ok: false }, totalLempiras: 282 }).ok, false);
  assert.strictEqual(applyRedemptionToPricing({ items: [{ name: 'Ham', qty: 1 }], restaurantId: 'x_pizza', redemption: null, totalLempiras: 282 }).ok, false);
  // a redemption whose model/brand disagree → error (never a silent full-price pass)
  assert.strictEqual(applyRedemptionToPricing({ items: [{ id: 'dimsum_01', qty: 1 }], restaurantId: 'la_musa', redemption: { ok: true, model: 'discount' }, totalLempiras: 223 }).ok, false);
  ok('non-redeem / bad redemption → ok:false (handler keeps the byte-identical non-redeem pricing path)');
}

// ── 6. buildFacturaRecord over the discounted x_pizza lines: CAI/fiscal fields unchanged, foots to subtotal ──
{
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const { r } = xpApply(items);
  const config = { restaurant_name: 'X. Pizza', legal_name: 'X PIZZA SA', rtn: '08011999123456', address_1: 'A', address_2: 'B',
    email: 'f@x.hn', phone: '+504', cai_code: 'ABC-123-CAI', prefix: '000-001-01', range_start: 1, range_end: 100000,
    fecha_limite: '2027-12-31', is_temp: false };
  const order = { orderId: 'PZX1', subtotal_cents: r.subtotal_cents, tax_cents: r.tax_cents, total_cents: r.total_cents,
    items: r.factura_items, payment_method: 'cash', customer_name: 'Cliente', cash_tendered_cents: r.total_cents };
  const rec = buildFacturaRecord({ order, config, reserved: 42, now: 1700000000000 });
  assert.strictEqual(rec.cai_code, 'ABC-123-CAI'); assert.strictEqual(rec.rango_desde, '000-001-01-00000001'); assert.strictEqual(rec.fecha_limite, '31/12/2027'); ok('factura: CAI / rango / fecha_limite unchanged by the redemption (come from config)');
  assert.strictEqual(rec.desc_rebaja_cents, 0); assert.strictEqual(rec.desc_general_pct, 0); ok('factura: discount is baked into the LINES, not a factura-level rebaja (desc_rebaja_cents 0)');
  assert.strictEqual(rec.gravado_15_cents, r.subtotal_cents); assert.strictEqual(rec.isv_15_cents, r.tax_cents); assert.strictEqual(rec.total_cents, r.total_cents);
  assert.strictEqual(rec.items.reduce((a, i) => a + i.base_cents, 0), r.subtotal_cents); assert.ok(rec.items.every((i) => i.base_cents >= 0)); ok('factura: bases foot to gravado/subtotal, all ≥ 0, totals verbatim from the discounted breakdown');
}

console.log(`\nrewards-redeem-pricing: ${n} assertions passed`);
