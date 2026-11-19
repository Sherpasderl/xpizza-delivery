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
//   CP-RACE     Codex #211: a REAL writer changes the order AFTER cancel's read, right before the park transaction (a void → refunded /
//               refund_pending, a verify-failing callback → manual_reconciliation, the real resolver's claim, a real cancel claim) ⇒ the park
//               never overwrites it; with our claim, ONLY our claim is released (a resolver's fields stay)
// Through the REAL cancelOrderCore on the honest RTDB model. Run: node payments/cancel-park.test.js
const assert = require('assert');
const { cancelOrderCore } = require('../cancel-order-core');
const { paymentAlert } = require('../lib/payment-alert');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { voidOrRefund: realVoid } = require('../pixelpay-cancel');
const realClient = require('../pixelpay-client');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');
const { resolvePixelPayConfig } = require('../pixelpay-config');
const MR = require('../manual-resolve');
const C = require('../cancel-order');
process.env.PIXELPAY_MODE = 'sandbox';
let voidOk = true;   // the provider's answer to a void (the stubbed PixelPay; the REAL client / voidOrRefund run)
globalThis.fetch = async (url) => {
  if (!String(url).endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${url}`);
  return new Response(JSON.stringify(voidOk ? { success: true, message: 'ok' } : { success: false, message: 'no' }), { status: 200 });
};

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
    // CP-RACE (Codex #211 P1-1 / P2-3 / P2-5): the REAL writer runs AFTER cancel's read, right before the park transaction (the honest
    // model's beforeTx hook on the order's Nth transaction: B/C = the 2nd — after the claim; A = the 1st). Nothing it wrote is overwritten.
    const KEY = resolvePixelPayConfig().app_key, SECRET = resolvePixelPayConfig().secret;
    const HOID = `${OID}-${AID}`;
    const cbDeps = (db) => ({ db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund: realVoid });
    const paid = (db) => handleHostedCallback(cbDeps(db), { order: HOID, status: 'paid', amount: 299, uuid: 'U-DECLINED', transaction_id: 'T9', payment_hash: paymentHash(HOID, KEY, SECRET) }, NOW + 1);   // the SAME payment arriving late (B.6 set cancel_pending ⇒ auto-void)
    const badHash = (db) => handleHostedCallback(cbDeps(db), { order: HOID, status: 'paid', amount: 299, uuid: 'PAY-9', transaction_id: 'T9', payment_hash: 'f'.repeat(32) }, NOW + 1);
    const resolverClaim = (db) => db.ref(`orders/${OID}`).transaction((cur) => MR.claimDecision(cur, 'refund', 'RCL', NOW + 2));
    const otherCancelClaim = (db) => db.ref(`orders/${OID}`).transaction((cur) => C.claimDecision(cur, 'CL-OTHER', NOW + 2));
    const race = async (label, { ord, att, nth, inject, ok: okVoid = true, want }) => {
      voidOk = okVoid; voids = 0; let db; let seen = 0; let fired = false;
      db = makeDb({ orders: { [OID]: ORDER({ active_attempt_id: AID, ...ord }) }, payment_attempts: { [AID]: { order_id: OID, hosted_order_id: HOID, ...att } } }, {
        beforeTx: async (p) => { if (fired || p !== `orders/${OID}`) return; seen += 1; if (seen === nth) { fired = true; await quiet(() => inject(db)); } },
      });
      await cancel(db);
      assert.ok(fired, `${label} premise: the real writer ran right before the park transaction`);
      const o = db.getAt(`orders/${OID}`);
      want(o, label);
      assert.ok(o.blocked_reason === undefined && o.cancel_parked_at === undefined, `🔴 ${label}: NOT parked over the concurrent outcome (${o.payment_status}, ${o.blocked_reason})`);
    };
    const C_ATT = { hosted_state: 'created', payment_uuid: 'U-DECLINED' }, C_ORD = { status: 'new', payment_status: 'pending' };
    const B_ATT = { hosted_state: 'paid', hosted_callback_verified: true }, A_ORD = { status: 'cancelled' };
    const released = (o) => [o.cancel_claim_id || null, o.resolving_action || null, o.resolving_phase || null];
    // C (claimed): a paid callback auto-voids (B.6 set cancel_pending) → refunded / refund_pending, our claim still on the order
    await race('CP-RACE-C-REFUNDED', { ord: C_ORD, att: C_ATT, nth: 2, inject: paid, want: (o, L) => assert.deepStrictEqual([o.status, o.payment_status, ...released(o)], ['cancelled', 'refunded', null, null, null], `🔴 ${L}: the void's refunded stands; only our claim is released`) });
    await race('CP-RACE-C-REFUND-PENDING', { ord: C_ORD, att: C_ATT, nth: 2, inject: paid, ok: false, want: (o, L) => assert.deepStrictEqual([o.status, o.payment_status, ...released(o)], ['cancelled', 'refund_pending', null, null, null], `🔴 ${L}: refund_pending stands; only our claim is released`) });
    // C / B (claimed): a verify-failing callback queues manual_reconciliation
    await race('CP-RACE-C-RECON', { ord: C_ORD, att: C_ATT, nth: 2, inject: badHash, want: (o, L) => assert.deepStrictEqual([o.payment_status, ...released(o)], ['manual_reconciliation', null, null, null], `🔴 ${L}: the queued manual_reconciliation stands`) });
    await race('CP-RACE-B-RECON', { ord: {}, att: B_ATT, nth: 2, inject: badHash, want: (o, L) => assert.deepStrictEqual([o.payment_status, ...released(o)], ['manual_reconciliation', null, null, null], `🔴 ${L}: the queued manual_reconciliation stands`) });
    // C (claimed): the real resolver claims the queued reconciliation while our cancel claim is still on the order ⇒ its fields stay
    await race('CP-RACE-C-RESOLVER', { ord: C_ORD, att: C_ATT, nth: 2, inject: async (db) => { await badHash(db); await resolverClaim(db); },
      want: (o, L) => assert.deepStrictEqual([o.payment_status, o.resolving_action, o.resolving_phase, o.resolving_claim_id, o.cancel_claim_id || null], ['resolving_refund', 'refund', MR.PHASE.CLAIMED, 'RCL', null], `🔴 ${L}: the resolver's claim is intact (only OUR cancel claim released)`) });
    // A (no claim, an already-cancelled order): a verify-failing callback / a real cancel claim lands first
    await race('CP-RACE-A-RECON', { ord: A_ORD, att: B_ATT, nth: 1, inject: badHash, want: (o, L) => assert.strictEqual(o.payment_status, 'manual_reconciliation', `🔴 ${L}: the queued manual_reconciliation stands (P2-3)`) });
    await race('CP-RACE-A-CLAIM', { ord: A_ORD, att: B_ATT, nth: 1, inject: otherCancelClaim, want: (o, L) => assert.deepStrictEqual([o.payment_status, o.cancel_claim_id, o.resolving_action], ['confirmed', 'CL-OTHER', 'cancel'], `🔴 ${L}: another cancel's claim is left alone`) });
    assert.strictEqual(voids, 0, 'CP-RACE: cancel itself never voided');
    ok('CP-RACE: a refund / void / queued reconciliation / resolver claim / cancel claim landing after the read is never overwritten; only OUR claim is released');
  }
  console.log(`cancel-park: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
