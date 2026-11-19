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

// H1a A-R1: payment_handheld_reject_* alerts survive a cancelled order while its refund is pending — and only then.
{
  const hr = { type: 'payment_handheld_reject_refund_pending', detail: { orderId: 'R1' } };
  assert.strictEqual(orderStillFlagged({ status: 'cancelled', payment_status: 'refund_pending' }, hr), true); ok('handheld reject + cancelled + refund_pending → KEEP');
  assert.strictEqual(orderStillFlagged({ status: 'cancelled', payment_status: 'refunded' }, hr), false); ok('handheld reject + cancelled + refunded → dismiss');
  assert.strictEqual(orderStillFlagged({ status: 'cancelled' }, { type: 'payment_handheld_reject_stranded' }), false); ok('handheld reject + cancelled (no refund pending) → dismiss');
  assert.strictEqual(orderStillFlagged({ status: 'cancelled', payment_status: 'refund_pending' }, { type: 'payment_paid_after_close' }), true, '🔴 CPR-REFUND-PENDING: any alert on cancelled + refund_pending is kept'); ok('Codex #211 P1-2: ANY alert on cancelled + refund_pending → KEEP (an unresolved money state; was handheld-only)');
  assert.strictEqual(orderStillFlagged({ status: 'cancelled', payment_status: 'refund_pending' }), true, '🔴 CPR-REFUND-PENDING: cancelled + refund_pending is kept (no alert argument)'); ok('Codex #211 P1-2: no alert argument, cancelled + refund_pending → KEEP');
  const prune = alertsToPrune({
    k1: hr,
    k2: { type: 'payment_handheld_reject_manual_review', detail: { orderId: 'R2' } },
    k3: { type: 'payment_paid_after_close', detail: { orderId: 'R1' } },
  }, { R1: { status: 'cancelled', payment_status: 'refund_pending' }, R2: { status: 'cancelled', payment_status: 'refunded' } }).sort();
  assert.deepStrictEqual(prune, ['k2']); ok('alertsToPrune: every alert on the refund-pending order is kept (Codex #211 P1-2); the refunded order\'s is pruned');
}
// Codex #211 P1-2 (cancel-park): an UNRESOLVED MONEY state still needs a person whatever the order's fulfilment status — a parked
// cancelled order's alerts (the cancel refusal + the daily aged_manual_review breach) are never pruned.
{
  const { unresolvedMoney } = require('./alert-prune');
  for (const ps of ['manual_review', 'manual_reconciliation', 'refund_pending', 'resolving_refund', 'resolving_materialize']) {
    assert.strictEqual(unresolvedMoney({ status: 'cancelled', payment_status: ps }), true, `🔴 CPR-STATE: ${ps} is an unresolved money state`);
    assert.strictEqual(orderStillFlagged({ status: 'cancelled', payment_status: ps }, { type: 'payment_reconcile_breaches' }), true, `🔴 CPR-KEEP: cancelled + ${ps} → KEEP`);
  }
  for (const ps of ['refunded', 'abandoned', 'confirmed', 'pending', undefined]) assert.strictEqual(unresolvedMoney({ status: 'cancelled', payment_status: ps }), false, `CPR-STATE: ${ps} is not`);
  const parked = { status: 'cancelled', payment_status: 'manual_review', blocked_reason: 'cancel_no_uuid_cancelled' };
  const kept = alertsToPrune({ c: { type: 'payment_cancel_manual_review', detail: { orderId: 'P1' } }, b: { type: 'payment_reconcile_breaches', detail: { breaches: [{ orderId: 'P1', kind: 'aged_manual_review' }] } } }, { P1: parked });
  assert.deepStrictEqual(kept, [], '🔴 CPR-PARKED: a parked cancelled order keeps its cancel alert AND its daily breach');
  ok('CPR: manual_review / manual_reconciliation / refund_pending / resolving_* are never pruned, whatever the status (a parked cancelled order keeps its alerts)');
}

console.log(`\n${n} passed`);
