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
const { voidOrRefund } = require('./pixelpay-cancel');
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
  let _pk = 0;
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
    },
    async set(val) { setAt(path, clone(val)); },
    async push(val) { const k = `k${++_pk}`; setAt(path ? `${path}/${k}` : k, clone(val)); return { key: k }; },
    async remove() { setAt(path, null); }
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
function mkClient({ statusValue = 'authorized', statusSeq, capture, voidOk = true, voidThrows = false, captureThrows = false } = {}) {
  const calls = { capture: 0, void: 0, status: 0 };
  return {
    calls,
    interpretStatus: realClient.interpretStatus,
    verifyCaptureResult: realClient.verifyCaptureResult,
    async getStatus() {
      const v = statusSeq ? statusSeq[Math.min(calls.status, statusSeq.length - 1)] : statusValue;
      calls.status++;
      return { data: { status: v } };
    },
    async capture() {
      calls.capture++;
      if (captureThrows) throw new Error('ETIMEDOUT');
      return capture || { ok: true, httpStatus: 200, data: { response_approved: true, transaction_approved_amount: 385, payment_hash: goodHash, transaction_reference: 'REF123' } };
    },
    async voidTransaction() { calls.void++; if (voidThrows) throw new Error('void net err'); return { ok: voidOk }; }
  };
}

