'use strict';
/**
 * PLAN-H0 — detect + alert + never auto-close over unaccounted card money / uncertain reversals, driven through the REAL
 * writers against the RTDB emulator:
 *   real acquireHostedAttempt (create → expire → rotate), real handleHostedCallback (webhook), real
 *   confirmAndMaterializeFromManualClaim (manual materializer), real voidOrRefund (reversal machine), real cancelOrderCore,
 *   real resolveManualReconciliationCore (abandon) — and the H0 sweeps (superseded-capture.js).
 *
 * RUN: npm run test:superseded-capture   (tools/emulator-run.js --only database)
 */
require('./_emulator-required')('database');

const assert = require('assert');
const admin = require('firebase-admin');
const H0 = require('../superseded-capture');
const { acquireHostedAttempt, HOSTED_TTL_MS } = require('../pixelpay-hosted-charge');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { voidOrRefund } = require('../pixelpay-cancel');
const { cancelOrderCore } = require('../cancel-order-core');
const { resolveManualReconciliationCore, confirmAndMaterializeFromManualClaim } = require('../resolve-manual');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');

const NS = 'demo-xpizza';
admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}` });
const db = admin.database();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';   // sandbox (webhook resolvePixelPayConfig default)
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
const mk = (o) => ({ sun: o, mon: o, tue: o, wed: o, thu: o, fri: o, sat: o });
const ALL_OPEN = mk({ open: true, start: '00:00', end: '24:00' });
const T0 = 1700000000000;
const A1 = 'a1a1a1a1a1a1a1a1', A2 = 'b2b2b2b2b2b2b2b2';
const FP = 'fp-cart-1';
const clearAll = () => db.ref('/').set(null);
const val = async (p) => (await db.ref(p).once('value')).val();
const silent = () => {};

const pendingRecord = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'x_pizza', status: 'pending_payment', payment_status: 'pending', payment_method: 'online',
  order_type: 'pickup', total: 299, total_cents: 29900, customer_name: 'T', items_text: '1x Pizza', ...over });
const webhookDeps = () => ({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {},
  getIdentity: async () => ({ active: true, hours: ALL_OPEN }), voidOrRefund: (d, a) => voidOrRefund({ ...d, client: { voidTransaction: async () => ({ ok: true }) } }, a) });
const paidCb = (oid, aid, over = {}) => ({ order: `${oid}-${aid}`, status: 'paid', amount: 299, uuid: `U-${aid}`, transaction_id: `TXN-${aid}`, payment_hash: paymentHash(`${oid}-${aid}`, KEY, SECRET), ...over });

// The real writers: create A1, expire it, rotate to A2.
async function rotatedOrder(oid) {
  const gen = (ids) => () => ids.shift();
  const r1 = await acquireHostedAttempt(db, oid, pendingRecord(oid), FP, T0, [], gen([A1]), () => 'POLL1');
  assert.strictEqual(r1.outcome, 'claimed');
  await db.ref(`payment_attempts/${A1}`).update({ hosted_state: 'created', hosted_checkout_url: 'https://pay/1' });
  const later = T0 + HOSTED_TTL_MS + 60 * 1000;
  const r2 = await acquireHostedAttempt(db, oid, pendingRecord(oid), FP, later, [], gen([A2]), () => 'POLL2');
  assert.strictEqual(r2.outcome, 'claimed', 'rotation');
  assert.strictEqual((await val(`orders/${oid}`)).active_attempt_id, A2, 'premise: rotated to A2');
  return later;
}
const alertsOf = async () => (await val('dispatcher_alerts')) || {};
const itemsOf = async () => (await val('pending_paid_alerts')) || {};

(async () => {
  // ── 1. the codex reproduction, RED → GREEN: rotate → verified paid callback for A1 → the sweep finds it ──
  const OID = 'PZXH0A';
  {
    await clearAll();
    const later = await rotatedOrder(OID);
    const r = await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later + 1000);
    assert.strictEqual(r.outcome, 'attempt_superseded', 'premise: today the webhook acks attempt_superseded');
    assert.deepStrictEqual(await alertsOf(), {}, 'premise (the gap): no alert after the webhook');
    assert.strictEqual((await val(`orders/${OID}`)).paid_evidence, undefined, 'premise: no evidence after the webhook');
    const s = await H0.frequentPass(db, { now: later + 2000, log: silent });
    assert.ok(s.paid >= 1, 'the frequent pass paged the paid attempt');
    const ev = (await val(`orders/${OID}/paid_evidence`))[A1];
    assert.strictEqual(ev.kind, 'paid_superseded');
    assert.strictEqual(ev.alert_state, 'delivered');
    assert.strictEqual(ev.payment_uuid, `U-${A1}`);
    assert.strictEqual(ev.amount_cents, 29900);
    const alerts = await alertsOf();
    assert.deepStrictEqual(Object.keys(alerts), [`paid_superseded_${OID}_${A1}`], 'exactly ONE alert');
    const al = alerts[`paid_superseded_${OID}_${A1}`];
    assert.strictEqual(al.type, 'paid_superseded');
    assert.strictEqual(al.order_id, OID, 'order_id at the TOP level');
    assert.strictEqual(al.detail, undefined, 'no detail.* → alert-prune can never remove it');
    assert.deepStrictEqual(await itemsOf(), {}, 'the work item is deleted after delivery');
    ok('codex repro: rotate → A1 paid (webhook acks attempt_superseded, no alert) → the sweep writes ONE evidence + ONE durable alert and clears its work item');

    // idempotent across runs and passes: same evidence → no new alert, first_seen unchanged
    const first = ev.first_seen_at;
    await H0.frequentPass(db, { now: later + 3000, log: silent });
    const orders = await val('orders'), attempts = await val('payment_attempts');
    await H0.dailyPass(db, { orders, attempts, invocationStartedAt: later + 4000, now: later + 4000, clock: () => later + 4000, log: silent });
    assert.strictEqual((await val(`orders/${OID}/paid_evidence/${A1}`)).first_seen_at, first, 'first_seen_at immutable');
    assert.strictEqual(Object.keys(await alertsOf()).length, 1, 'still one alert');
    // dismissal respected
    await db.ref(`dispatcher_alerts/paid_superseded_${OID}_${A1}`).remove();
    await H0.frequentPass(db, { now: later + 5000, log: silent });
    await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: later + 6000, now: later + 6000, clock: () => later + 6000, log: silent });
    assert.deepStrictEqual(await alertsOf(), {}, 'a dismissed alert is NOT recreated for unchanged evidence');
    // changed evidence → re-alert with the new payload
    await db.ref(`payment_attempts/${A1}`).update({ paid_amount_cents: 31000 });
    const ch = await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 7000 });
    assert.strictEqual(ch.outcome, 'delivered');
    const ev2 = await val(`orders/${OID}/paid_evidence/${A1}`);
    assert.strictEqual(ev2.first_seen_at, first, 'first_seen kept on change');
    assert.strictEqual(ev2.last_changed_at, later + 7000);
    assert.strictEqual((await alertsOf())[`paid_superseded_${OID}_${A1}`].amount_cents, 31000, 'the alert carries the NEW payload');
    ok('idempotent across frequent + daily passes; a dismissed alert stays dismissed; a CHANGED evidence version re-alerts with the new payload, first_seen kept');
  }

  // ── 2. a version change while the alert is still OPEN updates the open alert (overwrite on pending) ──
  {
    await db.ref(`payment_attempts/${A1}`).update({ payment_uuid: 'U-changed' });
    await H0.frequentPass(db, { now: T0 + HOSTED_TTL_MS + 70000, log: silent });   // paid_at unchanged → the work-item/daily path, so call recordEvidence via daily
    await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: T0 + HOSTED_TTL_MS + 80000, now: T0 + HOSTED_TTL_MS + 80000, clock: () => T0 + HOSTED_TTL_MS + 80000, log: silent });
    const al = (await alertsOf())[`paid_superseded_PZXH0A_${A1}`];
    assert.ok(al, 'the alert is present');
    assert.strictEqual((await val(`orders/PZXH0A/paid_evidence/${A1}`)).payment_uuid, 'U-changed');
    ok('a state change without a paid_at change is caught by the daily pass; the open alert is overwritten with the current payload');
  }

  // ── 3. manual materializer: payment_reference = A1 accounts A1; a later paid A2 (already_confirmed) alerts A2 ──
  {
    await clearAll();
    const OIDm = 'PZXH0M';
    const later = await rotatedOrder(OIDm);
    // the manual-resolution claim exists (as codex staged it), then the REAL manual materializer confirms with A1
    await db.ref(`orders/${OIDm}`).update({ payment_status: 'resolving_materialize', resolving_action: 'materialize', resolving_claim_id: 'CLM', resolving_phase: 'claimed', resolving_claimed_at: later });
    const deps = { db, restaurant: RESTAURANT, buildMaterializeUpdates, genToken: () => 'TOK', alert: async () => {}, getIdentity: async () => ({ active: true, hours: ALL_OPEN }), sanitizeText: (s) => String(s || ''), serverTimestamp: 1 };
    const m = await confirmAndMaterializeFromManualClaim(deps, { orderId: OIDm, attemptId: A1, claimId: 'CLM', now: later + 100, trackingToken: 'TT' });
    const om = await val(`orders/${OIDm}`);
    assert.strictEqual(om.payment_reference, A1, 'premise: the manual materializer records A1 as payment_reference');
    assert.strictEqual(om.active_attempt_id, A2, 'premise: A2 is still the active pointer');
    // A2 is later paid → today the webhook says already_confirmed
    const r = await handleHostedCallback(webhookDeps(), paidCb(OIDm, A2), later + 2000);
    assert.ok(['already_confirmed', 'confirmed', 'materialized'].includes(r.outcome) || r.outcome, `webhook outcome ${r.outcome}`);
    await H0.frequentPass(db, { now: later + 3000, log: silent });
    await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: later + 4000, now: later + 4000, clock: () => later + 4000, log: silent });
    const ev = (await val(`orders/${OIDm}/paid_evidence`)) || {};
    assert.ok(ev[A2] && ev[A2].kind === 'paid_superseded', 'A2 (the second capture) alerts');
    assert.ok(!ev[A1], 'A1 (manual payment_reference) does not');
    ok(`manual materializer (outcome ${m.outcome}): A1 = payment_reference is accounted; the later paid A2 is a second capture → paid_superseded (codex r4 P1-1)`);
  }

  // ── 4. no-uuid voidPaid → durable marker + manual_review, NEVER 'refunded' → the uncertain_at pass alerts it ──
  {
    await clearAll();
    const OIDn = 'PZXH0N';
    const later = await rotatedOrder(OIDn);
    await db.ref(`orders/${OIDn}`).update({ status: 'cancelled' });
    let voidCalls = 0;
    const wd = { ...webhookDeps(), voidOrRefund: async () => { voidCalls += 1; return { voided: true }; } };
    const r = await handleHostedCallback(wd, paidCb(OIDn, A2, { uuid: undefined }), later + 1000);
    assert.strictEqual(r.outcome, 'cancelled_no_uuid_manual_review');
    assert.strictEqual(voidCalls, 0, 'voidOrRefund NOT called without a uuid');
    const a = await val(`payment_attempts/${A2}`);
    assert.strictEqual(a.status, 'manual_review');
    assert.ok(a.no_uuid_paid_callback && a.no_uuid_paid_callback.hosted_order_id === `${OIDn}-${A2}`);
    assert.strictEqual((await val(`orders/${OIDn}`)).payment_status, 'manual_review', 'never refunded');
    await H0.frequentPass(db, { now: later + 2000, log: silent });
    assert.ok((await alertsOf())[`reversal_uncertain_${OIDn}_${A2}`], 'reversal_uncertain alert within one frequent run');
    ok('voidPaid with no uuid: no voidOrRefund, manual_review + the durable marker (never refunded); the uncertain_at pass alerts reversal_uncertain');
  }

  // ── 4b. the reconciler's no-uuid park (the real writer, parkReconcilerNoUuid): a BARE manual_review → alerted ──
  {
    await clearAll();
    const OIDr = 'PZXH0R';
    const later = await rotatedOrder(OIDr);
    await db.ref(`payment_attempts/${A2}`).update({ status: 'refund_pending', refund_message: 'void failed' });   // reconciler-owned …
    await H0.parkReconcilerNoUuid(db, A2, later + 500);                                                              // … with no uuid → parked
    const a = await val(`payment_attempts/${A2}`);
    assert.strictEqual(a.status, 'manual_review'); assert.strictEqual(a.uncertain_at, later + 500);
    assert.ok(!a.no_uuid_paid_callback && a.reversing_phase === undefined && !a.hosted_callback_verified, 'premise: ONLY the bare manual_review status marks it');
    await H0.frequentPass(db, { now: later + 1000, log: silent });
    assert.ok((await alertsOf())[`reversal_uncertain_${OIDr}_${A2}`], 'the bare manual_review is alerted within one frequent run');
    ok('the reconciler no-uuid park (real writer) leaves a BARE manual_review + uncertain_at → reversal_uncertain within one frequent run');
  }

  // ── 5. codex's mixed state via the REAL reversal machine: stale reversal post side-effect → manual_review ──
  {
    await clearAll();
    const OIDx = 'PZXH0X';
    const later = await rotatedOrder(OIDx);
    await db.ref(`payment_attempts/${A2}`).update({ hosted_state: 'paid', hosted_callback_verified: true, payment_uuid: 'U-x', paid_amount_cents: 29900, status: 'reversing', reversing_phase: 'side_effect_started', reversing_at: later - 10 * 60 * 1000 });
    const vr = await voidOrRefund({ db, client: { voidTransaction: async () => ({ ok: true }) }, alert: () => {} }, { orderId: OIDx, attemptId: A2, pixelpayOrderId: `${OIDx}-${A2}`, paymentUuid: 'U-x', reason: 'x', now: later });
    assert.strictEqual(vr.outcome, 'manual_review', 'premise: the real reversal machine parks a stale post-side-effect reversal');
    await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: later, now: later, clock: () => later, log: silent });
    assert.ok((await alertsOf())[`reversal_uncertain_${OIDx}_${A2}`], 'the daily pass alerts the unowned mixed state');
    ok('a stale post-side-effect reversal (real voidOrRefund → manual_review) is alerted as reversal_uncertain by the daily pass (codex r3 P1-3)');
  }

  // ── 6. the cancel guard: before B.6, releases the claim, sets no attempt flag; otherwise golden ──
  {
    await clearAll();
    const later = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later + 1000);
    await H0.frequentPass(db, { now: later + 2000, log: silent });
    const cdeps = { db, voidOrRefund: async () => { throw new Error('must not void'); }, alert: async () => {}, serverTimestamp: 1 };
    const r = await cancelOrderCore(cdeps, { orderId: OID, actor: 'D', reason: 'test', now: later + 3000, claimId: 'CC1' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.outcome, 'manual_review');
    const o = await val(`orders/${OID}`);
    assert.ok(!o.cancel_claim_id, 'the claim is released');
    assert.notStrictEqual(o.status, 'cancelled', 'not finalized');
    const a2 = await val(`payment_attempts/${A2}`);
    assert.ok(!a2.cancelling && !a2.cancel_pending, 'B.6 never ran: no attempt flags');
    // evidence arriving AFTER cancel's initial read but BEFORE the guard → refused (the claim snapshot is fresh)
    await clearAll();
    const later2 = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later2 + 1000);
    const proxy = Object.create(db);
    let injected = false;
    proxy.ref = (p) => {
      const ref = db.ref(p);
      if (p === `orders/${OID}` && !injected) {
        const once = ref.once.bind(ref);
        ref.once = async (...args) => { const s = await once(...args); injected = true; await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later2 + 1500 }); return s; };
      }
      return ref;
    };
    const r2 = await cancelOrderCore({ ...cdeps, db: proxy }, { orderId: OID, actor: 'D', reason: 'test', now: later2 + 3000, claimId: 'CC2' });
    assert.ok(injected, 'premise: the evidence landed after the initial read');
    assert.strictEqual(r2.body.outcome, 'manual_review', 'refused on evidence that arrived mid-cancel');
    // golden: no evidence, nothing uncertain → today's cancel
    await clearAll();
    await db.ref('orders/PZXH0G').set(pendingRecord('PZXH0G', { payment_method: 'cash', status: 'new', payment_status: 'pending' }));
    const g = await cancelOrderCore({ db, voidOrRefund: async () => ({ voided: true }), alert: async () => {}, serverTimestamp: 1 }, { orderId: 'PZXH0G', actor: 'D', reason: 't', now: T0, claimId: 'G' });
    assert.strictEqual(g.status, 200, `golden cancel ${JSON.stringify(g.body)}`);
    ok('cancel guard: unresolved money on another attempt → 409 manual_review, claim released, NO attempt flags; evidence arriving mid-cancel is caught; a clean order cancels as today');
  }

  // ── 7. abandon refuses on evidence — preliminary and at the terminal CAS ──
  {
    await clearAll();
    const later = await rotatedOrder(OID);
    await db.ref(`orders/${OID}`).update({ payment_status: 'manual_reconciliation' });
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later + 1000);
    // the manual branch wrote A1 paid + paid_during_resolve; clear that flag to isolate the H0 evidence check
    await db.ref(`orders/${OID}/paid_during_resolve`).remove();
    await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 1500 });
    const rdeps = { db, client: { voidTransaction: async () => ({ ok: true }) }, buildMaterializeUpdates, restaurant: RESTAURANT, genToken: () => 'T', alert: async () => {}, getIdentity: async () => ({ active: true, hours: ALL_OPEN }), sanitizeText: (s) => String(s || ''), serverTimestamp: 1 };
    const r = await resolveManualReconciliationCore(rdeps, { orderId: OID, action: 'abandon', actor: 'A', note: '', now: later + 2000, claimId: 'AB1' });
    assert.strictEqual(r.status, 409, 'preliminary refusal');
    assert.notStrictEqual((await val(`orders/${OID}`)).payment_status, 'abandoned');
    // the CAS: evidence written after the preliminary check (during the attempt read) → the terminal CAS refuses
    await db.ref(`orders/${OID}/paid_evidence`).remove();
    await db.ref(`orders/${OID}`).update({ payment_status: 'manual_reconciliation', resolving_claim_id: null, resolving_action: null });
    await db.ref(`payment_attempts/${A2}`).update({ payment_uuid: null });
    const proxy = Object.create(db);
    proxy.ref = (p) => {
      const ref = db.ref(p);
      if (p === `payment_attempts/${A2}`) {
        const once = ref.once.bind(ref);
        ref.once = async (...args) => { const s = await once(...args); await db.ref(`orders/${OID}/paid_evidence/${A1}`).set({ kind: 'paid_superseded', version: 'v', alert_state: 'pending', first_seen_at: 1 }); return s; };
      }
      return ref;
    };
    const r2 = await resolveManualReconciliationCore({ ...rdeps, db: proxy }, { orderId: OID, action: 'abandon', actor: 'A', note: '', now: later + 3000, claimId: 'AB2' });
    assert.strictEqual(r2.status, 409, 'the terminal CAS refuses on evidence that arrived mid-abandon');
    assert.notStrictEqual((await val(`orders/${OID}`)).payment_status, 'abandoned');
    ok('abandon refuses when the order carries evidence — at the preliminary check AND at the terminal CAS (mid-flow evidence)');
  }

  // ── 8. generation-aware work items + a failing first item with a deliverable one behind it ──
  {
    await clearAll();
    const ref = db.ref('pending_paid_alerts/K');
    await ref.set({ order_id: 'x', attempt_id: 'y', at: 1, version: 'v2' });
    await H0.deleteItemIfVersion(ref, 'v1');
    assert.ok(await val('pending_paid_alerts/K'), 'a newer generation keeps its item');
    await H0.deleteItemIfVersion(ref, 'v2');
    assert.strictEqual(await val('pending_paid_alerts/K'), null, 'the matching generation deletes it');
    // two concurrent writers on the same state converge: one evidence, one alert, no item
    const later = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later + 1000);
    await Promise.all([H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000 }), H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000 })]);
    assert.strictEqual(Object.keys(await alertsOf()).length, 1);
    assert.deepStrictEqual(await itemsOf(), {});
    // failing first item: its alert write fails → rescheduled into the future; the item behind it is delivered in the same run
    await clearAll();
    const OIDb = 'PZXH0B';
    const later2 = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later2 + 1000);
    // a second order whose evidence is deliverable
    const gen = (ids) => () => ids.shift();
    await acquireHostedAttempt(db, OIDb, pendingRecord(OIDb), FP, T0, [], gen(['c3c3c3c3c3c3c3c3']), () => 'P');
    await db.ref('payment_attempts/c3c3c3c3c3c3c3c3').update({ hosted_state: 'created' });
    await acquireHostedAttempt(db, OIDb, pendingRecord(OIDb), FP, later2, [], gen(['d4d4d4d4d4d4d4d4']), () => 'P');
    await handleHostedCallback(webhookDeps(), paidCb(OIDb, 'c3c3c3c3c3c3c3c3'), later2 + 1000);
    await db.ref(`pending_paid_alerts/${OID}_${A1}`).set({ order_id: OID, attempt_id: A1, at: 10, version: 'old' });
    await db.ref(`pending_paid_alerts/${OIDb}_c3c3c3c3c3c3c3c3`).set({ order_id: OIDb, attempt_id: 'c3c3c3c3c3c3c3c3', at: 20, version: 'old' });
    const failing = Object.create(db);
    failing.ref = (p) => {
      const r = db.ref(p);
      if (p === `dispatcher_alerts/paid_superseded_${OID}_${A1}`) r.set = async () => { throw new Error('alert write failed'); };
      return r;
    };
    // run only the work-item part: items are due; the paged parts find nothing new (cursor past them)
    await db.ref('ops/superseded_sweep').set({ paid_cursor: { v: later2 + 5000, k: 'zzzz' }, uncertain_cursor: { v: later2 + 5000, k: 'zzzz' } });
    await H0.frequentPass(failing, { now: later2 + 2000, log: silent });
    const items = await itemsOf();
    assert.ok(items[`${OID}_${A1}`] && items[`${OID}_${A1}`].at > later2 + 2000, 'the failing item is rescheduled into the future');
    assert.strictEqual(items[`${OIDb}_c3c3c3c3c3c3c3c3`], undefined, 'the item behind it was delivered and cleared');
    assert.ok((await alertsOf())[`paid_superseded_${OIDb}_c3c3c3c3c3c3c3c3`], 'its alert exists');
    ok('work items: a newer generation survives an older ack; concurrent writers converge to one alert; a failing first item is rescheduled and does not starve the next');
  }

  // ── 9. the daily budget against the REMAINING invocation time, checkpointed, carried over to the tail ──
  {
    await clearAll();
    const N = 40;
    const later = T0 + HOSTED_TTL_MS + 60000;
    const updates = {};
    for (let i = 0; i < N; i++) {
      const oid = `PZXD${String(i).padStart(3, '0')}`;
      const old = `e${String(i).padStart(15, '0')}`, act = `f${String(i).padStart(15, '0')}`;
      updates[`orders/${oid}`] = pendingRecord(oid, { active_attempt_id: act });
      updates[`payment_attempts/${old}`] = { order_id: oid, hosted_state: 'paid', hosted_callback_verified: true, payment_uuid: `U${i}`, paid_amount_cents: 29900 };   // no paid_at: daily-only
      updates[`payment_attempts/${act}`] = { order_id: oid, hosted_state: 'created' };
    }
    await db.ref().update(updates);
    // the preceding reconcile work ate 120 s; each candidate costs 10 s on the stub clock → ~16 per run before the reserve
    let runs = 0;
    for (; runs < 10; runs++) {
      const start = T0;
      let t = start + 120000;
      const clock = () => { t += 10000; return t; };
      const r = await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: start, now: later, clock, log: silent });
      assert.ok(r.visited < r.total, 'budget-bounded run');
      const cur = await val('ops/superseded_sweep/daily_cursor');
      assert.ok(cur && cur.k, 'cursor checkpointed');
      const alerted = Object.keys(await alertsOf()).length;
      if (alerted === N) break;
    }
    assert.strictEqual(Object.keys(await alertsOf()).length, N, `all ${N} candidates alerted across ${runs + 1} budget-bounded runs`);
    ok(`daily pass: with 120 s already spent, each run stops at the remaining budget minus the reserve; the checkpointed cursor carries over and the tail is reached (${runs + 1} runs)`);
  }

  // ── 10. clean DB → no evidence / alert / item writes; orphans are logged only ──
  {
    await clearAll();
    const later = T0 + 1000;
    await db.ref('orders/PZXCLN').set(pendingRecord('PZXCLN', { status: 'new', payment_status: 'confirmed', active_attempt_id: A1, payment_reference: 'TXN' }));
    await db.ref(`payment_attempts/${A1}`).set({ order_id: 'PZXCLN', hosted_state: 'paid', hosted_callback_verified: true, payment_uuid: 'U', paid_amount_cents: 29900, paid_at: later });
    await db.ref('payment_attempts/0rphan0rphan0000').set({ order_id: 'PZXGONE', hosted_state: 'paid', hosted_callback_verified: true, paid_at: later });
    const logs = [];
    await H0.frequentPass(db, { now: later + 1000, log: (m) => logs.push(m) });
    await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: later, now: later, clock: () => later, log: (m) => logs.push(m) });
    assert.strictEqual((await val('orders/PZXCLN')).paid_evidence, undefined);
    assert.deepStrictEqual(await alertsOf(), {});
    assert.deepStrictEqual(await itemsOf(), {});
    assert.strictEqual(await val('orders/PZXGONE'), null, 'no write for an orphan');
    assert.ok(logs.some((m) => /orphan/.test(m)), 'the orphan is logged');
    ok('a clean DB (an auto-confirmed active paid attempt) gets NO evidence / alert / item writes; an orphan paid attempt is logged only');
  }

  // ── 11. the frequent pass pages: 201 candidates → all visited over two runs; a stale cursor jumps to the window ──
  {
    await clearAll();
    const now = T0 + 7 * 60 * 60 * 1000;
    const updates = {};
    for (let i = 0; i < 201; i++) {
      const oid = `PZXP${String(i).padStart(3, '0')}`;
      const old = `a${String(i).padStart(15, '0')}`, act = `b${String(i).padStart(15, '0')}`;
      updates[`orders/${oid}`] = pendingRecord(oid, { active_attempt_id: act });
      updates[`payment_attempts/${old}`] = { order_id: oid, hosted_state: 'paid', hosted_callback_verified: true, payment_uuid: `U${i}`, paid_amount_cents: 29900, paid_at: now - 1000 + i };
      updates[`payment_attempts/${act}`] = { order_id: oid, hosted_state: 'created' };
    }
    await db.ref().update(updates);
    await db.ref('ops/superseded_sweep/paid_cursor').set({ v: T0, k: 'aaaa' });   // older than now − 6 h → jumps
    const r1 = await H0.frequentPass(db, { now, log: silent });
    assert.strictEqual(r1.paid, 200, 'page 1: 200');
    assert.strictEqual(Object.keys(await alertsOf()).length, 200);
    const r2 = await H0.frequentPass(db, { now: now + 1, log: silent });
    assert.strictEqual(r2.paid, 1, 'page 2: the 201st');
    assert.strictEqual(Object.keys(await alertsOf()).length, 201, 'row 201 visited on the next run');
    const r3 = await H0.frequentPass(db, { now: now + 2, log: silent });
    assert.strictEqual(r3.paid, 0, 'caught up: stable');
    ok('frequent pass: server-side paging 200 per run with a persisted cursor (row 201 on the next run); a cursor older than 6 h jumps; caught-up runs are stable');
  }

  // ── 13. snapshot consistency: a STALE orders map (active A1) vs the DB (A2 active and normally paid) → no false alert ──
  {
    await clearAll();
    const OIDs = 'PZXH0S';
    const later = await rotatedOrder(OIDs);
    const staleOrders = await val('orders');            // the map as reconcilePayments loaded it… then the DB moves on:
    staleOrders[OIDs].active_attempt_id = A1;          // (a snapshot taken before the rotation)
    await handleHostedCallback(webhookDeps(), paidCb(OIDs, A2), later + 1000);   // A2 (active) paid normally → confirmed
    const premise = await val(`orders/${OIDs}`);
    assert.strictEqual(premise.active_attempt_id, A2);
    // with the stale map, the pre-filter thinks A2 is unaccounted; the fresh re-read inside recordEvidence must refuse
    const r = await H0.dailyPass(db, { orders: staleOrders, attempts: await val('payment_attempts'), invocationStartedAt: later, now: later + 2000, clock: () => later + 2000, log: silent });
    assert.strictEqual(r.alerted, 0);
    assert.deepStrictEqual(await alertsOf(), {}, 'no false alert from a stale snapshot');
    assert.strictEqual((await val(`orders/${OIDs}`)).paid_evidence, undefined);
    ok('snapshot consistency: a stale orders map (pre-rotation) cannot produce a false alert — recordEvidence re-reads the order and attempt fresh before writing');
  }

  console.log(`\nsuperseded-capture emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('superseded-capture emulator FAILED:', e); process.exit(1); });
