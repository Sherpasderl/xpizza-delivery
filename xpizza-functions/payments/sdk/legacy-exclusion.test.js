'use strict';
// Legacy-exclusion cells (BRIEF-sdk-payment-coordinator r5 §2, §4b): every module-level legacy money path REFUSES an SDK
// card order — no provider call, no write to the order or its money — and a cancel is routed to the coordinator. The
// index.js scheduled loops (sweepStalePending, reconcilePayments, refundReconciler ×2) run through their real exports in
// test/sdk-pay-legacy.emulator.test.js. Failure messages start with the cell label. Run: node payments/sdk/legacy-exclusion.test.js
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { paymentHash } = require('../../pixelpay');

const OID = 'tb_sdk_lx';
const AID = 'a1b2c3d4e5f6a7b8';
const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const sdkOrder = (o = {}) => ({ payment_flow: 'sdk_auth_v1', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', restaurant_id: 'tb_rest', order_type: 'delivery', total: 100, total_cents: 10000, customer_uid: 'tb_uid', created_at: 1, ...o });
const legacyOrder = (o = {}) => ({ payment_method: 'online', payment_status: 'pending', status: 'pending_payment', restaurant_id: 'tb_rest', order_type: 'delivery', total: 100, total_cents: 10000, created_at: 1, ...o });
// any provider call is a failure: the spy records it and throws
function spyClient() {
  const calls = [];
  return { calls, client: new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : (...a) => { calls.push(k); throw new Error(`provider called: ${String(k)}`); }) }) };
}
const snapshot = (db) => JSON.stringify(db.root);

