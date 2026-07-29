'use strict';
// Golden test for applyRedemptionToPricing (rewards-redeem-pricing.js). Run: node rewards-redeem-pricing.test.js
// A-F money invariants: X. Pizza factura_items are the FULL-value cart lines (Σ line_gross === the FULL,
// pre-discount total); the comp is an explicit desc_rebaja_cents (= FULL net − PAID net); the PAID breakdown
// preserves subtotal + tax === total; full-value bases foot to the FULL net, Σ base − rebaja === gravado.
// La Musa skips the platform factura (its POS owns the fiscal doc).
const assert = require('assert');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
const { computeRedemption } = require('./rewards-redeem');
const { computeServerTotal } = require('./menu-pricing');
const { reconcileLineBases } = require('./factura/money');
const { orderBreakdownCents } = require('./order-money');
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
  const { r, total } = xpApply(items);                                   // Margherita 299 cheapest; full 1066, comp 299 → paid 767
  const full = orderBreakdownCents(total, 'x_pizza');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.discount_cents, 29900); assert.strictEqual(r.total_lempiras, 1066 - 299);
  // A-F: factura_items are the FULL-value cart lines, UNCHANGED (no 0-line split, one line per cart item)
  assert.strictEqual(r.factura_items.length, items.length); ok('xp: factura_items = the full cart lines, no split');
  assert.strictEqual(sumGross(r.factura_items), full.total_cents); ok('xp qty>1+extras: Σ line_gross === the FULL, pre-discount total');
  assert.strictEqual(sumGross(r.factura_items), r.total_cents + r.discount_cents); ok('xp: Σ line_gross === paid total + comped gross');
  assert.ok(!r.factura_items.some((l) => l.line_gross_cents === 0 || /Recompensa/.test(l.description))); ok('xp: no 0-price / (Recompensa) line — the comp is a rebaja, not a baked-in 0 line');
  assert.ok(r.factura_items.some((l) => l.description === 'Anchovies' && l.line_gross_cents === 41800)); ok('xp: other pizza line untouched (Anchovies 41800)');
  // the comp is carried by desc_rebaja_cents = FULL net − PAID net (exact residual → foots)
  assert.strictEqual(r.desc_rebaja_cents, full.subtotal_cents - r.subtotal_cents); ok('xp: desc_rebaja_cents === FULL net − PAID net (exact)');
  assert.strictEqual(r.subtotal_cents + r.tax_cents, r.total_cents); ok('xp: subtotal_cents + tax_cents === total_cents (ISV identity on the PAID breakdown)');
  // full-value bases foot to the FULL net (= paid subtotal + rebaja); Σ base − rebaja === gravado (paid net)
  const bases = reconcileLineBases(r.factura_items.map((l) => l.line_gross_cents), r.subtotal_cents + r.desc_rebaja_cents);
  assert.strictEqual(bases.reduce((a, b) => a + b, 0), r.subtotal_cents + r.desc_rebaja_cents); assert.ok(bases.every((b) => b >= 0)); ok('xp: full-value bases foot to FULL net (subtotal + rebaja), all ≥ 0');
}

// ── 2. X. Pizza single pizza qty1 WITH extras (one full-value line; the comped base leaves via the rebaja) ──
{
  const items = [{ name: 'Ham', qty: 1, extras: [{ name: 'Prosciutto' }] }];   // Ham 282, Prosciutto 94 → full 376, comp 282
  const { r, total } = xpApply(items);
  const full = orderBreakdownCents(total, 'x_pizza');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.total_lempiras, 94); assert.strictEqual(r.total_cents, 9400);
  assert.strictEqual(r.factura_items.length, 1); assert.strictEqual(sumGross(r.factura_items), full.total_cents); assert.strictEqual(full.total_cents, 37600); ok('xp qty1+extras: single full-value line (Ham+extras 37600), Σ === FULL total');
  assert.strictEqual(r.discount_cents, 28200); assert.strictEqual(r.desc_rebaja_cents, full.subtotal_cents - r.subtotal_cents); ok('xp qty1: comped base 28200 gross → desc_rebaja = its net (foots)');
  assert.strictEqual(r.subtotal_cents + r.tax_cents, r.total_cents);
  const bases = reconcileLineBases(r.factura_items.map((l) => l.line_gross_cents), r.subtotal_cents + r.desc_rebaja_cents);
  assert.ok(bases.every((b) => b >= 0) && bases.reduce((a, b) => a + b, 0) === r.subtotal_cents + r.desc_rebaja_cents); ok('xp qty1: full-value base foots to FULL net, ≥ 0');
}

