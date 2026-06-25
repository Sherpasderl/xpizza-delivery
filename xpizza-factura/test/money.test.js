'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { priceBreakdown, reconcileLineBases } = require('../src/money');

// ISV is 15% tax-INCLUSIVE: the menu price IS what the customer pays. We break tax OUT
// with the SAME fixed rounding rule the platform uses in priceBreakdownCents(), so the
// factura money equals the amount charged exactly:
//   tax_cents = round(total_cents - total_cents / 1.15)
//   subtotal_cents = total_cents - tax_cents   (invariant: subtotal + tax === total)

test('priceBreakdown: clean case L115 -> base 100, isv 15', () => {
  assert.deepEqual(priceBreakdown(11500), { subtotal_cents: 10000, isv_cents: 1500, total_cents: 11500 });
});

test('priceBreakdown: L200 inclusive', () => {
  const b = priceBreakdown(20000);
  assert.equal(b.subtotal_cents + b.isv_cents, 20000); // invariant holds
  assert.equal(b.isv_cents, 2609); // round(20000 - 20000/1.15)
  assert.equal(b.subtotal_cents, 17391);
});

test('priceBreakdown: invariant holds across a sweep of totals', () => {
  for (let t = 1; t <= 5000; t++) {
    const b = priceBreakdown(t);
    assert.equal(b.subtotal_cents + b.isv_cents, t, `failed at ${t}`);
    assert.ok(b.isv_cents >= 0 && b.subtotal_cents >= 0);
  }
});

// reconcileLineBases(lineGrossCents[], subtotalCents) -> base_cents[] where each base is
// ~gross/1.15 and the SUM equals subtotalCents exactly (residual absorbed in last line).

test('reconcileLineBases: clean split, no residual', () => {
  // two L115 lines, total 23000, subtotal 20000
  const bases = reconcileLineBases([11500, 11500], 20000);
  assert.deepEqual(bases, [10000, 10000]);
});

test('reconcileLineBases: residual centavo absorbed into the last line', () => {
  // three L100 lines, total 30000, subtotal = priceBreakdown(30000).subtotal_cents
  const subtotal = priceBreakdown(30000).subtotal_cents; // 26087
  const bases = reconcileLineBases([10000, 10000, 10000], subtotal);
  assert.equal(bases.reduce((a, b) => a + b, 0), subtotal); // sums EXACTLY to subtotal
  assert.deepEqual(bases, [8696, 8696, 8695]); // last line carries the -1
});

test('reconcileLineBases: single line equals subtotal exactly', () => {
  const subtotal = priceBreakdown(11500).subtotal_cents;
  assert.deepEqual(reconcileLineBases([11500], subtotal), [10000]);
});

test('reconcileLineBases: column always sums to subtotal (random-ish sweep)', () => {
  const carts = [
    [12345, 6789, 100],
    [999, 999, 999, 999],
    [50000, 1, 2, 3],
    [7777],
  ];
  for (const gross of carts) {
    const total = gross.reduce((a, b) => a + b, 0);
    const subtotal = priceBreakdown(total).subtotal_cents;
    const bases = reconcileLineBases(gross, subtotal);
    assert.equal(bases.reduce((a, b) => a + b, 0), subtotal, `cart ${gross} did not reconcile`);
    assert.equal(bases.length, gross.length);
  }
});
