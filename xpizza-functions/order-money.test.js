'use strict';

// Unit + golden test for the restaurant-aware money breakdown (order-money.js).
// Proves: (a) priceBreakdownCents pinned ISV-15% values (unchanged from the inline original);
// (b) x_pizza (platform factura) → orderBreakdownCents === priceBreakdownCents (byte-identical);
// (c) la_musa (non-platform — Soft Restaurant POS factura) → NO split (subtotal == total, tax 0);
// (d) subtotal + tax === total invariant for both. Run: node order-money.test.js
const assert = require('assert');
const { priceBreakdownCents, orderBreakdownCents } = require('./order-money');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── priceBreakdownCents: pinned ISV-15% values (unchanged from the inline original) ──
assert.deepStrictEqual(priceBreakdownCents(299), { total_cents: 29900, subtotal_cents: 26000, tax_cents: 3900 }); ok('priceBreakdownCents(299) → 26000 + 3900');
assert.deepStrictEqual(priceBreakdownCents(100), { total_cents: 10000, subtotal_cents: 8696, tax_cents: 1304 }); ok('priceBreakdownCents(100) → 8696 + 1304 (rounding)');

// ── x_pizza (platform factura) → orderBreakdownCents === priceBreakdownCents (byte-identical) ──
for (const t of [1, 100, 251, 299, 418, 685, 1000.5, 12345]) {
  assert.deepStrictEqual(orderBreakdownCents(t, 'x_pizza'), priceBreakdownCents(t));
}
ok('x_pizza: orderBreakdownCents === priceBreakdownCents for all sampled totals');

// ── la_musa (non-platform) → NO ISV split: subtotal == total, tax == 0 ──
assert.deepStrictEqual(orderBreakdownCents(223, 'la_musa'), { total_cents: 22300, subtotal_cents: 22300, tax_cents: 0 }); ok('la_musa(223) → no split');
assert.deepStrictEqual(orderBreakdownCents(10831, 'la_musa'), { total_cents: 1083100, subtotal_cents: 1083100, tax_cents: 0 }); ok('la_musa full-cart(10831) → no split');

// ── invariant subtotal + tax === total, both restaurants ──
for (const t of [1, 81, 98, 223, 299, 588, 624, 10831, 99999]) {
  for (const rid of ['x_pizza', 'la_musa']) {
    const b = orderBreakdownCents(t, rid);
    assert.equal(b.subtotal_cents + b.tax_cents, b.total_cents, `invariant ${rid} ${t}`);
  }
}
ok('subtotal_cents + tax_cents === total_cents (both restaurants, sampled)');

// ── la_musa never accrues platform tax (every la_musa price → tax 0) ──
for (const t of [223, 248, 198, 588, 624, 102, 81, 40]) {
  assert.equal(orderBreakdownCents(t, 'la_musa').tax_cents, 0);
}
ok('la_musa tax_cents always 0 (Soft Restaurant POS owns the factura)');

console.log(`order-money: OK (${n} cases)`);
