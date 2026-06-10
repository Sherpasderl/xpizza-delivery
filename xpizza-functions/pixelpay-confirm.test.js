/**
 * Unit tests for the online-payment CONFIRM state machine (Stage 4, sub-stage 2).
 *
 * Uses a faithful NESTED-tree RTDB mock (field-level paths + multi-path root update,
 * like real RTDB) and the REAL verifyCaptureResult/interpretStatus from pixelpay-client
 * (PIXELPAY_MODE=sandbox), with capture/getStatus/void stubbed per scenario.
 * Run: `node pixelpay-confirm.test.js`.
 */
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const { confirmOnlinePayment } = require('./pixelpay-confirm');
const { buildMaterializeUpdates } = require('./materialize');
const realClient = require('./pixelpay-client');
const { paymentHash } = require('./pixelpay');

const SBOX_KEY = '1234567890', SBOX_SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };

// ---- nested-tree RTDB mock ----
function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (path) => {
    if (!path) return root;
    let node = root;
    for (const p of path.split('/')) { if (node == null) return null; node = node[p]; }
    return node === undefined ? null : node;
  };
  const setAt = (path, val) => {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (node[p] == null || typeof node[p] !== 'object') node[p] = {};
      node = node[p];
    }
    const last = parts[parts.length - 1];
    if (val === null) delete node[last]; else node[last] = val;
  };
  const ref = (path = '') => ({
    async once() { const v = getAt(path); return { val: () => clone(v) }; },
    async transaction(fn) {
      // Model the Admin SDK: first call gets `null` (uncached); returning undefined there
      // ABORTS permanently. A value triggers an optimistic write that re-runs the fn with
      // the real value on conflict. (Reproduces the first-call-null gotcha.)
      const real = clone(getAt(path));
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: { val: () => real } };
      if (real !== null) {
        next = fn(clone(real));
        if (next === undefined) return { committed: false, snapshot: { val: () => real } };
      }
      setAt(path, clone(next));
      return { committed: true, snapshot: { val: () => clone(getAt(path)) } };
    },
    async update(patch) {
      if (!path) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; }
      setAt(path, Object.assign({}, getAt(path) || {}, clone(patch)));
    }
  });
  return { root, ref, getAt };
}

function pendingOrder({ type = 'delivery' } = {}) {
  const order = {
    order_id: 'PZX-1', customer_name: 'Ana', customer_phone: '50488887777',
    items_text: 'Margherita x1', total: 385, total_cents: 38500, subtotal_cents: 33478, tax_cents: 5022,
    notes: '', payment_method: 'online', payment_status: 'pending', order_type: type,
    status: 'pending_payment', active_attempt_id: 'A', payment_fingerprint: 'fp', created_at: 1
  };
  if (type === 'delivery') {
    order.lat = 15.51; order.lng = -88.03; order.address_detected = 'Calle 1, SPS'; order.address_details = 'casa azul';
  } else { order.pickup_time = 'standard'; }
  return {
    'orders': { 'PZX-1': order },
    'payment_attempts': { 'A': { order_id: 'PZX-1', status: 'active', total_cents: 38500, pixelpay_order_id: 'PZX-1-A', created_at: 1 } }
  };
}

const goodHash = paymentHash('PZX-1-A', SBOX_KEY, SBOX_SECRET);

// scenario client: stub capture/getStatus/void; real verify/interpret.
function mkClient({ statusValue = 'authorized', capture, voidOk = true, voidThrows = false, captureThrows = false } = {}) {
  const calls = { capture: 0, void: 0, status: 0 };
  return {
    calls,
    interpretStatus: realClient.interpretStatus,
    verifyCaptureResult: realClient.verifyCaptureResult,
    async getStatus() { calls.status++; return { data: { status: statusValue } }; },
    async capture() {
      calls.capture++;
      if (captureThrows) throw new Error('ETIMEDOUT');
      return capture || { ok: true, httpStatus: 200, data: { response_approved: true, transaction_approved_amount: 385, payment_hash: goodHash, transaction_reference: 'REF123' } };
    },
    async voidTransaction() { calls.void++; if (voidThrows) throw new Error('void net err'); return { ok: voidOk }; }
  };
}