const baseDeps = (db, client) => ({ db, client, restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: () => {} });

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

  // 1b. Scheduled Orders (§B.1): confirm CAPTURES the money but HOLDS the order — status→scheduled,
  //     payment confirmed, but NO materialize (no materialized_at, no tasks, no tracking) until release.
  const ALL_OPEN = { sun: { open: true, start: '00:00', end: '24:00' }, mon: { open: true, start: '00:00', end: '24:00' }, tue: { open: true, start: '00:00', end: '24:00' }, wed: { open: true, start: '00:00', end: '24:00' }, thu: { open: true, start: '00:00', end: '24:00' }, fri: { open: true, start: '00:00', end: '24:00' }, sat: { open: true, start: '00:00', end: '24:00' } };
  const ALL_CLOSED = { sun: { open: false }, mon: { open: false }, tue: { open: false }, wed: { open: false }, thu: { open: false }, fri: { open: false }, sat: { open: false } };
  const schedDeps = (db, client, hours) => ({ ...baseDeps(db, client), getIdentity: async () => ({ active: true, hours }) });
  {
    const init = pendingOrder();
    init.orders['PZX-1'].scheduled_for = 1800000000000;
    init.orders['PZX-1'].release_at = 1799998200000;
    const db = makeDb(init);
    const client = mkClient();
    const r = await confirmOnlinePayment(schedDeps(db, client, ALL_OPEN), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 7000, trackingToken: 'TOK7' });
    assert.strictEqual(r.outcome, 'scheduled_held');
    const o = db.getAt('orders/PZX-1');
    assert.strictEqual(o.status, 'scheduled');
    assert.strictEqual(o.payment_status, 'confirmed');            // money captured at order time
    assert.ok(!o.materialized_at, 'NOT materialized');
    assert.ok(!db.getAt('tasks/PZX-1_pickup') && !db.getAt('tasks/PZX-1_delivery'), 'no tasks (held)');
    assert.ok(!db.getAt('order_tracking/TOK7'), 'no tracking (held)');
    assert.strictEqual(client.calls.capture, 1, 'captured once');
    ok('scheduled online (slot still open) → captured + HELD (status scheduled, NO materialize/tasks/tracking)');
  }

  // 1c. Codex-on-diff #3: a slot that CLOSED between checkout and the paid callback → NOT silently held.
  //     Money is captured → route to manual_review + block (dispatcher refunds/reschedules), never materialize.
  {
    const init = pendingOrder();
    init.orders['PZX-1'].scheduled_for = 1800000000000;
    const db = makeDb(init);
    const client = mkClient();
    let alerted = null;
    const deps = { ...schedDeps(db, client, ALL_CLOSED), alert: async (k, d) => { alerted = { k, d }; } };
    const r = await confirmOnlinePayment(deps, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 7000, trackingToken: 'TOK8' });
    assert.strictEqual(r.outcome, 'scheduled_confirm_invalid');
    assert.strictEqual(r.reason, 'closed_at_slot');
    const o = db.getAt('orders/PZX-1');
    assert.strictEqual(o.payment_status, 'manual_review');
    assert.strictEqual(o.scheduled_blocked, true);
    assert.ok(!o.materialized_at && !db.getAt('order_tracking/TOK8'), 'NOT materialized, no tracking');
    assert.ok(alerted && alerted.k === 'scheduled_confirm_invalid', 'dispatcher alert raised');
    ok('scheduled online, slot now CLOSED → scheduled_confirm_invalid + manual_review + blocked (money held for review)');
  }

  // 1d. Paid-after-close (grace + auto-refund): an UNSCHEDULED online order authorized while OPEN can CONFIRM
  //     after close (paid at 8:50pm past an 8:45pm close). Re-check hours at materialize; past the REAL kitchen
  //     close (config close + grace) → AUTO-REFUND the captured payment (pre-materialization → no factura),
  //     never land a live ASAP order on a dark kitchen. A CONFIRMED reversal → payment_status:'refunded' +
  //     status:'cancelled' (no dispatcher alert; the fallback manual_review path is exercised in the guard's
  //     own unit test). ALL_CLOSED ⇒ isWithinGrace false at every instant → the refund branch.
  {
    const db = makeDb(pendingOrder());
    const client = mkClient();
    let alerted = null;
    const deps = { ...schedDeps(db, client, ALL_CLOSED), alert: async (k, d) => { alerted = { k, d }; } };
    const r = await confirmOnlinePayment(deps, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 7000, trackingToken: 'TOK9' });
    assert.strictEqual(r.outcome, 'held_closed_at_materialize');
    const o = db.getAt('orders/PZX-1');
    assert.strictEqual(o.payment_status, 'refunded');                  // auto-refunded (was: manual_review hold)
    assert.strictEqual(o.status, 'cancelled');
    assert.strictEqual(o.blocked_reason, 'refunded_paid_after_close');
    assert.ok(!o.materialized_at && o.status !== 'new', 'NOT materialized onto a closed kitchen');
    assert.ok(!db.getAt('order_tracking/TOK9'), 'no tracking');
    assert.strictEqual(client.calls.capture, 1, 'money captured…');
    assert.ok(client.calls.void >= 1, '…then reversed to PixelPay');
    assert.strictEqual(alerted, null, 'no dispatcher alert on a successful auto-refund');
    ok('unscheduled online paid AFTER close, past grace → AUTO-REFUNDED (refunded + cancelled), never new');
  }

  // 1e. Same order, kitchen OPEN at materialize → materializes to new (normal paid-while-open, UNCHANGED).
  {
    const db = makeDb(pendingOrder());
    const client = mkClient();
    const r = await confirmOnlinePayment(schedDeps(db, client, ALL_OPEN), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 7000, trackingToken: 'TOKA' });
    assert.strictEqual(r.outcome, 'confirmed');
    assert.strictEqual(db.getAt('orders/PZX-1').status, 'new');
    assert.strictEqual(db.getAt('order_tracking/TOKA').status, 'new', 'tracking materialized');
    ok('unscheduled online paid while OPEN → materializes to new (normal flow unchanged)');
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
    // [B] a REDEEMED order with a reserved hold: the paid-but-unverifiable route must HOLD it (held_paid) so no
    // release sweep frees a possibly-paid hold → free item delivered without consuming punches.
    init.orders['PZX-1'].customer_uid = 'uC'; init.orders['PZX-1'].restaurant_id = 'x_pizza';
    init.orders['PZX-1'].redemption = { model: 'add_free', free_item_key: 'Margherita' };
    init.user_rewards = { uC: { x_pizza: { balance: 100, reserved: 8, reservations: { 'PZX-1': { state: 'reserved', cost: 8, seq: 1, created_at: 0 } } } } };
    const db = makeDb(init);
    const client = mkClient({ statusValue: 'paid' });
    // now far past capturing_started_at(0) + staleMs → stale claim, we take over.
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 100000 });
    assert.strictEqual(r.outcome, 'manual_reconciliation');
    assert.strictEqual(db.getAt('orders/PZX-1').payment_status, 'manual_reconciliation');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'capture_unverified');
    assert.strictEqual(client.calls.capture, 0, 'never re-capture a paid-but-unverified uuid');
    assert.strictEqual(db.getAt('user_rewards/uC/x_pizza/reservations/PZX-1').state, 'held_paid');
    ok('getStatus=paid + no verified result → manual_reconciliation + [B] redemption held_paid (no re-capture)');
  }

  // 5. Capture declined (amount>auth etc.) → failed, no money moved. [C/#15] a REDEEMED order's hold is RELEASED
  //    promptly (definitive not-captured — PixelPay was queried), never left reserved for the daily sweep.
  {
    const init = pendingOrder();
    init.orders['PZX-1'].customer_uid = 'uD'; init.orders['PZX-1'].restaurant_id = 'x_pizza';
    init.orders['PZX-1'].redemption = { model: 'add_free', free_item_key: 'Margherita' };
    init.user_rewards = { uD: { x_pizza: { balance: 100, reserved: 8, reservations: { 'PZX-1': { state: 'reserved', cost: 8, seq: 1 } } } } };
    const db = makeDb(init);
    const client = mkClient({ capture: { ok: false, httpStatus: 402, message: 'El monto enviado es mayor al monto autorizado' } });
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 5000 });
    assert.strictEqual(r.outcome, 'capture_failed');
    assert.strictEqual(db.getAt('orders/PZX-1').payment_status, 'failed');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'declined');
    assert.strictEqual(db.getAt('orders/PZX-1').status, 'pending_payment', 'order not materialized');
    assert.strictEqual(db.getAt('user_rewards/uD/x_pizza/reservations/PZX-1').state, 'released');   // [C/#15] hold released on the definitive decline
    ok('capture declined → failed + [C/#15] redemption hold released promptly (order stays pending for fallback)');
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

  // 10. Capture 412 + getStatus NOT paid (declined auth's uuid) → capture_failed.
  {
    const db = makeDb(pendingOrder());
    const client = mkClient({ statusValue: 'authorized', capture: { ok: false, httpStatus: 412, message: 'Error al encontrar el cobro' } });
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-decl', now: 9000 });
    assert.strictEqual(r.outcome, 'capture_failed');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'declined');
    assert.strictEqual(db.getAt('orders/PZX-1').payment_status, 'failed');
    ok('capture 412 + not paid (declined auth) → capture_failed (NOT manual_reconciliation)');
  }

  // 10b. Capture 412 but getStatus shows paid at re-check (settled, lost response) → manual_reconciliation.
  {
    const db = makeDb(pendingOrder());
    // pre-check sees 'authorized' (proceed to capture), re-check after 412 sees 'paid'.
    const client = mkClient({ statusSeq: ['authorized', 'paid'], capture: { ok: false, httpStatus: 412, message: 'Error al encontrar el cobro' } });
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-lost', now: 9500 });
    assert.strictEqual(r.outcome, 'manual_reconciliation');
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'capture_unverified');
    ok('capture 412 + getStatus paid at re-check (lost response) → manual_reconciliation');
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

  // 14. Cancel-vs-confirm race (I8): a capture lands while the attempt is `cancelling`
  //     → VOID the capture, cancel the order, NEVER materialize.
  {
    const init = pendingOrder();
    init.payment_attempts['A'].cancelling = true; // a cancel landed during capture
    const db = makeDb(init);
    const client = mkClient(); // capture succeeds (good hash/amount); voidTransaction ok
    const r = await confirmOnlinePayment(baseDeps(db, client), { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 11000 });
    assert.strictEqual(r.outcome, 'cancelled_voided');
    assert.strictEqual(client.calls.void, 1, 'the captured payment is voided');
    assert.strictEqual(db.getAt('orders/PZX-1').status, 'cancelled');
    assert.strictEqual(db.getAt('orders/PZX-1').payment_status, 'refunded');
    assert.notStrictEqual(db.getAt('orders/PZX-1').status, 'new');
    assert.ok(!db.getAt('tasks/PZX-1_delivery'), 'never materialized → no tasks');
    ok('cancel-vs-confirm race → capture VOIDed, order cancelled, never materialized (I8)');
  }

  console.log(`\nAll ${pass} confirm/materialize tests passed.`);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