// ── 3. X. Pizza fully-comped order (single cheapest pizza, qty1, no extras) → 0/0/0 but the item shows FULL value ──
{
  const items = [{ name: 'Nutella', qty: 1 }];   // 251 → cheapest → comped → paid 0
  const { r, total } = xpApply(items);
  const full = orderBreakdownCents(total, 'x_pizza');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.total_cents, 0); assert.strictEqual(r.subtotal_cents, 0); assert.strictEqual(r.tax_cents, 0);
  assert.deepStrictEqual(r.factura_items.map((l) => l.line_gross_cents), [25100]); ok('xp fully-comped: item stays at FULL value (25100), NOT a 0-line');
  assert.strictEqual(r.desc_rebaja_cents, full.subtotal_cents); ok('xp fully-comped: desc_rebaja = full net → gravado 0 / ISV 0 / total 0, factura still issues');
  const bases = reconcileLineBases(r.factura_items.map((l) => l.line_gross_cents), r.subtotal_cents + r.desc_rebaja_cents);
  assert.deepStrictEqual(bases, [full.subtotal_cents]); ok('xp fully-comped: full-value base foots to FULL net');
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

// ── 6. buildFacturaRecord over the A-F x_pizza order: full-value item PRECIOs + explicit rebaja, paid totals ──
{
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const { r } = xpApply(items);
  const config = { restaurant_name: 'X. Pizza', legal_name: 'X PIZZA SA', rtn: '08011999123456', address_1: 'A', address_2: 'B',
    email: 'f@x.hn', phone: '+504', cai_code: 'ABC-123-CAI', prefix: '000-001-01', range_start: 1, range_end: 100000,
    fecha_limite: '2027-12-31', is_temp: false };
  const order = { orderId: 'PZX1', subtotal_cents: r.subtotal_cents, tax_cents: r.tax_cents, total_cents: r.total_cents,
    desc_rebaja_cents: r.desc_rebaja_cents,   // A-F: index.js stamps the comp rebaja onto the order
    items: r.factura_items, payment_method: 'cash', customer_name: 'Cliente', cash_tendered_cents: r.total_cents };
  const rec = buildFacturaRecord({ order, config, reserved: 42, now: 1700000000000 });
  assert.strictEqual(rec.cai_code, 'ABC-123-CAI'); assert.strictEqual(rec.rango_desde, '000-001-01-00000001'); assert.strictEqual(rec.fecha_limite, '31/12/2027'); ok('factura: CAI / rango / fecha_limite unchanged by the redemption (come from config)');
  // A-F: the comp is an explicit "Desc. y Reb. Otorg", NOT baked into 0-price lines
  assert.strictEqual(rec.desc_rebaja_cents, r.desc_rebaja_cents); assert.ok(rec.desc_rebaja_cents > 0); ok('factura: comp is an explicit Desc. y Reb. Otorg (desc_rebaja_cents > 0), not baked-in 0 lines');
  assert.strictEqual(rec.gravado_15_cents, r.subtotal_cents); assert.strictEqual(rec.isv_15_cents, r.tax_cents); assert.strictEqual(rec.total_cents, r.total_cents); ok('factura: gravado / ISV / total = the PAID (discounted) breakdown, verbatim');
  assert.strictEqual(rec.subtotal_cents + rec.isv_total_cents, rec.total_cents); ok('factura: subtotal + ISV === total (paid ISV identity preserved)');
  const sumBase = rec.items.reduce((a, i) => a + i.base_cents, 0);
  assert.strictEqual(sumBase, r.subtotal_cents + r.desc_rebaja_cents); assert.ok(rec.items.every((i) => i.base_cents >= 0)); ok('factura: full-value bases foot to FULL net (paid + rebaja), all ≥ 0');
  assert.strictEqual(sumBase - rec.desc_rebaja_cents, rec.gravado_15_cents); ok('factura: Σ base − rebaja === gravado (the receipt foots)');
}

console.log(`\nrewards-redeem-pricing: ${n} assertions passed`);
