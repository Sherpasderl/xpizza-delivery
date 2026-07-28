'use strict';

/**
 * F-matrix for the universal dispatcher-cancel (CANCEL_PAID_ORDER_FIX_PLAN.md rev-5). Drives the REAL
 * cancelOrderCore + recoverStaleCancel (cancel-order-core.js) + handleHostedCallback against the RTDB
 * emulator, so two concurrent cancels produce genuine transaction contention. Asserts the money invariants:
 * exactly one void + one terminal + one audit per claim; captured-money-only void gate; ambiguous UUID →
 * manual_review; never a fake refunded; capture-in-flight paid callback auto-voided not materialized; recovery.
 *
 * RUN (auditor's Java lane):
 *   JAVA_HOME=/opt/homebrew/opt/openjdk firebase emulators:exec --only database \
 *     --project demo-xpizza "node test/cancel-order.emulator.test.js"
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { cancelOrderCore, recoverStaleCancel, isReconcilerRetryable } = require('../cancel-order-core');
const { voidOrRefund } = require('../pixelpay-cancel');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('MUST run under firebase emulators:exec --only database (no FIREBASE_DATABASE_EMULATOR_HOST)');
  process.exit(1);
}
const NS = 'demo-xpizza';
admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}` });
const db = admin.database();

const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
const NOW = 1700000000000, OID = 'PZXCANCEL', AID = 'a1b2c3d4e5f6a7b8';

const clientVoid = (result, counter) => ({ voidTransaction: async () => { if (counter) counter.n++; return result; } });
const clientThrow = () => ({ voidTransaction: async () => { throw new Error('412 PreconditionalResponse'); } });
function mkDeps(client) {
  const alerts = [];
  return { deps: { db, client, voidOrRefund, alert: async (k, d) => { alerts.push([k, d]); }, serverTimestamp: 111 }, alerts };
}
const webhookDeps = () => ({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }) });

const clearAll = () => db.ref('/').set(null);
async function seed(orderOver = {}, attemptOver = null) {
  await db.ref(`orders/${OID}`).set({ order_id: OID, order_type: 'pickup', payment_method: 'online', payment_status: 'confirmed',
    status: 'new', total: 299, total_cents: 29900, customer_name: 'T', items_text: 'x', active_attempt_id: AID, created_at: 1000, ...orderOver });
  if (attemptOver !== null) await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, hosted_order_id: `${OID}-${AID}`, ...attemptOver });
}
const oVal = async () => (await db.ref(`orders/${OID}`).once('value')).val();
const audits = async () => Object.values((await db.ref('payment_audit').once('value')).val() || {}).filter(a => a.order_id === OID);
const paidCb = () => ({ order: `${OID}-${AID}`, status: 'paid', amount: 299, uuid: 'P-paid-1', transaction_id: 'TXN', payment_hash: paymentHash(`${OID}-${AID}`, KEY, SECRET) });

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  // #1 two concurrent cancels on ONE paid order → one 200 / one 409 / single terminal / SINGLE void / single audit.
  {
    await clearAll(); await seed({}, { hosted_state: 'paid', payment_uuid: 'S-1', capture_verified: true });
    const counter = { n: 0 };
    const [a, b] = await Promise.all([
      cancelOrderCore(mkDeps(clientVoid({ ok: true }, counter)).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID-A' }),
      cancelOrderCore(mkDeps(clientVoid({ ok: true }, counter)).deps, { orderId: OID, actor: 'B', reason: 'y', now: NOW, claimId: 'CID-B' }),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409], `one 200 one 409, got ${a.status}/${b.status}`);
    const o = await oVal();
    assert.strictEqual(o.status, 'cancelled'); assert.strictEqual(o.payment_status, 'refunded');
    assert.strictEqual(o.cancel_claim_id == null, true, 'claim metadata cleared');
    assert.strictEqual(counter.n, 1, `exactly one void, got ${counter.n}`);
    assert.strictEqual((await audits()).filter(x => x.outcome === 'cancelled').length, 1, 'single terminal audit');
    ok('#1 two-cancel race → one 200 / one 409 / single terminal / single void / single audit');
  }

  // #2 heal already-cancelled-but-still-paid (L251 residue) → voids → refunded.
  {
    await clearAll(); await seed({ status: 'cancelled', payment_status: 'confirmed' }, { hosted_state: 'paid', payment_uuid: 'S-1' });
    const r = await cancelOrderCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, actor: 'A', reason: 'heal', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 200); assert.strictEqual((await oVal()).payment_status, 'refunded');
    ok('#2 heal already-cancelled-paid → voids → refunded');
  }

  // #3 cash live order, no captured money → plain finalize (cancelled, NO void).
  {
    await clearAll(); await seed({ payment_method: 'cash', payment_status: 'pending' }, null);
    const counter = { n: 0 };
    const r = await cancelOrderCore(mkDeps(clientVoid({ ok: true }, counter)).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.outcome, 'cancelled');
    assert.strictEqual((await oVal()).status, 'cancelled'); assert.strictEqual(counter.n, 0, 'no void for cash');
    ok('#3 cash / no-evidence live → plain finalize (cancelled, no void)');
  }

  // #4 delivered → 409 not_cancelable (driver already completed).
  {
    await clearAll(); await seed({ status: 'delivered' }, { hosted_state: 'paid', payment_uuid: 'S-1' });
    const r = await cancelOrderCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.outcome, 'not_cancelable');
    assert.strictEqual((await oVal()).status, 'delivered', 'untouched');
    ok('#4 delivered → 409 not_cancelable, order untouched');
  }

  // #5 order says paid but NO resolvable attempt/uuid → manual_review, claim released, order NOT cancelled.
  {
    await clearAll(); await seed({ payment_status: 'confirmed', active_attempt_id: 'GONE' }, null); // no attempt record
    const { deps, alerts } = mkDeps(clientVoid({ ok: true }));
    const r = await cancelOrderCore(deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.outcome, 'manual_review');
    assert.strictEqual((await oVal()).status, 'new', 'NOT cancelled (never strand money)');
    assert.strictEqual((await oVal()).cancel_claim_id == null, true, 'claim released');
    assert.ok(alerts.some(([k]) => k === 'cancel_manual_review'));
    ok('#5 paid-but-no-uuid → 409 manual_review, claim released, not cancelled');
  }

  // #6 UUID-only / declined-auth (bare uuid, no captured evidence) → manual_review, NO void.
  {
    await clearAll(); await seed({ payment_status: 'pending' }, { hosted_state: 'created', payment_uuid: 'S-1' });
    const counter = { n: 0 };
    const r = await cancelOrderCore(mkDeps(clientVoid({ ok: true }, counter)).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.outcome, 'manual_review');
    assert.strictEqual(counter.n, 0, 'NO void on ambiguous UUID');
    assert.strictEqual((await oVal()).status, 'new', 'not cancelled');
    ok('#6 UUID-only/declined → 409 manual_review, no void (ambiguity routing)');
  }

  // #7 void shapes: anulada→refunded / {ok:false}→refund_pending(409) / throw→refund_pending(409).
  {
    for (const [client, wantPs, wantCode] of [[clientVoid({ ok: true }), 'refunded', 200], [clientVoid({ ok: false }), 'refund_pending', 409], [clientThrow(), 'refund_pending', 409]]) {
      await clearAll(); await seed({}, { hosted_state: 'paid', payment_uuid: 'S-1' });
      const r = await cancelOrderCore(mkDeps(client).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
      assert.strictEqual((await oVal()).payment_status, wantPs, `void→${wantPs}`);
      assert.strictEqual(r.status, wantCode, 'honest status');
      assert.strictEqual((await oVal()).status, 'cancelled');
    }
    ok('#7 void anulada→refunded(200); false/throw→refund_pending(409) — never fake refunded');
  }

  // #8 capture-in-flight: attempt cancel_pending set → a paid callback is AUTO-VOIDED, never materialized.
  {
    await clearAll(); await seed({ payment_status: 'pending', status: 'pending_payment' }, { hosted_state: 'created', cancel_pending: true, cancelling: true });
    const r = await handleHostedCallback(webhookDeps(), paidCb(), NOW);
    assert.strictEqual(r.outcome, 'cancelled_voided', `expected auto-void, got ${r.outcome}`);
    assert.ok(!(await oVal()).materialized_at, 'NOT materialized');
    assert.strictEqual((await oVal()).payment_status, 'refunded');
    ok('#8 capture-in-flight (cancel_pending) → paid callback auto-voided, not materialized');
  }

  // #9 recovery: pre-side-effect stale → clear claim (order intact); post-side-effect stale → manual_review + alert.
  {
    await clearAll(); await seed({ resolving_action: 'cancel', cancel_claim_id: 'OLD', resolving_phase: 'claimed', resolving_claimed_at: NOW - 7 * 3600 * 1000 });
    await recoverStaleCancel(mkDeps(clientVoid({ ok: true })).deps, OID, await oVal(), NOW, 6 * 3600 * 1000);
    let o = await oVal();
    assert.strictEqual(o.cancel_claim_id == null, true); assert.strictEqual(o.status, 'new', 'pre-side-effect → claim cleared, order intact');
    ok('#9a recovery pre-side-effect stale → clear claim (order untouched)');

    await clearAll(); await seed({ resolving_action: 'cancel', cancel_claim_id: 'OLD', resolving_phase: 'side_effect_started', resolving_claimed_at: NOW - 7 * 3600 * 1000 });
    const { deps, alerts } = mkDeps(clientVoid({ ok: true }));
    await recoverStaleCancel(deps, OID, await oVal(), NOW, 6 * 3600 * 1000);
    assert.strictEqual((await oVal()).payment_status, 'manual_review'); assert.strictEqual(alerts.length, 1);
    ok('#9b recovery post-side-effect stale → manual_review + alert (never blind re-void)');
  }

  // #11 [Fix#1] retry-cancel on a manual_review order (from a prior recovery) → 409, NO second void.
  {
    await clearAll(); await seed({ payment_status: 'manual_review' }, { hosted_state: 'paid', payment_uuid: 'S-1', capture_verified: true });
    const counter = { n: 0 };
    const r = await cancelOrderCore(mkDeps(clientVoid({ ok: true }, counter)).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.outcome, 'manual_review');
    assert.strictEqual(counter.n, 0, 'manual_review retry must NOT re-void');
    ok('#11 retry-cancel on manual_review → 409, no second void (recovery double-void guard)');
  }

  // #12 [Fix#1] attempt already refunded → shouldVoid false → no re-void, clean finalize.
  {
    await clearAll(); await seed({ payment_status: 'confirmed' }, { hosted_state: 'paid', payment_uuid: 'S-1', capture_verified: true, status: 'refunded' });
    const counter = { n: 0 };
    await cancelOrderCore(mkDeps(clientVoid({ ok: true }, counter)).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    const o12 = await oVal();
    assert.strictEqual(o12.status, 'cancelled'); assert.strictEqual(counter.n, 0, 'already-refunded attempt → NO re-void');
    assert.strictEqual(o12.payment_status, 'refunded', '[Fix A] stale confirmed SYNCED to refunded, not left confirmed');
    ok('#12 attempt already refunded → cancelled + payment_status synced to refunded, no re-void');
  }

  // #13 [Fix#2] durable marker fails to commit → voidOrRefund ABORTS the void → refund_pending, no PixelPay call.
  {
    await clearAll(); await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, status: 'captured' });
    const counter = { n: 0 };
    const vr = await voidOrRefund({ db, client: clientVoid({ ok: true }, counter), alert: () => {}, markSideEffectStarted: async () => false },
      { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'x', now: NOW });
    assert.strictEqual(vr.voided, false); assert.strictEqual(vr.outcome, 'refund_pending');
    assert.strictEqual(counter.n, 0, 'marker uncommitted → void NOT attempted');
    ok('#13 marker-write-fails → void aborted (refund_pending), no double-void window');
  }

  // #14 [Fix#3] paid callback with order.resolving_action='cancel' (claim set, attempt NOT yet flagged) → auto-void.
  {
    await clearAll(); await seed({ payment_status: 'pending', status: 'pending_payment', resolving_action: 'cancel', cancel_claim_id: 'CID' }, { hosted_state: 'created' });
    const r = await handleHostedCallback(webhookDeps(), paidCb(), NOW);
    assert.strictEqual(r.outcome, 'cancelled_voided', `expected auto-void, got ${r.outcome}`);
    assert.ok(!(await oVal()).materialized_at, 'NOT materialized (order-claim gap closed)');
    ok('#14 paid callback with order-level cancel claim (attempt unflagged) → auto-voided, not materialized');
  }

  // #15 [Fix B] concurrent confirm-guard-void + cancel-void on ONE captured attempt → exactly one PixelPay void.
  {
    await clearAll(); await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, status: 'captured', payment_uuid: 'S-1' });
    const counter = { n: 0 }; const d = { db, client: clientVoid({ ok: true }, counter), alert: () => {} };
    await Promise.all([
      voidOrRefund(d, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'cancel', now: NOW }),
      voidOrRefund(d, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'confirm_guard', now: NOW }),
    ]);
    assert.strictEqual(counter.n, 1, `exactly one PixelPay void across two concurrent callers, got ${counter.n}`);
    assert.strictEqual((await db.ref(`payment_attempts/${AID}`).once('value')).val().status, 'refunded');
    ok('#15 concurrent confirm-guard-void + cancel-void → exactly one void (counter=1), attempt refunded');
  }

  // #16 [Fix A] already-reversed (attempt refund_pending) + stale order.payment_status='confirmed' → syncs to refund_pending.
  {
    await clearAll(); await seed({ payment_status: 'confirmed' }, { hosted_state: 'paid', payment_uuid: 'S-1', capture_verified: true, status: 'refund_pending' });
    const counter = { n: 0 };
    const r = await cancelOrderCore(mkDeps(clientVoid({ ok: true }, counter)).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.outcome, 'refund_pending');
    assert.strictEqual((await oVal()).payment_status, 'refund_pending', 'synced (not left confirmed)');
    assert.strictEqual(counter.n, 0, 'no void on already-reversed');
    ok('#16 already-reversed (refund_pending) + stale confirmed → syncs to refund_pending (409), no void');
  }

  // #17 [Fix B-r2] refundReconciler re-drives a refund_pending attempt → claims reversing + CALLS PixelPay.
  {
    await clearAll(); await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, status: 'refund_pending', payment_uuid: 'S-1' });
    const counter = { n: 0 };
    const vr = await voidOrRefund({ db, client: clientVoid({ ok: true }, counter), alert: () => {} }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'reconciler', now: NOW });
    assert.strictEqual(counter.n, 1, 'reconciler must re-drive refund_pending → PixelPay called');
    assert.strictEqual(vr.voided, true);
    assert.strictEqual((await db.ref(`payment_attempts/${AID}`).once('value')).val().status, 'refunded');
    ok('#17 refundReconciler re-drives refund_pending → claims + voids (counter=1), ends refunded');
  }

  // #18 [Fix B-r2] stale reversing (crashed) → reclaim + alert + re-drive; fresh reversing (in-flight) → short-circuit.
  {
    await clearAll(); await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, status: 'reversing', reversing_at: NOW - 5 * 60 * 1000, payment_uuid: 'S-1' });
    const c1 = { n: 0 }; const alerts = [];
    await voidOrRefund({ db, client: clientVoid({ ok: true }, c1), alert: (k) => alerts.push(k) }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'x', now: NOW });
    assert.strictEqual(c1.n, 1, 'stale reversing → reclaimed + re-driven'); assert.ok(alerts.includes('stale_reversing_reclaimed'), 'stale-reversing alert fired');

    await clearAll(); await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, status: 'reversing', reversing_at: NOW - 1000, payment_uuid: 'S-1' });
    const c2 = { n: 0 };
    const vr2 = await voidOrRefund({ db, client: clientVoid({ ok: true }, c2), alert: () => {} }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'x', now: NOW });
    assert.strictEqual(c2.n, 0, 'FRESH reversing → short-circuit, no double-void'); assert.strictEqual(vr2.voided, false);
    ok('#18 stale reversing → reclaim+alert+redrive; fresh reversing → short-circuit (no double-void)');
  }

  // #19 [Fix B-r3] the refundReconciler SELECTOR reaches a stale reversing (else the reclaim path is dead code /
  // stranded charge) → re-driven → refunded; a fresh reversing is skipped (no double-void).
  {
    const RS = 2 * 60 * 1000;
    await clearAll();
    await db.ref('payment_attempts/STALE').set({ order_id: OID, status: 'reversing', reversing_at: NOW - 5 * 60 * 1000, payment_uuid: 'S-1' });
    await db.ref('payment_attempts/FRESH').set({ order_id: OID, status: 'reversing', reversing_at: NOW - 1000, payment_uuid: 'S-2' });
    const stale = (await db.ref('payment_attempts/STALE').once('value')).val();
    const fresh = (await db.ref('payment_attempts/FRESH').once('value')).val();
    assert.strictEqual(isReconcilerRetryable(stale, NOW, RS), true, 'selector picks up stale reversing');
    assert.strictEqual(isReconcilerRetryable(fresh, NOW, RS), false, 'selector skips fresh reversing');
    const counter = { n: 0 };   // drive the selected one through voidOrRefund (the reconciler's action)
    await voidOrRefund({ db, client: clientVoid({ ok: true }, counter), alert: () => {} }, { orderId: OID, attemptId: 'STALE', pixelpayOrderId: `${OID}-STALE`, paymentUuid: 'S-1', reason: 'retry', now: NOW });
    assert.strictEqual(counter.n, 1); assert.strictEqual((await db.ref('payment_attempts/STALE').once('value')).val().status, 'refunded');
    ok('#19 reconciler selector reaches stale reversing → re-driven → refunded; fresh reversing skipped');
  }

  // #20 [Fix B-r3] stale reversing @ side_effect_started (crashed AFTER PixelPay — void may have landed) →
  // manual_review + alert, NO re-void (attempt-level phase-aware discipline).
  {
    await clearAll(); await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, status: 'reversing', reversing_phase: 'side_effect_started', reversing_at: NOW - 5 * 60 * 1000, payment_uuid: 'S-1' });
    const counter = { n: 0 }; const alerts = [];
    const vr = await voidOrRefund({ db, client: clientVoid({ ok: true }, counter), alert: (k) => alerts.push(k) }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'x', now: NOW });
    assert.strictEqual(counter.n, 0, 'post-side-effect stale reversing → NO blind re-void');
    assert.strictEqual(vr.outcome, 'manual_review'); assert.ok(alerts.includes('reversing_manual_review'), 'manual_review alert fired');
    assert.strictEqual((await db.ref(`payment_attempts/${AID}`).once('value')).val().status, 'manual_review');
    ok('#20 stale reversing @ side_effect_started → manual_review + alert, counter=0 (no re-void)');
  }

  // #21 [Fix B-r3] stale reversing @ claimed (crashed BEFORE PixelPay — void never happened) → safe re-drive.
  {
    await clearAll(); await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, status: 'reversing', reversing_phase: 'claimed', reversing_at: NOW - 5 * 60 * 1000, payment_uuid: 'S-1' });
    const counter = { n: 0 };
    const vr = await voidOrRefund({ db, client: clientVoid({ ok: true }, counter), alert: () => {} }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'S-1', reason: 'x', now: NOW });
    assert.strictEqual(counter.n, 1, 'pre-side-effect stale reversing → safe re-drive'); assert.strictEqual(vr.voided, true);
    assert.strictEqual((await db.ref(`payment_attempts/${AID}`).once('value')).val().status, 'refunded');
    ok('#21 stale reversing @ claimed → re-driven → refunded (counter=1)');
  }

  // #22 [Rewards Phase A] cancel of an order that EARNED (earn↔cancel race: rewards_earned_at already set on a
  // still-cancellable order) → the loyalty earn is clawed back exactly once; a retry does NOT double-debit.
  {
    await clearAll();
    // cancellable cash order (no attempt) that already earned +2 punches (marker + balance pre-seeded)
    await seed({ status: 'out_for_delivery', payment_method: 'cash', payment_status: 'no_payment', active_attempt_id: null,
      order_type: 'delivery', customer_uid: 'uidCX', restaurant_id: 'x_pizza', rewards_earned_at: { at: NOW - 1000, delta: 2 } }, null);
    await db.ref('user_rewards/uidCX/x_pizza').set({ balance: 2, lifetime: 2, ledger: { L0: { type: 'earn', delta: 2, ts: NOW - 1000, config_version: 1 } } });
    const r = await cancelOrderCore(mkDeps({}).deps, { orderId: OID, actor: 'A', reason: 'earn-race', now: NOW, claimId: 'CID-E' });
    assert.strictEqual(r.status, 200, `cancel commits, got ${r.status}`);
    assert.strictEqual((await db.ref('user_rewards/uidCX/x_pizza/balance').once('value')).val(), 0, 'earn clawed back → balance 0');
    assert.strictEqual((await db.ref('user_rewards/uidCX/x_pizza/lifetime').once('value')).val(), 2, 'lifetime UNCHANGED by clawback');
    assert.strictEqual((await db.ref(`orders/${OID}/rewards_reversed_at`).once('value')).val(), NOW, 'reversal marker stamped');
    const ledgerN1 = Object.keys((await db.ref('user_rewards/uidCX/x_pizza/ledger').once('value')).val() || {}).length;
    assert.strictEqual(ledgerN1, 2, 'earn + clawback = 2 ledger entries');
    // retry the whole cancel (idempotent heal path) → NO double-debit
    await cancelOrderCore(mkDeps({}).deps, { orderId: OID, actor: 'A', reason: 'earn-race', now: NOW + 1, claimId: 'CID-E2' });
    assert.strictEqual((await db.ref('user_rewards/uidCX/x_pizza/balance').once('value')).val(), 0, 'retry → still 0 (no double-debit)');
    const ledgerN2 = Object.keys((await db.ref('user_rewards/uidCX/x_pizza/ledger').once('value')).val() || {}).length;
    assert.strictEqual(ledgerN2, 2, 'retry appends no clawback (rewards_reversed_at idempotent)');
    ok('#22 cancel of an earned order → earn clawed back once, lifetime intact, retry no double-debit');
  }

  // #23 [Rewards Phase A] cancel of a NEVER-earned order → reversal is a clean no-op (no reward node touched).
  {
    await clearAll();
    await seed({ status: 'out_for_delivery', payment_method: 'cash', payment_status: 'no_payment', active_attempt_id: null,
      order_type: 'delivery', customer_uid: 'uidCY', restaurant_id: 'x_pizza' }, null);   // no rewards_earned_at
    const r = await cancelOrderCore(mkDeps({}).deps, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID-N' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await db.ref('user_rewards/uidCY').once('value')).val(), null, 'never-earned cancel → no user_rewards node created');
    assert.strictEqual((await db.ref(`orders/${OID}/rewards_reversed_at`).once('value')).val(), null, 'no reversal marker for a never-earned order');
    ok('#23 cancel of a never-earned order → reversal no-op (no reward writes)');
  }

  console.log(`\ncancel-order.emulator: OK (${n} scenarios)`);
  process.exit(0);
})().catch((e) => { console.error('cancel-order.emulator: FAIL\n', e && e.stack || e); process.exit(1); });
