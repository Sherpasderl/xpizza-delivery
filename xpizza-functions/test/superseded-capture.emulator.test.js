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
// The same real writers for many orders (paging / budget / fairness fixtures, codex build r1): create a1, expire it, rotate
// to a2, then a verified paid callback for the superseded a1 at `paidAt` (the webhook acks attempt_superseded).
async function realSuperseded(oid, a1, a2, paidAt) {
  const gen = (ids) => () => ids.shift();
  assert.strictEqual((await acquireHostedAttempt(db, oid, pendingRecord(oid), FP, T0, [], gen([a1]), () => 'P1')).outcome, 'claimed');
  await db.ref(`payment_attempts/${a1}`).update({ hosted_state: 'created', hosted_checkout_url: 'https://pay/1' });
  const later = T0 + HOSTED_TTL_MS + 60 * 1000;
  assert.strictEqual((await acquireHostedAttempt(db, oid, pendingRecord(oid), FP, later, [], gen([a2]), () => 'P2')).outcome, 'claimed');
  const r = await handleHostedCallback(webhookDeps(), paidCb(oid, a1), paidAt);
  assert.strictEqual(r.outcome, 'attempt_superseded', `premise ${oid}: the webhook acks attempt_superseded`);
}
const hex16 = (p, i) => p + i.toString(16).padStart(15, '0');
async function realSupersededMany(prefix, n, paidAtOf) {
  const ids = [];
  for (let i = 0; i < n; i += 25) {
    await Promise.all(Array.from({ length: Math.min(25, n - i) }, (_, j) => {
      const k = i + j, oid = `${prefix}${String(k).padStart(3, '0')}`;
      ids.push({ oid, a1: hex16('a', k), a2: hex16('b', k) });
      return realSuperseded(oid, hex16('a', k), hex16('b', k), paidAtOf(k));
    }));
  }
  return ids.sort((x, y) => (x.oid < y.oid ? -1 : 1));
}
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
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
    // codex build r1 P2-5: the guard's own read FAILS → the owned claim is released, a retryable error, no attempt flags;
    // the next cancel is answered on its merits (manual_review here), never claim_lost
    const failRead = Object.create(db);
    let failed = false;
    failRead.ref = (p) => {
      const ref = db.ref(p);
      if (p === `payment_attempts/${A1}` && !failed) { ref.once = async () => { failed = true; throw new Error('read failed'); }; }
      return ref;
    };
    const r3 = await cancelOrderCore({ ...cdeps, db: failRead }, { orderId: OID, actor: 'D', reason: 'test', now: later2 + 4000, claimId: 'CC3' });
    assert.ok(failed, 'premise: the guard read failed');
    assert.strictEqual(r3.status, 503); assert.strictEqual(r3.body.outcome, 'retryable'); assert.strictEqual(r3.body.retryable, true);
    assert.ok(!(await val(`orders/${OID}`)).cancel_claim_id, 'the claim is released on a guard-read failure');
    const a2f = await val(`payment_attempts/${A2}`);
    assert.ok(!a2f.cancelling && !a2f.cancel_pending, 'no attempt flags');
    const r4 = await cancelOrderCore(cdeps, { orderId: OID, actor: 'D', reason: 'test', now: later2 + 5000, claimId: 'CC4' });
    assert.strictEqual(r4.body.outcome, 'manual_review', `the next cancel is not claim_lost (${r4.body.outcome})`);
    // golden: no evidence, nothing uncertain → today's cancel
    await clearAll();
    await db.ref('orders/PZXH0G').set(pendingRecord('PZXH0G', { payment_method: 'cash', status: 'new', payment_status: 'pending' }));
    const g = await cancelOrderCore({ db, voidOrRefund: async () => ({ voided: true }), alert: async () => {}, serverTimestamp: 1 }, { orderId: 'PZXH0G', actor: 'D', reason: 't', now: T0, claimId: 'G' });
    assert.strictEqual(g.status, 200, `golden cancel ${JSON.stringify(g.body)}`);
    ok('cancel guard: unresolved money on another attempt → 409 manual_review, claim released, NO attempt flags; evidence arriving mid-cancel is caught; a guard-read failure releases the claim with a retryable 503 (the next cancel is not claim_lost); a clean order cancels as today');
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
    const oa = await val(`orders/${OID}`);
    assert.notStrictEqual(oa.payment_status, 'abandoned');
    // codex build r1 P2-6: the still-owned pre-side-effect claim is RELEASED, so "Reembolsar" can claim the order next
    assert.strictEqual(oa.payment_status, 'manual_reconciliation', 'the abandon claim is released');
    assert.ok(!oa.resolving_claim_id && !oa.resolving_action, 'no resolving claim left behind');
    const rf = await resolveManualReconciliationCore(rdeps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: later + 4000, claimId: 'RF1' });
    assert.notStrictEqual(rf.body && rf.body.error, 'Pedido no resolvable (ya en proceso o resuelto)', `"Reembolsar" can claim after the refusal (${JSON.stringify(rf.body)})`);
    ok('abandon refuses when the order carries evidence — at the preliminary check AND at the terminal CAS (mid-flow evidence), and the CAS refusal releases its claim so "Reembolsar" can claim next');
  }

  // ── 8. generation-aware work items + a failing first item with a deliverable one behind it ──
  {
    await clearAll();
    const ref = db.ref('pending_paid_alerts/K');
    await ref.set({ order_id: 'x', attempt_id: 'y', at: 1, gen: 'g2' });
    await H0.deleteItemIfGen(ref, 'g1');
    assert.ok(await val('pending_paid_alerts/K'), 'another generation keeps its item');
    await H0.deleteItemIfGen(ref, 'g2');
    assert.strictEqual(await val('pending_paid_alerts/K'), null, 'the matching generation deletes it');
    // two concurrent writers on the same state converge: one evidence, one alert, no item
    const later = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later + 1000);
    await Promise.all([H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000 }), H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000 })]);
    assert.strictEqual(Object.keys(await alertsOf()).length, 1);
    assert.deepStrictEqual(await itemsOf(), {});
    // failing first item: its alert write fails → rescheduled into the future; the item behind it is delivered in the same run
    await clearAll();
    const OIDb = 'PZXH0B', C3 = 'c3c3c3c3c3c3c3c3', D4 = 'd4d4d4d4d4d4d4d4';
    const later2 = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later2 + 1000);
    await realSuperseded(OIDb, C3, D4, later2 + 1000);
    await db.ref(`pending_paid_alerts/${OID}_${A1}`).set({ order_id: OID, attempt_id: A1, at: 10, gen: 'old' });
    await db.ref(`pending_paid_alerts/${OIDb}_${C3}`).set({ order_id: OIDb, attempt_id: C3, at: 20, gen: 'old' });
    const failing = Object.create(db);
    failing.ref = (p) => {
      const r = db.ref(p);
      if (p === `dispatcher_alerts/paid_superseded_${OID}_${A1}`) r.transaction = async () => { throw new Error('alert write failed'); };
      return r;
    };
    // run only the work-item part: items are due; the paged parts find nothing new (cursor past them)
    await db.ref('ops/superseded_sweep').set({ paid_cursor: { v: later2 + 5000, k: 'zzzz' }, uncertain_cursor: { v: later2 + 5000, k: 'zzzz' } });
    await H0.frequentPass(failing, { now: later2 + 2000, log: silent });
    const items = await itemsOf();
    assert.ok(items[`${OID}_${A1}`] && items[`${OID}_${A1}`].at > later2 + 2000, 'the failing item is rescheduled into the future');
    assert.strictEqual(items[`${OIDb}_${C3}`], undefined, 'the item behind it was delivered and cleared');
    assert.ok((await alertsOf())[`paid_superseded_${OIDb}_${C3}`], 'its alert exists');
    ok('work items: another generation survives an ack; concurrent writers converge to one alert; a failing first item is rescheduled and does not starve the next (real writers)');
  }

  // ── 9. the daily budget against the REMAINING invocation time, checkpointed, carried over to the tail (real writers) ──
  {
    await clearAll();
    const N = 40;
    const later = T0 + HOSTED_TTL_MS + 60000;
    await realSupersededMany('PZXD', N, () => later + 1000);
    // the preceding reconcile work ate 120 s; each clock read costs 10 s → the remaining budget minus the reserve binds
    let runs = 0;
    for (; runs < 10; runs++) {
      const start = T0;
      let t = start + 120000;
      const clock = () => { t += 10000; return t; };
      const r = await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: start, now: later + 2000, clock, log: silent });
      assert.ok(r.visited < r.total, 'budget-bounded run');
      assert.ok(t - start <= 300000 - 20000 + 10000, `never past the remaining budget minus the reserve (${t - start})`);
      const cur = await val('ops/superseded_sweep/daily_cursor');
      assert.ok(cur && cur.k, 'cursor checkpointed');
      if (Object.keys(await alertsOf()).length === N) break;
    }
    assert.strictEqual(Object.keys(await alertsOf()).length, N, `all ${N} candidates alerted across ${runs + 1} budget-bounded runs`);
    ok(`daily pass: with 120 s already spent, each run stops at the remaining budget minus the reserve; the checkpointed cursor carries over and the tail is reached (${runs + 1} runs, real writers)`);

    // codex build r1 P2-4 (a): NO preceding work → the 200 s sweep cap binds (not the ~280 s the invocation would allow)
    await clearAll();
    await realSupersededMany('PZXD', N, () => later + 1000);
    {
      const start = T0; let t = start;
      const clock = () => { t += 10000; return t; };
      const r = await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: start, now: later + 2000, clock, log: silent });
      assert.ok(r.outOfTime, 'stopped by a cap');
      assert.ok(t - start <= H0.SWEEP_CAP_MS + 2 * 10000, `the 200 s sweep cap binds (${t - start} ms)`);
    }
    // (b): the pending-children loop checks the deadline per child — 40 pending evidence children (left pending by the
    // REAL writer whose alert step failed), no candidates, 10 s per clock read
    await clearAll();
    const many = await realSupersededMany('PZXD', N, () => later + 1000);
    for (const { oid, a1 } of many) {
      await H0.recordEvidence(db, { orderId: oid, attemptId: a1, now: later + 2000, hooks: { beforeAlert: async () => { throw new Error('alert step down'); } } }).catch(() => {});
      assert.strictEqual((await val(`orders/${oid}/paid_evidence/${a1}`)).alert_state, 'pending', 'premise: pending evidence');
    }
    {
      const start = T0; let t = start;
      const clock = () => { t += 10000; return t; };
      const r = await H0.dailyPass(db, { orders: await val('orders'), attempts: {}, invocationStartedAt: start, now: later + 3000, clock, log: silent });
      assert.ok(r.outOfTime && r.redelivered < N, `the per-child deadline stops redelivery (${r.redelivered}/${N})`);
      assert.ok(t - start <= H0.SWEEP_CAP_MS + 2 * 10000, `bounded by the cap (${t - start} ms)`);
    }
    ok('daily pass (codex build r1 P2-4): the 200 s sweep cap binds when nothing preceded it, and the pending-children loop checks the deadline per child');
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
    await realSupersededMany('PZXP', 201, (i) => now - 1000 + i);   // real writers; paid_at = the callback time
    await db.ref('ops/superseded_sweep/paid_cursor').set({ v: T0, k: 'aaaa' });   // older than now − 6 h → jumps
    const r1 = await H0.frequentPass(db, { now, log: silent });
    assert.strictEqual(r1.paid, 200, 'page 1: 200');
    assert.strictEqual(Object.keys(await alertsOf()).length, 200);
    const r2 = await H0.frequentPass(db, { now: now + 1, log: silent });
    assert.strictEqual(r2.paid, 1, 'page 2: the 201st');
    assert.strictEqual(Object.keys(await alertsOf()).length, 201, 'row 201 visited on the next run');
    const r3 = await H0.frequentPass(db, { now: now + 2, log: silent });
    assert.strictEqual(r3.paid, 0, 'caught up: stable');
    ok('frequent pass: server-side paging 200 per run with a persisted cursor (row 201 on the next run); a cursor older than 6 h jumps; caught-up runs are stable (real writers)');
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

  // ── 14. codex build r1 P1-1: TRUE overlapping v1/v2 writers — the alert can never disagree with the evidence ──
  {
    const ALK = `paid_superseded_${OID}_${A1}`;
    const setup = async () => {
      await clearAll();
      const later = await rotatedOrder(OID);
      await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later + 1000);   // v1: L299
      return later;
    };
    const finalConsistent = async (label) => {
      const ev = await val(`orders/${OID}/paid_evidence/${A1}`);
      assert.strictEqual(ev.alert_state, 'delivered', `${label}: evidence delivered`);
      assert.strictEqual(ev.amount_cents, 31000, `${label}: evidence is v2`);
      const al = (await alertsOf())[ALK];
      return { ev, al };
    };
    // (a) X writes evidence v1 and pauses BEFORE its alert; Y delivers v2 and deletes its item; X resumes
    {
      const later = await setup();
      const g = gate(); let paused;
      const pausedP = new Promise((r) => { paused = r; });
      const X = H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000, hooks: { beforeAlert: async () => { paused(); await g.wait(); } } });
      await pausedP;
      await db.ref(`payment_attempts/${A1}`).update({ paid_amount_cents: 31000 });   // v2
      const y = await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 3000 });
      assert.strictEqual(y.outcome, 'delivered', 'Y delivers v2');
      g.open();
      const x = await X;
      assert.strictEqual(x.outcome, 'superseded_by_newer', `X sees it lost (${x.outcome})`);
      const { ev, al } = await finalConsistent('(a)');
      assert.ok(al, '(a) the alert is present');
      assert.strictEqual(al.amount_cents, 31000, '(a) the alert shows v2, never the stale v1');
      assert.strictEqual(al.seq, ev.seq, '(a) the alert generation equals the evidence generation');
      assert.deepStrictEqual(await itemsOf(), {}, '(a) no item left');
    }
    // (b) X pauses AFTER writing its v1 alert, before the delivered CAS; Y delivers v2; X resumes
    {
      const later = await setup();
      const g = gate(); let paused;
      const pausedP = new Promise((r) => { paused = r; });
      const X = H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000, hooks: { beforeDelivered: async () => { paused(); await g.wait(); } } });
      await pausedP;
      assert.strictEqual((await alertsOf())[ALK].amount_cents, 29900, 'premise: X\'s v1 alert is up');
      await db.ref(`payment_attempts/${A1}`).update({ paid_amount_cents: 31000 });
      await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 3000 });
      g.open(); await X;
      const { ev, al } = await finalConsistent('(b)');
      assert.ok(al && al.amount_cents === 31000 && al.seq === ev.seq, '(b) X does not withdraw or overwrite the newer alert');
      assert.deepStrictEqual(await itemsOf(), {});
    }
    // (c) as (a), but staff DISMISS the v2 alert before X resumes → X must not resurrect a stale alert
    {
      const later = await setup();
      const g = gate(); let paused;
      const pausedP = new Promise((r) => { paused = r; });
      const X = H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000, hooks: { beforeAlert: async () => { paused(); await g.wait(); } } });
      await pausedP;
      await db.ref(`payment_attempts/${A1}`).update({ paid_amount_cents: 31000 });
      await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 3000 });
      await db.ref(`dispatcher_alerts/${ALK}`).remove();                         // dismissed
      g.open(); await X;
      await finalConsistent('(c)');
      assert.deepStrictEqual(await alertsOf(), {}, '(c) a dismissed newer alert stays dismissed — the stale writer withdraws what it wrote');
    }
    // (d) a STALE not_alertable writer never deletes a newer writer's pending retry item
    {
      const later = await setup();
      await db.ref(`payment_attempts/${A1}`).update({ status: 'refunded' });       // proven reversed → not alertable
      const g = gate(); let paused;
      const pausedP = new Promise((r) => { paused = r; });
      const X = H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000, hooks: { afterClassify: async () => { paused(); await g.wait(); } } });
      await pausedP;
      await db.ref(`payment_attempts/${A1}/status`).remove();                     // alertable again
      const failing = Object.create(db);
      failing.ref = (p) => { const r = db.ref(p); if (p === `dispatcher_alerts/${ALK}`) r.transaction = async () => { throw new Error('down'); }; return r; };
      const y = await H0.recordEvidence(failing, { orderId: OID, attemptId: A1, now: later + 3000 });
      assert.strictEqual(y.outcome, 'alert_failed', 'premise: Y left a rescheduled retry item');
      g.open();
      assert.strictEqual((await X).outcome, 'not_alertable');
      const it = (await itemsOf())[`${OID}_${A1}`];
      assert.ok(it && it.attempts === 1 && it.at > later + 3000, '(d) the newer writer\'s retry item survives the stale cleanup');
    }
    // (e) repair: delivered evidence whose alert shows an OLDER generation is rewritten; a kind change withdraws the
    // other kind's older alert; a dismissed (absent) alert stays dismissed
    {
      const later = await setup();
      await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 2000 });
      const ev = await val(`orders/${OID}/paid_evidence/${A1}`);
      await db.ref(`dispatcher_alerts/${ALK}`).update({ amount_cents: 1, seq: ev.seq - 1, version: 'stale' });   // an older generation's content
      assert.strictEqual((await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 3000 })).outcome, 'already_delivered');
      const al = (await alertsOf())[ALK];
      assert.ok(al.amount_cents === 29900 && al.seq === ev.seq && al.version === ev.version, '(e) repaired from the evidence');
      await db.ref(`payment_attempts/${A1}`).update({ status: 'manual_review' });  // the same attempt becomes an uncertain reversal
      assert.strictEqual((await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 4000 })).outcome, 'delivered');
      const all = await alertsOf();
      assert.ok(all[`reversal_uncertain_${OID}_${A1}`], '(e) the new kind is alerted');
      assert.ok(!all[ALK], '(e) the older paid_superseded alert for the same attempt is withdrawn');
      await db.ref(`dispatcher_alerts/reversal_uncertain_${OID}_${A1}`).remove();
      await H0.recordEvidence(db, { orderId: OID, attemptId: A1, now: later + 5000 });
      assert.deepStrictEqual(await alertsOf(), {}, '(e) a dismissed alert is not resurrected by the repair');
    }
    ok('overlapping writers (codex build r1 P1-1): a stale v1 writer never overwrites, resurrects or deletes a newer v2 generation (pause before the alert, after it, with a dismissal, and a stale not_alertable cleanup); the repair rewrites an older alert and withdraws the other kind');
  }

  // ── 15. codex build r1 P1-2: work item FIRST, then a FRESH re-read — the REAL manual confirm at that boundary ──
  {
    await clearAll();
    const OIDm = 'PZXH0Q';
    const later = await rotatedOrder(OIDm);
    await handleHostedCallback(webhookDeps(), paidCb(OIDm, A1), later + 1000);    // A1 paid, superseded (not yet accounted)
    await db.ref(`orders/${OIDm}`).update({ payment_status: 'resolving_materialize', resolving_action: 'materialize', resolving_claim_id: 'CLM', resolving_phase: 'claimed', resolving_claimed_at: later });
    const deps = { db, restaurant: RESTAURANT, buildMaterializeUpdates, genToken: () => 'TOK', alert: async () => {}, getIdentity: async () => ({ active: true, hours: ALL_OPEN }), sanitizeText: (s) => String(s || ''), serverTimestamp: 1 };
    let itemSeen = false;
    const r = await H0.recordEvidence(db, { orderId: OIDm, attemptId: A1, now: later + 2000, hooks: { afterItem: async () => {
      itemSeen = !!(await val(`pending_paid_alerts/${OIDm}_${A1}`));
      await confirmAndMaterializeFromManualClaim(deps, { orderId: OIDm, attemptId: A1, claimId: 'CLM', now: later + 2100, trackingToken: 'TT' });   // payment_reference = A1
    } } });
    assert.ok(itemSeen, 'the work item exists BEFORE the read');
    assert.strictEqual((await val(`orders/${OIDm}`)).payment_reference, A1, 'premise: the real manual confirm accounted A1 at the boundary');
    assert.strictEqual(r.outcome, 'not_alertable', `the fresh re-read refuses (${r.outcome})`);
    assert.deepStrictEqual(await alertsOf(), {}, 'no false paid_superseded for accounted money');
    assert.strictEqual((await val(`orders/${OIDm}`)).paid_evidence, undefined, 'no evidence');
    assert.deepStrictEqual(await itemsOf(), {}, 'its own item is cleaned up');

    // a read failure AFTER the item write leaves the item for the work-item pass, which then delivers
    await clearAll();
    const later2 = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later2 + 1000);
    const flaky = Object.create(db);
    let failedOnce = false;
    flaky.ref = (p) => { const r0 = db.ref(p); if (p === `orders/${OID}` && !failedOnce) r0.once = async () => { failedOnce = true; throw new Error('read failed'); }; return r0; };
    await assert.rejects(H0.recordEvidence(flaky, { orderId: OID, attemptId: A1, now: later2 + 2000 }));
    assert.ok((await itemsOf())[`${OID}_${A1}`], 'the item survives the read failure');
    await db.ref('ops/superseded_sweep').set({ paid_cursor: { v: later2 + 5000, k: 'zzzz' }, uncertain_cursor: { v: later2 + 5000, k: 'zzzz' } });
    await H0.frequentPass(db, { now: later2 + 3000, log: silent });
    assert.ok((await alertsOf())[`paid_superseded_${OID}_${A1}`], 'the work-item pass delivers it');
    assert.deepStrictEqual(await itemsOf(), {});

    // an item-WRITE failure in the paged pass never advances the cursor past the candidate
    await clearAll();
    const later3 = await rotatedOrder(OID);
    await handleHostedCallback(webhookDeps(), paidCb(OID, A1), later3 + 1000);
    const noItem = Object.create(db);
    noItem.ref = (p) => { const r0 = db.ref(p); if (p === `pending_paid_alerts/${OID}_${A1}`) r0.update = async () => { throw new Error('item write failed'); }; return r0; };
    await H0.frequentPass(noItem, { now: later3 + 2000, log: silent });
    assert.deepStrictEqual(await alertsOf(), {}, 'premise: nothing delivered');
    await H0.frequentPass(db, { now: later3 + 3000, log: silent });
    assert.ok((await alertsOf())[`paid_superseded_${OID}_${A1}`], 'the next run reaches the same candidate (the cursor did not pass it)');
    ok('write-first ordering (codex build r1 P1-2): the item exists before the fresh read; the REAL manual confirm landing at that boundary → no false alert; a read failure leaves the item for retry; an item-write failure never advances the cursor');
  }

  // ── 16. codex build r1 P2-3: no-uuid callback, THEN a uuid callback whose reversal is proven → NO alert ──
  {
    await clearAll();
    const OIDv = 'PZXH0V';
    const later = await rotatedOrder(OIDv);
    await db.ref(`orders/${OIDv}`).update({ status: 'cancelled' });
    const r1 = await handleHostedCallback(webhookDeps(), paidCb(OIDv, A2, { uuid: undefined }), later + 1000);
    assert.strictEqual(r1.outcome, 'cancelled_no_uuid_manual_review');
    const r2 = await handleHostedCallback(webhookDeps(), paidCb(OIDv, A2), later + 2000);   // the uuid arrives; the REAL voidOrRefund succeeds
    assert.strictEqual(r2.outcome, 'cancelled_voided', `premise: proven reversal (${r2.outcome})`);
    const a = await val(`payment_attempts/${A2}`);
    assert.strictEqual(a.status, 'refunded', 'premise: the attempt is refunded');
    assert.ok(a.no_uuid_paid_callback, 'premise: the no-uuid marker survives');
    await H0.frequentPass(db, { now: later + 3000, log: silent });
    await H0.dailyPass(db, { orders: await val('orders'), attempts: await val('payment_attempts'), invocationStartedAt: later + 4000, now: later + 4000, clock: () => later + 4000, log: silent });
    assert.deepStrictEqual(await alertsOf(), {}, 'no "Reembolso sin confirmar" over a proven reversal');
    assert.strictEqual((await val(`orders/${OIDv}`)).paid_evidence, undefined);
    ok('a surviving no-uuid marker does not beat a PROVEN reversal (real webhook no-uuid → uuid + real voidOrRefund → refunded): no alert');
  }

  // ── 17. fairness: 100 failing work items fill a page; item 101 is reached on the next run (real writers) ──
  {
    await clearAll();
    const now = T0 + 7 * 60 * 60 * 1000;
    const many = await realSupersededMany('PZXF', 101, () => now - 5000);
    const failSet = new Set(many.slice(0, 100).map((x) => x.a1));
    const down = { beforeAlert: async ({ attemptId }) => { if (failSet.has(attemptId)) throw new Error('alert path down'); } };
    const all = { beforeAlert: async () => { throw new Error('alert path down'); } };
    // run 1: every candidate fails after writing its item (101 due items); the work-item page (100, oldest first) fails too
    await H0.frequentPass(db, { now, log: silent, hooks: all });
    const items1 = await itemsOf();
    assert.strictEqual(Object.keys(items1).length, 101, 'premise: 101 work items');
    const last = many[100];
    const rescheduled = many.slice(0, 100).filter((x) => items1[`${x.oid}_${x.a1}`].at > now).length;
    assert.strictEqual(rescheduled, 100, 'the page of 100 failing items is rescheduled into the future');
    assert.ok(items1[`${last.oid}_${last.a1}`].at <= now && !(await alertsOf())[`paid_superseded_${last.oid}_${last.a1}`], 'premise: item 101 was not in that page');
    // run 2 (before any backoff elapses): the failing items are not due → item 101 is reached
    await H0.frequentPass(db, { now: now + 1000, log: silent, hooks: down });
    assert.ok((await alertsOf())[`paid_superseded_${last.oid}_${last.a1}`], 'item 101 is reached on the next run');
    ok('fairness: a page full of 100 failing work items is rescheduled into the future and item 101 is delivered on the next run (real writers)');
  }

  console.log(`\nsuperseded-capture emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('superseded-capture emulator FAILED:', e); process.exit(1); });
