'use strict';
// PLAN-5f-cancel-park r1 option A (owner FIX 11-19; KIND-TABLE ruling 2). cancelOrderCore refuses three money cases. Each answered 409 +
// an alert and left NOTHING durable, so a lost alert left a captured charge nobody would look at. Now each refusal PARKS the order at
// payment_status 'manual_review' + blocked_reason + cancel_parked_at, in the SAME single transaction that releases the cancel claim
// (or, for an already-cancelled order, one guarded CAS). reconcilePayments then re-raises it daily (aged_manual_review), and a cancel retry
// meets the B.2 gate (never the void path).
//   CP-A        an already-CANCELLED order with captured money and no payment id ⇒ parked (cancel_no_uuid_cancelled)
//   CP-B        captured money, no payment id ⇒ parked in the claim-release transaction (cancel_captured_no_uuid)
//   CP-C        a payment id with no captured evidence (ambiguous) ⇒ parked in the claim-release transaction (cancel_ambiguous_paid_evidence)
//   CP-SAME     every refusal still answers 409 manual_review, still raises cancel_manual_review, still writes its payment_audit row
//   CP-PUSH     the alert push FAILS ⇒ the order is still parked (the durable twin of the alert)
//   CP-RETRY    a second cancel on a parked order ⇒ the gate's refusal; voidOrRefund is never called
//   CP-GUARD    the A-path CAS never overwrites a resolver-owned / already-reviewed / reversed order
// Through the REAL cancelOrderCore on the honest RTDB model. Run: node payments/cancel-park.test.js
const assert = require('assert');
const { cancelOrderCore } = require('../cancel-order-core');
const { paymentAlert } = require('../lib/payment-alert');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const OID = 'CPK1', AID = 'c0ffee00c0ffee77';
const NOW = 1_800_000_000_000;
const ORDER = (o = {}) => ({ order_id: OID, order_type: 'pickup', status: 'new', payment_status: 'confirmed', payment_method: 'online', total: 299, total_cents: 29900,
  customer_name: 'T', items_text: 'x', restaurant_id: 'x_pizza', active_attempt_id: AID, created_at: NOW - 3600000, ...o });
const quiet = async (f) => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await f(); } finally { console.warn = w; console.error = e; console.log = l; } };
let voids = 0;
const deps = (db, { failPush = false } = {}) => ({ db, voidOrRefund: async () => { voids += 1; return { voided: true }; },
  alert: (k, d) => paymentAlert(failPush ? { ref: () => ({ push: async () => { throw Object.assign(new Error('down'), { code: 'UNAVAILABLE' }); } }) } : db, k, d), serverTimestamp: 0 });
const cancel = (db, opts = {}, claimId = 'CL1') => quiet(() => cancelOrderCore(deps(db, opts), { orderId: OID, actor: 'disp@tb', reason: 'customer', now: NOW, claimId }));
const alerts = (db) => Object.values(db.getAt('dispatcher_alerts') || {}).filter((a) => a && a.type === 'payment_cancel_manual_review');
const audits = (db) => Object.values(db.getAt('payment_audit') || {}).filter((a) => a && a.order_id === OID);
const parkedAs = (o, reason) => [o.payment_status, o.blocked_reason, o.cancel_parked_at, o.cancel_claim_id || null, o.resolving_action || null, o.resolving_phase || null];
const PARKED = (reason) => ['manual_review', reason, NOW, null, null, null];

(async () => {
  const CASES = [
    ['CP-A', 'cancel_no_uuid_cancelled', { status: 'cancelled' }, { hosted_state: 'paid', hosted_callback_verified: true }],
    ['CP-B', 'cancel_captured_no_uuid', {}, { hosted_state: 'paid', hosted_callback_verified: true }],
    ['CP-C', 'cancel_ambiguous_paid_evidence', { status: 'new', payment_status: 'pending' }, { hosted_state: 'created', payment_uuid: 'U-DECLINED' }],
  ];
  for (const [cell, reason, ord, att] of CASES) {
    voids = 0;
    const db = makeDb({ orders: { [OID]: ORDER(ord) }, payment_attempts: { [AID]: { order_id: OID, ...att } } });
    const r = await cancel(db);
    assert.deepStrictEqual([r.status, r.body && r.body.outcome], [409, 'manual_review'], `${cell} premise: the refusal (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual(parkedAs(db.getAt(`orders/${OID}`), reason), PARKED(reason), `🔴 ${cell}: the order is PARKED (manual_review + ${reason} + cancel_parked_at), the claim released`);
    assert.strictEqual(db.getAt(`orders/${OID}/status`), ord.status || 'new', `${cell}: the order's status is untouched`);
    assert.strictEqual(voids, 0, `${cell}: no void`);
    assert.strictEqual(alerts(db).length, 1, `CP-SAME ${cell}: still ONE cancel_manual_review alert`);
    ok(`${cell}: refused ⇒ parked at manual_review (${reason}), claim released, status untouched, no void, one alert`);
  }
  {
    // CP-SAME: the audit rows the B/C refusals wrote stay
    const db = makeDb({ orders: { [OID]: ORDER() }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'paid', hosted_callback_verified: true } } });
    await cancel(db);
    assert.deepStrictEqual(audits(db).map((a) => [a.outcome, a.reason]), [['manual_review', 'captured_no_uuid']], 'CP-SAME: the payment_audit row stays');
    ok('CP-SAME: the 409, the alert and the audit row are unchanged');
  }
  {
    // CP-PUSH: the alert is lost ⇒ the park is the durable record
    const db = makeDb({ orders: { [OID]: ORDER() }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'paid', hosted_callback_verified: true } } });
    await cancel(db, { failPush: true });
    assert.deepStrictEqual([alerts(db).length, ...parkedAs(db.getAt(`orders/${OID}`), 'cancel_captured_no_uuid')], [0, ...PARKED('cancel_captured_no_uuid')], '🔴 CP-PUSH: with the alert lost, the order is still parked');
    ok('CP-PUSH: a failed alert push still leaves the order parked (the durable twin)');
  }
  {
    // CP-RETRY: a parked order meets the gate — never the void path
    const db = makeDb({ orders: { [OID]: ORDER() }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'paid', hosted_callback_verified: true } } });
    await cancel(db); voids = 0;
    const r2 = await cancel(db, {}, 'CL2');
    assert.deepStrictEqual([r2.status, r2.body.outcome, voids, db.getAt(`orders/${OID}/cancel_claim_id`) || null], [409, 'manual_review', 0, null], '🔴 CP-RETRY: the second cancel is refused by the gate, no void, no claim');
    ok('CP-RETRY: a retried cancel on a parked order is refused at the gate (no claim, no void)');
  }
  {
    // CP-GUARD: the A-path CAS (an already-cancelled order) never overwrites an order that moved
    for (const [label, over] of [['a resolver claim', { payment_status: 'resolving_refund' }], ['already reviewed', { payment_status: 'manual_review', blocked_reason: 'other' }], ['refunded', { payment_status: 'refunded' }]]) {
      const db = makeDb({ orders: { [OID]: ORDER({ status: 'cancelled', ...over }) }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'paid', hosted_callback_verified: true } } });
      const before = JSON.stringify(db.getAt(`orders/${OID}`));
      await cancel(db);
      assert.strictEqual(JSON.stringify(db.getAt(`orders/${OID}`)), before, `🔴 CP-GUARD: ${label} ⇒ the order is never overwritten`);
    }
    ok('CP-GUARD: the already-cancelled park never overwrites a resolver-owned / reviewed / refunded order');
  }
  console.log(`cancel-park: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
