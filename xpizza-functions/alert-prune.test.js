'use strict';

// alertsToPrune — auto-dismiss dispatcher alerts whose referenced orders are all resolved.
// Run: node alert-prune.test.js
const assert = require('assert');
const { alertOrderIds, orderStillFlagged, alertsToPrune } = require('./alert-prune');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// alertOrderIds
assert.deepStrictEqual(alertOrderIds({ detail: { orderId: 'O1' } }), ['O1']); ok('detail.orderId');
assert.deepStrictEqual(alertOrderIds({ detail: { order_id: 'O2' } }), ['O2']); ok('detail.order_id');
assert.deepStrictEqual(alertOrderIds({ detail: { breaches: [{ orderId: 'A' }, { order_id: 'B' }, {}] } }), ['A', 'B']); ok('detail.breaches[]');
assert.deepStrictEqual(alertOrderIds({ detail: null }), []); ok('no detail → []');
assert.deepStrictEqual(alertOrderIds({}), []); ok('no order ref → []');

// orderStillFlagged
assert.strictEqual(orderStillFlagged(null), false); ok('gone → not flagged (dismiss)');
assert.strictEqual(orderStillFlagged({ status: 'cancelled' }), false); ok('cancelled → dismiss');
assert.strictEqual(orderStillFlagged({ payment_status: 'refunded' }), false); ok('refunded → dismiss');
assert.strictEqual(orderStillFlagged({ payment_status: 'abandoned' }), false); ok('abandoned → dismiss');
assert.strictEqual(orderStillFlagged({ status: 'pending_payment', payment_status: 'manual_review' }), true); ok('manual_review → keep');
assert.strictEqual(orderStillFlagged({ payment_status: 'manual_reconciliation' }), true); ok('manual_reconciliation → keep');
assert.strictEqual(orderStillFlagged({ payment_status: 'refunding_paid_after_close' }), true); ok('mid-refund → keep');
assert.strictEqual(orderStillFlagged({ status: 'new', payment_status: 'confirmed', materialized_at: 1 }), true); ok('materialized (live) → KEEP (money-integrity alerts survive)');

// alertsToPrune
{
  const orders = { O1: { status: 'cancelled' }, O2: { payment_status: 'refunded' }, O3: { payment_status: 'manual_review' } };
  const alerts = {
    a1: { type: 'payment_paid_after_close', detail: { orderId: 'O1' } },          // resolved → prune
    a2: { type: 'payment_refund_failed_paid_after_close', detail: { orderId: 'O3' } }, // still flagged → keep
    a3: { type: 'payment_reconcile_breaches', detail: { breaches: [{ orderId: 'O1' }, { orderId: 'O2' }] } }, // both resolved → prune
    a4: { type: 'payment_reconcile_breaches', detail: { breaches: [{ orderId: 'O2' }, { orderId: 'O3' }] } }, // one still flagged → keep
    a5: { type: 'no_drivers_available', detail: { note: 'x' } },                   // not order-scoped → keep
    a6: { type: 'payment_paid_after_close', detail: { orderId: 'GONE' } },         // absent order → prune
  };
  const prune = alertsToPrune(alerts, orders).sort();
  assert.deepStrictEqual(prune, ['a1', 'a3', 'a6']); ok('prunes only fully-resolved order-scoped alerts (a1,a3,a6)');
}
assert.deepStrictEqual(alertsToPrune({}, {}), []); ok('no alerts → []');
assert.deepStrictEqual(alertsToPrune(null, null), []); ok('null-safe → []');

console.log(`\n${n} passed`);
