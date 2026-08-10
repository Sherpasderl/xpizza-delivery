// xpizza-dispatch/dispatch-alert-nav.test.js
import assert from 'node:assert';
import { alertNavTarget, enFilaAttentionCount } from './dispatch-alert-nav.js';

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── alertNavTarget truth table ──
const t = (a) => alertNavTarget(a);
assert.deepEqual(t({ type: 'no_drivers_available', order_id: 'O1' }), { kind: 'order', orderId: 'O1' }); ok('no_drivers → order');
assert.deepEqual(t({ type: 'no_response_takeover', order_id: 'O1b' }), { kind: 'order', orderId: 'O1b' }); ok('takeover → order');
assert.deepEqual(t({ type: 'assignment_strand', order_id: 'O2' }), { kind: 'order', orderId: 'O2' }); ok('stuck → order');
assert.deepEqual(t({ type: 'payment_aged_refund_pending', detail: { orderId: 'O3' } }), { kind: 'order', orderId: 'O3' }); ok('aged refund → order (detail.orderId)');
assert.deepEqual(t({ type: 'payment_hosted_stale_no_callback', detail: { orderId: 'O4' } }), { kind: 'caja', orderId: 'O4' }); ok('hosted-stale → caja+order');
assert.deepEqual(t({ type: 'payment_reconcile_breaches', detail: { breaches: [{ orderId: 'O5' }] } }), { kind: 'caja', orderId: 'O5' }); ok('reconcile single → caja+highlight');
assert.deepEqual(t({ type: 'payment_reconcile_breaches', detail: { breaches: [{ orderId: 'O5' }, { orderId: 'O6' }] } }), { kind: 'caja', orderId: null }); ok('reconcile multi → caja no-highlight');
assert.deepEqual(t({ type: 'payment_reconcile_breaches', detail: {} }), { kind: 'caja', orderId: null }); ok('reconcile no-breaches → caja no-highlight');
assert.deepEqual(t({ type: 'driver_freshness_stale', driver_id: 'D1' }), { kind: 'driver', driverId: 'D1' }); ok('driver → driver');
assert.deepEqual(t({ type: 'driver_freshness_stale' }), { kind: 'none' }); ok('driver alert without driver_id → none');
assert.deepEqual(t({ type: 'factura_weird' }), { kind: 'none' }); ok('unknown no-id → none');
assert.deepEqual(t({ type: 'factura_weird', order_id: 'O7' }), { kind: 'order', orderId: 'O7' }); ok('unknown WITH order_id → order (resolvable)');
assert.deepEqual(t(null), { kind: 'none' }); ok('null → none');
assert.deepEqual(t({}), { kind: 'none' }); ok('no type → none');

// ── enFilaAttentionCount: unassigned + stalled, de-duped, mirrors getPendingOrders ──
const now = 1000;
{
  const orders = { A: { order_id: 'A' }, B: { order_id: 'B' }, C: { order_id: 'C' } };
  const tasks = {
    A_delivery: { status: 'pending' },                                                  // unassigned → counts
    B_delivery: { assigned_driver_id: 'd1', status: 'assigned', assignment_deadline: 500 }, // stalled (expired) → counts
    C_delivery: { assigned_driver_id: 'd2', status: 'en_route_delivery' },               // active, fine → no
  };
  assert.equal(enFilaAttentionCount(orders, tasks, now), 2); ok('attention = unassigned(A)+stalled(B), not active(C)');
}
{
  // Terminal unassigned deliveries — cancelled OR completed (e.g. delivered off-book / manually completed
  // with no driver) — are NOT pending (mirrors getPendingOrders); a not-yet-expired assigned order isn't stalled.
  const orders = { X: { order_id: 'X' }, W: { order_id: 'W' }, Y: { order_id: 'Y' } };
  const tasks = {
    X_delivery: { status: 'cancelled' },                                                  // unassigned but cancelled → no
    W_delivery: { status: 'completed', assigned_driver_id: null },                         // completed, no driver → no (the fix)
    Y_delivery: { assigned_driver_id: 'd3', status: 'assigned', assignment_deadline: now + 60000 }, // deadline open → no
  };
  assert.equal(enFilaAttentionCount(orders, tasks, now), 0); ok('cancelled/completed-unassigned + not-yet-expired → 0');
}
{
  assert.equal(enFilaAttentionCount({}, {}, now), 0); ok('empty → 0');
  // An order with no delivery task is skipped (not counted).
  assert.equal(enFilaAttentionCount({ Z: { order_id: 'Z' } }, {}, now), 0); ok('order without delivery task → 0');
}

console.log(`\ndispatch-alert-nav: OK (${n} cases)`);