const baseDeps = (db, client) => ({ db, client, restaurant: RESTAURANT, buildMaterializeUpdates, staleMs: 90000, alert: () => {} });

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // 1. Happy path (delivery) → confirmed + materialized + tasks + tracking.
  {
    const db = makeDb(pendingOrder());
    const client = mkClient();
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 1000, trackingToken: 'TOK1' });
    assert.strictEqual(r.outcome, 'confirmed');
    const o = db.getAt('orders/PZX-1');
    assert.strictEqual(o.status, 'new');
    assert.strictEqual(o.payment_status, 'confirmed');
    assert.strictEqual(o.materialized_at, 1000);
    assert.strictEqual(o.payment_reference, 'REF123');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'captured');
    assert.ok(db.getAt('tasks/PZX-1_pickup'), 'pickup task created');
    assert.ok(db.getAt('tasks/PZX-1_delivery'), 'delivery task created');
    assert.strictEqual(db.getAt('order_tracking/TOK1').status, 'new');
    assert.strictEqual(client.calls.capture, 1);
    ok('happy path → confirmed + materialized (tasks + tracking + captured)');
  }

  // 2. Idempotent re-confirm (already materialized) → no-op.
  {
    const init = pendingOrder();
    init.orders['PZX-1'].payment_status = 'confirmed';
    init.orders['PZX-1'].status = 'new';
    init.orders['PZX-1'].materialized_at = 500;
    const db = makeDb(init);
    const client = mkClient();
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 2000, trackingToken: 'TOK2' });
    assert.strictEqual(r.outcome, 'already_confirmed');
    assert.strictEqual(client.calls.capture, 0, 'no re-capture');
    ok('already confirmed+materialized → already_confirmed (no re-capture)');
  }

  // 3. Crash-after-confirm-before-materialize → re-materialize.
  {
    const init = pendingOrder();
    init.orders['PZX-1'].payment_status = 'confirmed'; // confirmed but NOT materialized
    init.payment_attempts['A'].status = 'captured';
    const db = makeDb(init);
    const client = mkClient();
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 3000, trackingToken: 'TOK3' });
    assert.strictEqual(r.outcome, 'confirmed');
    assert.strictEqual(db.getAt('orders/PZX-1').materialized_at, 3000);
    assert.strictEqual(client.calls.capture, 0, 'no capture on recovery');
    ok('confirmed-but-not-materialized → re-materializes (no capture)');
  }

  // 4. Lost-capture-response: getStatus=paid, no verified result → manual_reconciliation.
  {
    const init = pendingOrder();
    init.payment_attempts['A'].status = 'capturing';
    init.payment_attempts['A'].capturing_started_at = 0; // stale → take over
    init.payment_attempts['A'].payment_uuid = 'S-uuid';
    const db = makeDb(init);
    const client = mkClient({ statusValue: 'paid' });
    // now far past capturing_started_at(0) + staleMs → stale claim, we take over.
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 100000 });
    assert.strictEqual(r.outcome, 'manual_reconciliation');
    assert.strictEqual(db.getAt('orders/PZX-1').payment_status, 'manual_reconciliation');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'capture_unverified');
    assert.strictEqual(client.calls.capture, 0, 'never re-capture a paid-but-unverified uuid');
    ok('getStatus=paid + no verified result → manual_reconciliation (no re-capture)');
  }

  // 5. Capture declined (amount>auth etc.) → failed, no money moved.
  {
    const db = makeDb(pendingOrder());
    const client = mkClient({ capture: { ok: false, httpStatus: 402, message: 'El monto enviado es mayor al monto autorizado' } });
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 5000 });
    assert.strictEqual(r.outcome, 'capture_failed');
    assert.strictEqual(db.getAt('orders/PZX-1').payment_status, 'failed');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'declined');
    assert.strictEqual(db.getAt('orders/PZX-1').status, 'pending_payment', 'order not materialized');
    ok('capture declined → failed (order stays pending for fallback)');
  }

  // 6. Hash mismatch (uuid for a different order) → VOID + fail.
  {
    const db = makeDb(pendingOrder());
    const client = mkClient({ capture: { ok: true, httpStatus: 200, data: { response_approved: true, transaction_approved_amount: 385, payment_hash: 'deadbeef'.repeat(4), transaction_reference: 'R' } } });
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-other', now: 6000 });
    assert.strictEqual(r.outcome, 'mismatch_voided');
    assert.strictEqual(r.reason, 'hash_mismatch');
    assert.strictEqual(client.calls.void, 1, 'voided the mismatched capture');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'voided');
    assert.strictEqual(db.getAt('orders/PZX-1').status, 'pending_payment', 'never materialized');
    ok('capture binding mismatch → VOID + fail (never materialize)');
  }

  // 7. Amount mismatch (correct order hash, wrong amount) → VOID + fail.
  {
    const db = makeDb(pendingOrder());
    const client = mkClient({ capture: { ok: true, httpStatus: 200, data: { response_approved: true, transaction_approved_amount: 1, payment_hash: goodHash, transaction_reference: 'R' } } });
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 7000 });
    assert.strictEqual(r.outcome, 'mismatch_voided');
    assert.strictEqual(r.reason, 'amount_mismatch');
    assert.strictEqual(client.calls.void, 1);
    ok('capture amount mismatch → VOID + fail');
  }

  // 8. Capturing in progress (fresh claim, not stale) → in_progress, no capture.
  {
    const init = pendingOrder();
    init.payment_attempts['A'].status = 'capturing';
    init.payment_attempts['A'].capturing_started_at = 6950; // ~now, within staleMs
    const db = makeDb(init);
    const client = mkClient();
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 7000 });
    assert.strictEqual(r.outcome, 'in_progress');
    assert.strictEqual(client.calls.capture, 0);
    ok('fresh capturing claim held by another → in_progress (no double capture)');
  }

  // 9. Pickup happy path → no tasks, tracking address_short.
  {
    const db = makeDb(pendingOrder({ type: 'pickup' }));
    const client = mkClient();
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 8000, trackingToken: 'TOK9' });
    assert.strictEqual(r.outcome, 'confirmed');
    assert.strictEqual(db.getAt('tasks/PZX-1_pickup'), null, 'pickup orders get no driver tasks');
    assert.strictEqual(db.getAt('order_tracking/TOK9').address_short, 'Recoger en X. Pizza');
    ok('pickup order → confirmed, no tasks, pickup tracking copy');
  }

  // 10. Capture returns 412 (settled, no verified result) → manual_reconciliation.
  {
    const db = makeDb(pendingOrder());
    const client = mkClient({ capture: { ok: false, httpStatus: 412, message: 'Error al encontrar el cobro' } });
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 9000 });
    assert.strictEqual(r.outcome, 'manual_reconciliation');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'capture_unverified');
    ok('capture 412 (settled, unverifiable) → manual_reconciliation');
  }

  // 11. No active attempt.
  {
    const init = pendingOrder();
    delete init.orders['PZX-1'].active_attempt_id;
    const db = makeDb(init);
    const r = await confirmOnlinePayment(baseDeps(db, mkClient()), { orderId: 'PZX-1', paymentUuid: 'S', now: 1 });
    assert.strictEqual(r.outcome, 'no_active_attempt');
    ok('no active_attempt_id → no_active_attempt');
  }

  // 12. Cancelled order → not confirmed.
  {
    const init = pendingOrder();
    init.orders['PZX-1'].status = 'cancelled';
    const db = makeDb(init);
    const client = mkClient();
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S', now: 1 });
    assert.strictEqual(r.outcome, 'cancelled');
    assert.strictEqual(client.calls.capture, 0);
    ok('cancelled order → cancelled (no capture)');
  }

  // 13. materialize builder: delivery vs pickup shape (direct).
  {
    const o = pendingOrder().orders['PZX-1'];
    const u = buildMaterializeUpdates({ orderId: 'PZX-1', order: o, trackingToken: 'T', now: 5, restaurant: RESTAURANT, paymentReference: 'X', paymentMethod: 'online' });
    assert.strictEqual(u['orders/PZX-1/status'], 'new');
    assert.strictEqual(u['orders/PZX-1/payment_status'], 'confirmed');
    assert.strictEqual(u['tasks/PZX-1_delivery'].payment_method, 'online');
    assert.strictEqual(u['tasks/PZX-1_delivery'].total, 385);
    assert.strictEqual(u['order_tracking/T'].address_short, 'Calle 1');
    ok('buildMaterializeUpdates: delivery shape matches createOrder schema');
  }

  console.log(`\nAll ${pass} confirm/materialize tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
