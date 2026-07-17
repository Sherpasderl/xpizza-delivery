'use strict';
// Unit tests for the display_number pure core (order-display-number.js). Run: node order-display-number.test.js
// Proves: increment, idempotency (retry → same n, no write), concurrency (two handlers → one n), day boundary
// (fresh node → resets), malformed-node fail-safe, and the eligibility predicate.
const assert = require('assert');
const { decideDisplayNumber, displayNumberEligible } = require('./order-display-number');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ── counter ──
{
  const d = decideDisplayNumber(null, 'A');
  assert.strictEqual(d.number, 1);
  assert.deepStrictEqual(d.next, { last: 1, by_order: { A: 1 } });
  ok('first order in a fresh day → #1');
}
{
  const d = decideDisplayNumber({ last: 1, by_order: { A: 1 } }, 'B');
  assert.strictEqual(d.number, 2);
  assert.deepStrictEqual(d.next, { last: 2, by_order: { A: 1, B: 2 } });
  ok('second distinct order → #2 (prior by_order preserved)');
}
{
  // IDEMPOTENT: the same order again → same number, NO write (next undefined → abort)
  const d = decideDisplayNumber({ last: 2, by_order: { A: 1, B: 2 } }, 'A');
  assert.strictEqual(d.number, 1);
  assert.strictEqual(d.next, undefined);
  ok('retry / concurrent re-fire of an allocated order → SAME #1, no write (idempotent, no re-burn/gap)');
}
{
  // CONCURRENCY (the RTDB transaction serializes the update fn — model it as sequential runs on the same order):
  const d1 = decideDisplayNumber(null, 'A'); assert.strictEqual(d1.number, 1);
  const d2 = decideDisplayNumber(d1.next, 'A'); assert.strictEqual(d2.number, 1); assert.strictEqual(d2.next, undefined);
  ok('concurrency: two handlers for one order converge on one # (no double-burn/gap)');
}
{
  // DAY BOUNDARY: a new YYYY-MM-DD key = an absent node → resets to #1
  assert.strictEqual(decideDisplayNumber(undefined, 'X').number, 1);
  ok('day boundary: new date node (absent) → resets to #1');
}
{
  // Malformed node → fail-safe increment from 0
  assert.strictEqual(decideDisplayNumber({ by_order: {} }, 'Y').number, 1);
  assert.strictEqual(decideDisplayNumber({ last: 'nope', by_order: {} }, 'Z').number, 1);
  ok('malformed node (no last / non-finite last) → #1 (fail-safe)');
}

// ── eligibility predicate (near-clone of facturaSaleEligible) ──
assert.strictEqual(displayNumberEligible({ status: 'new', payment_method: 'cash' }), true); ok('cash + status:new → eligible');
assert.strictEqual(displayNumberEligible({ status: 'new', payment_method: 'online', payment_status: 'confirmed' }), true); ok('online CONFIRMED + new → eligible');
assert.strictEqual(displayNumberEligible({ status: 'new', payment_method: 'online', payment_status: 'pending' }), false); ok('online UNconfirmed + new → NOT eligible (no number for an unpaid order)');
assert.strictEqual(displayNumberEligible({ status: 'pending_payment', payment_method: 'online' }), false); ok('pending_payment → NOT eligible (failed/abandoned payments burn no number)');
assert.strictEqual(displayNumberEligible({ status: 'preparing' }), false); ok('past new (preparing) → NOT eligible');
assert.strictEqual(displayNumberEligible(null), false); ok('null after → NOT eligible');

console.log(`\n${pass} passed`);