let pass = 0; const fails = [];
async function cell(name, fn) { try { await fn(name); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.log(`  ✗ ${name}: ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  await cell('LX-CONFIRM-ONLINE-PAYMENT', async (L) => {
    const db = makeHonestDb({ orders: { [OID]: sdkOrder({ active_attempt_id: AID }) }, payment_attempts: { [AID]: { order_id: OID, status: 'authorized', payment_uuid: 'P-1' } } });
    const { calls, client } = spyClient(); const before = snapshot(db);
    const r = await require('../../pixelpay-confirm').confirmOnlinePayment({ db, client }, { orderId: OID, paymentUuid: 'P-1', now: 1000 });
    assert.strictEqual(r.outcome, 'sdk_flow', `${L}: refused right after the order load (got ${JSON.stringify(r)})`);
    assert.ok(calls.length === 0 && snapshot(db) === before, `${L}: no provider call (${calls}), nothing written`);
  });
  await cell('LX-CONFIRM-AND-MATERIALIZE', async (L) => {
    const db = makeHonestDb({ orders: { [OID]: sdkOrder({ payment_status: 'confirmed', active_attempt_id: AID }) } });
    const before = snapshot(db);
    const r = await require('../../pixelpay-confirm').confirmAndMaterialize({ db, buildMaterializeUpdates: () => { throw new Error('materialized'); } }, { orderId: OID, attemptId: AID, now: 1000 });
    assert.ok(r.outcome === 'sdk_flow' && snapshot(db) === before, `${L}: refused, nothing materialized (got ${JSON.stringify(r)})`);
  });
  await cell('LX-RESOLVE-MANUAL', async (L) => {
    for (const action of ['materialize', 'cancel', 'refund', 'abandon']) {
      const db = makeHonestDb({ orders: { [OID]: sdkOrder({ payment_status: 'manual_reconciliation', active_attempt_id: AID }) } });
      const { calls, client } = spyClient();
      const r = await require('../../resolve-manual').resolveManualReconciliationCore({ db, client, alert: () => {}, sanitizeText: (x) => x, serverTimestamp: 1 }, { orderId: OID, action, actor: 'tb_disp', note: '', now: 1000, claimId: 'c1' });
      assert.ok(r && r.body && r.body.outcome === 'sdk_flow' && calls.length === 0, `${L}: ${action} refused before any claim (got ${JSON.stringify(r)})`);
      assert.deepStrictEqual(db.getAt(`orders/${OID}`), sdkOrder({ payment_status: 'manual_reconciliation', active_attempt_id: AID }), `${L}: ${action}: the order is untouched`);
    }
  });
  const pending = sdkOrder();
  for (const [name, mod, fn, args] of [
    ['LX-ACQUIRE-HOSTED', '../../pixelpay-hosted-charge', 'acquireHostedAttempt', (db) => [db, OID, pending, 'fp', 1000]],
    ['LX-ACQUIRE-ONLINE-DORMANT', '../../pixelpay-charge', 'acquireOnlineAttempt', (db) => [db, OID, pending, 'fp']],
  ]) {
    await cell(`${name}-PRE-READ`, async (L) => {
      const db = makeHonestDb({ orders: { [OID]: sdkOrder() } });
      const before = snapshot(db);
      const r = await require(mod)[fn](...args(db));
      assert.ok(r.outcome === 'closed' && r.reason === 'sdk_flow' && snapshot(db) === before, `${L}: an SDK order is never installed / recovered (got ${JSON.stringify(r)})`);
    });
    await cell(`${name}-IN-TRANSACTION`, async (L) => {
      // the pre-read saw a legacy-looking order; the transaction sees the SDK marker → it must abort, never install
      let flipped = false;
      const db = makeHonestDb({ orders: { [OID]: legacyOrder() } }, { beforeTx: async (p, api) => { if (p === `orders/${OID}` && !flipped) { flipped = true; api.setAt(`orders/${OID}/payment_flow`, 'sdk_auth_v1'); } } });
      const r = await require(mod)[fn](...args(db));
      assert.ok(flipped && !db.getAt(`orders/${OID}/active_attempt_id`), `${L}: the acquisition transaction refuses the SDK order (got ${JSON.stringify(r)}, attempt ${db.getAt(`orders/${OID}/active_attempt_id`)})`);
    });
  }
  await cell('LX-HOSTED-CALLBACK', async (L) => {
    const HOID = `${OID}-${AID}`;
    const db = makeHonestDb({ orders: { [OID]: sdkOrder({ active_attempt_id: AID }) }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created', hosted_order_id: HOID } } });
    const { calls, client } = spyClient();
    const r = await require('../../pixelpay-hosted-webhook').handleHostedCallback({ db, client, alert: () => {}, genToken: () => 'T', buildMaterializeUpdates: () => ({}) }, { order: HOID, status: 'paid', amount: 100, uuid: 'P-1', transaction_id: 'TX', payment_hash: paymentHash(HOID, KEY, SECRET) }, 1000);
    assert.ok(r.code === 200 && r.outcome === 'ignored_sdk_flow' && calls.length === 0, `${L}: acknowledged, never acted on (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual(db.getAt(`orders/${OID}`), sdkOrder({ active_attempt_id: AID }), `${L}: the order is untouched`);
    assert.ok(db.getAt(`dispatcher_alerts/sdkpay_hosted_callback_${OID}`), `${L}: a person is told (a hosted payment on an SDK order is a money anomaly)`);
  });
  await cell('LX-REWARD-SWEEP-NEVER-RELEASES-SDK', async (L) => {
    for (const [label, rec, order] of [
      ['cancelled order', { state: 'reserved', created_at: 0 }, sdkOrder({ status: 'cancelled' })],
      ['hosted-expiry branch', { state: 'reserved', created_at: 0, hosted_expires_at: 1 }, sdkOrder({ status: 'cancelled', payment_status: 'failed' })],
    ]) {
      const db = makeHonestDb({ orders: { [OID]: order }, user_rewards: { tb_uid: { tb_rest: { reservations: { [OID]: rec } } } } });
      const out = await require('../../rewards-reserve').sweepStaleReservations(db, { now: 10 * 24 * 3600 * 1000 });
      assert.strictEqual(db.getAt(`user_rewards/tb_uid/tb_rest/reservations/${OID}/state`), 'reserved', `${L}: ${label}: the SDK reservation is NOT released by age (coordinator-owned)`);
      assert.ok(out.released.length === 0, `${L}: ${label}: nothing released (got ${JSON.stringify(out.released)})`);
    }
    // non-vacuity: the same cancelled LEGACY reservation IS released
    const db2 = makeHonestDb({ orders: { [OID]: legacyOrder({ status: 'cancelled' }) }, user_rewards: { tb_uid: { tb_rest: { reservations: { [OID]: { state: 'reserved', created_at: 0 } } } } } });
    const o2 = await require('../../rewards-reserve').sweepStaleReservations(db2, { now: 10 * 24 * 3600 * 1000 });
    assert.ok(o2.released.length === 1, `${L}: PREMISE — a legacy cancelled reservation is released (got ${JSON.stringify(o2.released)})`);
  });
  await cell('LX-ALERT-PRUNE-KEEPS-SDK-MONEY-ALERTS', async (L) => {
    const { alertsToPrune } = require('../../alert-prune');
    const alerts = { sdkpay_unknown_op_x: { type: 'payment_sdk_unknown_op', detail: { orderId: OID } }, legacy: { type: 'payment_refund_pending', detail: { orderId: OID } } };
    const pruned = alertsToPrune(alerts, { [OID]: { status: 'cancelled', payment_status: 'refunded' } });
    assert.ok(!pruned.includes('sdkpay_unknown_op_x'), `${L}: an SDK money alert is never auto-pruned (got ${JSON.stringify(pruned)})`);
    assert.ok(pruned.includes('legacy'), `${L}: PREMISE — the legacy alert on the same resolved order is pruned (got ${JSON.stringify(pruned)})`);
  });
  await cell('LX-CANCEL-CORE-ROUTES-TO-COORDINATOR', async (L) => {
    const db = makeHonestDb({
      orders: { [OID]: sdkOrder({ status: 'preparing', payment_placed: { leg_id: 'L1', at: 1 } }) },
      payment_sdk: { [OID]: { flow: 'sdk_auth_v1', version: 3, phase: 'open', committed_revision: 0, fulfillment_total_cents: 10000, created_at: 1, ttl_at: 2, legs: { L1: { kind: 'original', amount_cents: 10000, role: 'committed', state: 'approved', pp_uuid: 'P-1', created_at: 1, hold_expires_at: 9e15 } }, ops: { o1: { leg_id: 'L1', action: 'auth', dispatched_at: 1, result: { kind: 'approved', at: 1 } } } } },
    });
    let voided = 0;
    const r = await require('../../cancel-order-core').cancelOrderCore({ db, voidOrRefund: async () => { voided += 1; return { voided: true }; }, alert: () => {}, serverTimestamp: 1 }, { orderId: OID, actor: 'tb_disp', reason: 'x', now: 1000, claimId: 'c1' });
    assert.ok(voided === 0, `${L}: the legacy void path is never reached`);
    assert.ok(db.getAt(`orders/${OID}/payment_cancel`) && db.getAt(`payment_sdk/${OID}/phase`) === 'cancelled' && db.getAt(`payment_sdk/${OID}/legs/L1/role`) === 'surplus', `${L}: the coordinator cancelled it (got ${JSON.stringify(r)})`);
  });
  await cell('LX-MERCHANT-TERMINAL-MARKER-AND-REFUSAL', async (L) => {
    const { applyAction } = require('../../merchant/merchant-transitions');
    const ctx = { uid: 'u_dev', payloadHash: 'h', nowMs: 5000 };
    const node = sdkOrder({ status: 'ready', order_type: 'pickup', routing_reason: 'x', payment_commit: { revision: 2, pid: 'p2' } });
    const r = applyAction(node, { rid: 'tb_rest', op_id: 'op1', action: 'handed', payload: {} }, ctx);
    assert.ok(r.commit && r.commit.status === 'completed' && r.commit.payment_terminal && r.commit.payment_terminal.revision === 2, `${L}: handed → completed writes payment_terminal in the SAME transaction (got ${JSON.stringify(r.commit && r.commit.payment_terminal)})`);
    const legacy = applyAction(legacyOrder({ status: 'ready', order_type: 'pickup', routing_reason: 'x' }), { rid: 'tb_rest', op_id: 'op1', action: 'handed', payload: {} }, ctx);
    assert.ok(legacy.commit && legacy.commit.payment_terminal === undefined, `${L}: a legacy order gets no payment_terminal`);
    const reverted = applyAction(sdkOrder({ status: 'ready', order_type: 'pickup', routing_reason: 'x', payment_terminal: { revision: 0, at: 1 } }), { rid: 'tb_rest', op_id: 'op2', action: 'handed', payload: {} }, ctx);
    assert.ok(reverted.abort && reverted.abort.code === 'stale_state', `${L}: an order already decided terminal for payments is refused (got ${JSON.stringify(reverted)})`);
  });
  await cell('LX-SCHEDULED-CLAIM-REFUSES-SDK', async (L) => {
    const db = makeHonestDb({ orders: { [OID]: sdkOrder({ status: 'scheduled', release_at: 10 }) } });
    const r = await require('../../scheduled-release-core').claimForRelease({ db }, OID, 1000, 'claim1');
    assert.ok(!r.claimed && db.getAt(`orders/${OID}/status`) === 'scheduled', `${L}: an SDK scheduled order is not claimed by the legacy release (got ${JSON.stringify(r)})`);
  });
  await cell('LX-SCHEDULED-ROLLBACK-NEVER-REVERTS-A-MOVED-ORDER', async (L) => {
    // the release claimed it (releasing); then a dispatcher delivered it; a held release must NOT restore 'scheduled'
    const order = legacyOrder({ status: 'releasing', release_claim_id: 'c1', releasing_since: 1, release_at: 10 });
    const db = makeHonestDb({ orders: { [OID]: { ...order, status: 'delivered' } } });
    await require('../../scheduled-release-core').finalizeRelease({ db, orderControl: async () => ({ paused: true, cause: 'pause' }) }, OID, order, 1000);
    assert.strictEqual(db.getAt(`orders/${OID}/status`), 'delivered', `${L}: the rollback is conditional on 'releasing' — a delivered order stays delivered (got ${db.getAt(`orders/${OID}/status`)})`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nsdk legacy exclusion: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
