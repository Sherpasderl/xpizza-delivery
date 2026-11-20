'use strict';
// «Marcar como revisado» — owner 11-19, option B, rebuilt STRUCTURALLY (owner GO 11-19 on D4c-grill/NOTE-5f-review-attest-structural.md after
// Codex #219): a recorded HUMAN ATTESTATION ONLY, and NOTHING about it lives on the order node.
//   · manual_review_episodes/{orderId}            the CURRENT episode (the trigger stamps every ENTRY into manual_review); dispatchers may read it
//   · manual_review_closures/{orderId}/{episode}  ONE create-if-absent, append-only record { outcome, amount_cents, note, by, at } — the audit itself
// The request carries the episode the person read; anything not current ⇒ 409 stale. «Closed» = the CURRENT episode has a closure
// (isClosed — re-checked per order at the moment reconcilePayments' daily reminder decides). Owner GO 11-19 (after Codex #222): a closure
// NEVER touches any alert — it only skips the daily aged reminder for its CURRENT episode. No money, attempt, reward or order change.
//   RA-TRIGGER     (every park) the episode trigger's body stamps the entry into manual_review in manual_review_episodes
//   RA-CLOSE       a REAL cancel park + the episode trigger ⇒ attest ⇒ 200; the ONLY write is the closure node (whole-db diff) — the order is untouched
//   RA-GATE        afterwards the REAL cancel still refuses (manual_review), no claim, no void
//   RA-REFUSE      not manual_review / scheduled_blocked / an order claim / already closed / a stale episode ⇒ 409, nothing written
//   RA-INFLIGHT    a REAL voidOrRefund in flight (reversing) or refund_pending ⇒ 409, nothing written
//   RA-RACE        a second attestation of the same episode lands first ⇒ ours already_closed; exactly one record
//   RA-BAD         a bad outcome / amount / episode / order id / note ⇒ 400, nothing written
//   RA-AUTH        auth first; a dispatcher identity only (the service secret ⇒ 403); raw note + amount bounds; the verified actor
//   RA-EPISODE     (#217 P1) close; a REAL verify-failing callback → the REAL resolver's no-uuid refund → manual_review again; the trigger stamps
//                  a NEW episode ⇒ the old closure no longer counts (closedOrderIds), the old episode is stale, the new one closes
//   RA-STALE-FLIGHT (#219 P1) the episode moves on WHILE the request is in flight (between its check and its write) ⇒ 409 stale_after_write;
//                  the record stays with the episode the person reviewed and never counts for the new one
//   RA-MALFORMED   (#219 P2-a) review fields a client wrote on the ORDER (e.g. manual_review_closed: true) mean nothing — closedness is read only
//                  from the server-only roots
//   RA-APPEND      (#219 P2-b) a closure is never replaced: a second close of the same episode is refused; a new episode gets its own node
//   RA-CASH        (#219 P2-c) a cash-labelled parked order: the ONE closure write is the whole audit (no pending state, no backstop to miss it)
//   RA-NEVER-HIDE  (owner bar 1+2) a closure never deletes or suppresses an alert: the REAL prune over a fixture world is byte-identical
//                  closed vs not closed; a NEW episode's own outcome alerts (the REAL callback's / resolver's) are raised and kept
//   RA-DAILY       (owner bar 3) the closure only skips the daily reminder for its CURRENT episode; the worst race = one day late — the next
//                  day's decision raises it
//   RA-CASH-DAILY  (owner bar 4) closedness is the same for a cash-labelled review (no payment_method in the decision)
// Run: node payments/review-attest.test.js
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const RA = require('./review-attest');
const { cancelOrderCore } = require('../cancel-order-core');
const { voidOrRefund } = require('../pixelpay-cancel');
const realClient = require('../pixelpay-client');
const { paymentAlert } = require('../lib/payment-alert');
const { unresolvedMoney, alertsToPrune } = require('../alert-prune');   // UNCHANGED from the cancel-park base (review-attest-wiring RAW-PRUNE-BASE)
const { resolveManualReconciliationCore } = require('../resolve-manual');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { buildMaterializeUpdates } = require('../materialize');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const OID = 'RVA1', AID = 'c0ffee00c0ffee55', NOW = 1_800_000_000_000, EP1 = NOW + 1;
const quiet = async (f) => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await f(); } finally { console.warn = w; console.error = e; console.log = l; } };
let provider = 'decline'; let hold = null;
globalThis.fetch = async (url) => {
  if (!String(url).endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${url}`);
  if (hold) await hold;
  return new Response(JSON.stringify(provider === 'ok' ? { success: true, message: 'ok' } : { success: false, message: 'no' }), { status: 200 });
};
const ORDER = (o = {}) => ({ order_id: OID, order_type: 'pickup', status: 'new', payment_status: 'confirmed', payment_method: 'online', total: 299, total_cents: 29900,
  customer_name: 'T', items_text: 'x', restaurant_id: 'x_pizza', active_attempt_id: AID, created_at: NOW - 3600000, ...o });
const CAPTURED_NO_UUID = { order_id: OID, hosted_state: 'paid', hosted_callback_verified: true, hosted_order_id: `${OID}-${AID}` };
const AMBIGUOUS = { order_id: OID, hosted_state: 'created', payment_uuid: 'U-1', hosted_order_id: `${OID}-${AID}` };
// the episode trigger exactly as deployed (markReviewEpisodeOnPaymentStatus): each payment_status write runs RA.onPaymentStatus
const trig = (db, before, after, t) => RA.onPaymentStatus(db, { orderId: OID, before, after, eventTime: t });
// a REAL park (cancelOrderCore refuses ⇒ manual_review) + the trigger's stamp of that entry
const parked = async (att = CAPTURED_NO_UUID, ord = {}, hooks) => {
  const db = makeDb({ orders: { [OID]: ORDER(ord) }, payment_attempts: { [AID]: att } }, hooks);
  const before = ord.payment_status || 'confirmed';
  await quiet(() => cancelOrderCore({ db, voidOrRefund: async () => { throw new Error('must not void'); }, alert: (k, d) => paymentAlert(db, k, d), serverTimestamp: 0 },
    { orderId: OID, actor: 'disp@tb', reason: 'customer', now: NOW, claimId: 'CL1' }));
  assert.strictEqual(db.getAt(`orders/${OID}/payment_status`), 'manual_review', 'premise: the real cancel parked the order');
  await trig(db, before, 'manual_review', EP1);
  assert.strictEqual(db.getAt(`manual_review_episodes/${OID}`), EP1, '🔴 RA-TRIGGER: the episode trigger stamps the entry into manual_review');
  return db;
};
const attest = (db, over = {}) => RA.attestManualReview(db, { orderId: OID, episode: EP1, outcome: 'refunded_in_pixelpay', amountCents: 29900, note: 'anulado en PixelPay', actor: 'disp@tb', now: NOW + 5, ...over });
const closed = (db) => RA.isClosed(db, OID);
const flat = (v, p = '', out = {}) => { if (v && typeof v === 'object') { for (const k of Object.keys(v)) flat(v[k], p ? `${p}/${k}` : k, out); } else out[p] = v; return out; };
const diff = (a, b) => { const A = flat(a), B = flat(b); return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => A[k] !== B[k]).sort(); };
const snapshot = (db) => JSON.parse(JSON.stringify(db.root));

(async () => {
  {
    const db = await parked();
    const before = snapshot(db);
    assert.strictEqual(await closed(db), false, 'RA-CLOSE premise: open');
    const r = await attest(db);
    assert.deepStrictEqual([r.status, r.body.outcome], [200, 'review_closed'], `🔴 RA-CLOSE: 200 review_closed (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual(db.getAt(`manual_review_closures/${OID}/${EP1}`), { outcome: 'refunded_in_pixelpay', amount_cents: 29900, note: 'anulado en PixelPay', by: 'disp@tb', at: NOW + 5 }, '🔴 RA-CLOSE: the closure node IS the audit');
    assert.deepStrictEqual(diff(before, snapshot(db)), [`manual_review_closures/${OID}/${EP1}/amount_cents`, `manual_review_closures/${OID}/${EP1}/at`, `manual_review_closures/${OID}/${EP1}/by`, `manual_review_closures/${OID}/${EP1}/note`, `manual_review_closures/${OID}/${EP1}/outcome`],
      '🔴 RA-CLOSE: the ONLY write is the closure node — the order, the attempt, rewards and payment_audit are untouched');
    assert.strictEqual(await closed(db), true, '🔴 RA-CLOSE: closed for its current episode');
    ok('RA-CLOSE: a real park + the trigger ⇒ attested; the only write is the closure node; the order is untouched');
    let voids = 0;
    const r2 = await quiet(() => cancelOrderCore({ db, voidOrRefund: async () => { voids += 1; return { voided: true }; }, alert: (k, d) => paymentAlert(db, k, d), serverTimestamp: 0 }, { orderId: OID, actor: 'disp@tb', reason: 'customer', now: NOW + 9, claimId: 'CL2' }));
    assert.deepStrictEqual([r2.status, r2.body.outcome, voids, db.getAt(`orders/${OID}/cancel_claim_id`) || null], [409, 'manual_review', 0, null], '🔴 RA-GATE: the real cancel still refuses; no claim, no void');
    ok('RA-GATE: after closing, the real cancel still refuses (no claim, no void)');
    const b2 = snapshot(db);
    const r3 = await attest(db, { outcome: 'charge_stands', now: NOW + 6 });
    assert.deepStrictEqual([r3.status, r3.body.outcome, diff(b2, snapshot(db))], [409, 'already_closed', []], '🔴 RA-REFUSE: already closed ⇒ 409, the first record stands');
    const r4 = await attest(db, { episode: EP1 - 1, now: NOW + 7 });
    assert.deepStrictEqual([r4.status, r4.body.outcome, diff(b2, snapshot(db))], [409, 'stale', []], '🔴 RA-REFUSE: an episode that is not current ⇒ 409 stale, nothing written');
  }
  {
    const cases = [
      ['not_in_review', makeDb({ orders: { [OID]: ORDER() }, payment_attempts: { [AID]: CAPTURED_NO_UUID }, manual_review_episodes: { [OID]: EP1 } })],
      ['scheduled_blocked', makeDb({ orders: { [OID]: ORDER({ status: 'scheduled', payment_status: 'manual_review', scheduled_blocked: true, blocked_reason: 'confirm_slot_closed' }) }, payment_attempts: { [AID]: CAPTURED_NO_UUID }, manual_review_episodes: { [OID]: EP1 } })],
      ['claim_in_flight', makeDb({ orders: { [OID]: ORDER({ payment_status: 'manual_review', cancel_claim_id: 'CLX', resolving_action: 'cancel' }) }, payment_attempts: { [AID]: CAPTURED_NO_UUID }, manual_review_episodes: { [OID]: EP1 } })],
      ['claim_in_flight', makeDb({ orders: { [OID]: ORDER({ payment_status: 'manual_review', resolving_claim_id: 'RCL', resolving_phase: 'claimed' }) }, payment_attempts: { [AID]: CAPTURED_NO_UUID }, manual_review_episodes: { [OID]: EP1 } })],
    ];
    for (const [why, db] of cases) {
      const before = snapshot(db);
      const r = await attest(db);
      assert.deepStrictEqual([r.status, r.body.outcome, diff(before, snapshot(db))], [409, why, []], `🔴 RA-REFUSE: ${why} ⇒ 409, nothing written (${JSON.stringify(r.body)})`);
    }
    ok('RA-REFUSE: already closed / stale episode / not manual_review / scheduled_blocked / an order claim ⇒ 409 with its reason, nothing written');
  }
  {
    const db = await parked(AMBIGUOUS, { status: 'new', payment_status: 'pending' });
    let release; hold = new Promise((res) => { release = res; }); provider = 'ok';
    const inflight = voidOrRefund({ db, client: realClient, alert: (k, d) => paymentAlert(db, k, d) }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'U-1', reason: 'x', now: NOW + 1 });   // NOT quiet(): it stays pending across the assertion
    for (let i = 0; i < 50 && db.getAt(`payment_attempts/${AID}/status`) !== 'reversing'; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(db.getAt(`payment_attempts/${AID}/status`), 'reversing', 'RA-INFLIGHT premise: the real reversal holds the attempt at reversing');
    const r = await attest(db);
    assert.deepStrictEqual([r.status, r.body.outcome, db.getAt(`manual_review_closures/${OID}`)], [409, 'reversal_in_flight', null], '🔴 RA-INFLIGHT: reversing ⇒ 409, nothing written');
    release(); hold = null; await inflight;
    const db2 = await parked(AMBIGUOUS, { status: 'new', payment_status: 'pending' });
    provider = 'decline';
    await quiet(() => voidOrRefund({ db: db2, client: realClient, alert: (k, d) => paymentAlert(db2, k, d) }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'U-1', reason: 'x', now: NOW + 1 }));
    assert.strictEqual(db2.getAt(`payment_attempts/${AID}/status`), 'refund_pending', 'RA-INFLIGHT premise: refund_pending');
    const r2 = await attest(db2);
    assert.deepStrictEqual([r2.status, r2.body.outcome, db2.getAt(`manual_review_closures/${OID}`)], [409, 'reversal_in_flight', null], '🔴 RA-INFLIGHT: refund_pending ⇒ 409, nothing written');
    ok('RA-INFLIGHT: a real reversal in flight (reversing) or refund_pending ⇒ 409, nothing written');
  }
  {
    let fired = false; let db;
    db = await parked(CAPTURED_NO_UUID, {}, { beforeTx: async (p) => { if (!db || fired || p !== `manual_review_closures/${OID}/${EP1}`) return; fired = true; await attest(db, { actor: 'other@tb', outcome: 'charge_stands', now: NOW + 4 }); } });
    const r = await attest(db);
    assert.ok(fired, 'RA-RACE premise: the other attestation ran first');
    assert.deepStrictEqual([r.status, r.body.outcome, db.getAt(`manual_review_closures/${OID}/${EP1}/by`), Object.keys(db.getAt(`manual_review_closures/${OID}`)).length], [409, 'already_closed', 'other@tb', 1], '🔴 RA-RACE: ours already_closed; exactly one record, the first');
    ok('RA-RACE: two reviewers ⇒ exactly one record');
  }
  {
    const db = await parked();
    const before = snapshot(db);
    for (const over of [{ outcome: 'refunded' }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: '299' }, { orderId: 'a/b' }, { note: 'x'.repeat(201) }, { episode: -1 }, { episode: 1.5 }, { episode: '1' }, { episode: undefined }]) {
      const r = await attest(db, over);
      assert.strictEqual(r.status, 400, `🔴 RA-BAD: ${JSON.stringify(over).slice(0, 40)} ⇒ 400`);
    }
    assert.deepStrictEqual(diff(before, snapshot(db)), [], '🔴 RA-BAD: nothing written');
    ok('RA-BAD: a bad outcome / amount / episode / order id / note ⇒ 400, nothing written');
  }
  {
    const db = await parked();
    let handler = null;
    const DISP_AUTH = { ok: true, actor: 'disp@tb', uid: 'D1', byKind: 'dispatcher' };
    const mk = (auth) => { handler = null; RA.endpoint({ onRequest: (_opts, h) => { handler = h; return h; }, authorize: async () => auth, getDatabase: () => db, sanitizeText: (s, m) => String(s || '').slice(0, m) }); return handler; };
    const call = async (h, body, method = 'POST') => { const out = {}; const res = { set() { return res; }, status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; } }; await h({ method, body }, res); return out; };
    const before = snapshot(db);
    const BODY = { order_id: OID, episode: EP1, outcome: 'charge_stands', amount_cents: 29900 };
    let denied; try { denied = await call(mk({ ok: false, code: 401, msg: 'missing bearer token' }), BODY); } catch (e) { denied = { code: 'threw' }; }   // a handler that ran past a refused auth must still fail HERE
    assert.deepStrictEqual([denied.code, diff(before, snapshot(db))], [401, []], '🔴 RA-AUTH: a refused auth ⇒ its code; the core never runs');
    assert.strictEqual((await call(mk(DISP_AUTH), {}, 'GET')).code, 405, 'RA-AUTH: POST only');
    const svc = await call(mk({ ok: true, actor: 'recon_secret', uid: null, byKind: 'recon_secret' }), { ...BODY, actor: 'server' });
    assert.deepStrictEqual([svc.code, diff(before, snapshot(db))], [403, []], '🔴 RA-AUTH: a human-only action — the service secret is refused');
    for (const [body, why] of [[{ note: 7 }, 'a non-string note'], [{ note: 'x'.repeat(201) }, 'a raw note over 200 (before any sanitizing)'], [{ amount_cents: 29901 }, 'an amount above the order total']]) {
      const r = await call(mk(DISP_AUTH), { ...BODY, ...body });
      assert.deepStrictEqual([r.code, diff(before, snapshot(db))], [400, []], `🔴 RA-AUTH: ${why} ⇒ 400, nothing written`);
    }
    const spoof = await call(mk(DISP_AUTH), { ...BODY, note: 'ok', actor: 'someone-else' });
    assert.deepStrictEqual([spoof.code, db.getAt(`manual_review_closures/${OID}/${EP1}/by`)], [200, 'disp@tb'], '🔴 RA-AUTH: a dispatcher\'s actor is its verified identity, never the body\'s');
    ok('RA-AUTH: auth first; dispatcher identity only (no service secret); raw note + amount bounds; the actor is the verified identity');
  }
  {
    // RA-EPISODE (#217 P1, the REAL writers): close, then a later verify-failing callback → manual_reconciliation, then the REAL resolver's
    // no-uuid refund → manual_review again; the trigger stamps each entry ⇒ a NEW episode
    const db = await parked();
    await attest(db);
    assert.strictEqual(await closed(db), true, 'RA-EPISODE premise: closed');
    const cbDeps = { db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund };
    await quiet(() => handleHostedCallback(cbDeps, { order: `${OID}-${AID}`, status: 'paid', amount: 299, uuid: 'PAY-9', transaction_id: 'T9', payment_hash: 'f'.repeat(32) }, NOW + 10));
    assert.strictEqual(db.getAt(`orders/${OID}/payment_status`), 'manual_reconciliation', 'RA-EPISODE premise: the real callback queued a reconciliation');
    await trig(db, 'manual_review', 'manual_reconciliation', NOW + 10);
    const rr = await quiet(() => resolveManualReconciliationCore({ db, client: realClient, alert: (k, d) => paymentAlert(db, k, d), sanitizeText: (t) => String(t), serverTimestamp: 0, voidOrRefund }, { orderId: OID, action: 'refund', actor: 'disp2@tb', note: '', now: NOW + 20, claimId: 'RC1' }));
    assert.deepStrictEqual([rr.body.outcome, db.getAt(`orders/${OID}/payment_status`)], ['manual_review', 'manual_review'], 'RA-EPISODE premise: the real resolver re-entered manual_review');
    await trig(db, 'manual_reconciliation', 'resolving_refund', NOW + 20); await trig(db, 'resolving_refund', 'manual_review', NOW + 21);
    assert.deepStrictEqual([db.getAt(`manual_review_episodes/${OID}`), await closed(db), unresolvedMoney(db.getAt(`orders/${OID}`))], [NOW + 21, false, true], '🔴 RA-EPISODE: a NEW episode — the old closure no longer counts');
    assert.deepStrictEqual((await attest(db, { now: NOW + 30 })).body.outcome, 'stale', '🔴 RA-EPISODE: the OLD episode is stale');
    const again = await attest(db, { episode: NOW + 21, now: NOW + 31, outcome: 'charge_stands' });
    assert.deepStrictEqual([again.status, await closed(db), Object.keys(db.getAt(`manual_review_closures/${OID}`)).sort()], [200, true, [String(EP1), String(NOW + 21)]], '🔴 RA-EPISODE: the new episode closes in its OWN node; the old record is kept');
    await trig(db, 'manual_review', 'manual_review', NOW + 40);
    assert.strictEqual(db.getAt(`manual_review_episodes/${OID}`), NOW + 21, '🔴 RA-EPISODE: only an ENTRY into manual_review starts an episode');
    ok('RA-EPISODE: a re-entry (real callback → real resolver) starts a new episode; the old closure stops counting and stays recorded');
  }
  {
    // RA-STALE-FLIGHT (#219 P1): the order re-enters review WHILE the request is in flight — after its episode check, before its write
    let fired = false; let db;
    db = await parked(CAPTURED_NO_UUID, {}, { beforeTx: async (p) => { if (!db || fired || p !== `manual_review_closures/${OID}/${EP1}`) return; fired = true; await trig(db, 'manual_reconciliation', 'manual_review', NOW + 50); } });
    const r = await attest(db);
    assert.ok(fired, 'RA-STALE-FLIGHT premise: a new episode began mid-request');
    assert.deepStrictEqual([r.status, r.body.outcome, await closed(db)], [409, 'stale', false], '🔴 RA-STALE-FLIGHT: never bound to the NEWER episode — the answer is stale and the order is NOT closed');
    ok('RA-STALE-FLIGHT: an episode change mid-request ⇒ 409 stale; the new episode stays open');
  }
  {
    // RA-MALFORMED (#219 P2-a): whatever a client wrote ON THE ORDER is ignored — closedness lives only in the server-only roots
    const db = await parked();
    await db.ref(`orders/${OID}`).update({ manual_review_closed: true, manual_review_since: EP1, manual_review_closures: { [EP1]: { by: 'forged' } } });
    assert.deepStrictEqual([await closed(db), unresolvedMoney(db.getAt(`orders/${OID}`))], [false, true], '🔴 RA-MALFORMED: order-node fields (a `true` node, a forged copy) never close a review');
    ok('RA-MALFORMED: review fields written on the order mean nothing; only the server-only roots count');
  }
  {
    // RA-APPEND (#219 P2-b): a closure is never replaced — no pending state for a later write to overwrite
    const db = await parked();
    await attest(db);
    const rec = JSON.stringify(db.getAt(`manual_review_closures/${OID}/${EP1}`));
    await attest(db, { actor: 'other@tb', outcome: 'charge_stands', now: NOW + 8 });
    assert.strictEqual(JSON.stringify(db.getAt(`manual_review_closures/${OID}/${EP1}`)), rec, '🔴 RA-APPEND: the episode\'s record is never replaced');
    ok('RA-APPEND: a closure is append-only (one per episode, never replaced)');
  }
  {
    // RA-CASH (#219 P2-c): a cash-labelled order parked by the real cancel ⇒ the ONE closure write is the complete audit; it counts at once
    const db = await parked(CAPTURED_NO_UUID, { payment_method: 'cash' });
    const r = await attest(db);
    assert.deepStrictEqual([r.status, await closed(db), db.getAt(`manual_review_closures/${OID}/${EP1}/by`)], [200, true, 'disp@tb'], '🔴 RA-CASH: a cash-labelled order is closed and audited by the one write (nothing pending, no backstop)');
    ok('RA-CASH: a cash-labelled parked order ⇒ closed and audited in one write');
  }
  {
    // RA-NEVER-HIDE (owner bar 1): the REAL prune over a fixture world — open, closed, and a stale closure — returns byte-identical results;
    // a closure is never an input to it
    const orders = { P1: { status: 'cancelled', payment_status: 'manual_review' }, P2: { status: 'new', payment_status: 'manual_review' }, P3: { status: 'cancelled', payment_status: 'refunded' } };
    const alerts = { a: { type: 'payment_cancel_manual_review', detail: { orderId: 'P1' } }, b: { type: 'payment_reconcile_breaches', detail: { breaches: [{ orderId: 'P2', kind: 'aged_manual_review' }] } }, c: { type: 'payment_x', detail: { orderId: 'P3' } } };
    const open = makeDb({ orders, dispatcher_alerts: alerts, manual_review_episodes: { P1: 5, P2: 5 } });
    const shut = makeDb({ orders, dispatcher_alerts: alerts, manual_review_episodes: { P1: 5, P2: 5 }, manual_review_closures: { P1: { 5: { by: 'd' } }, P2: { 5: { by: 'd' } } } });
    assert.deepStrictEqual([await RA.isClosed(open, 'P1'), await RA.isClosed(shut, 'P1')], [false, true], 'RA-NEVER-HIDE premise: one world closed, one not');
    const pruneOf = (db) => JSON.stringify(alertsToPrune(db.getAt('dispatcher_alerts'), db.getAt('orders')));
    assert.strictEqual(pruneOf(shut), pruneOf(open), '🔴 RA-NEVER-HIDE: the prune is byte-identical with or without closures');
    assert.deepStrictEqual(JSON.parse(pruneOf(shut)), ['c'], '🔴 RA-NEVER-HIDE: every alert on an order in manual_review is kept, closed or not (only the refunded order\'s goes)');
    // (owner bar 2): a NEW episode's own outcome alerts — raised by the REAL callback and the REAL resolver while an OLD closure exists — are kept
    const db = await parked();
    await attest(db);
    const before = new Set(Object.keys(db.getAt('dispatcher_alerts') || {}));
    const cbDeps = { db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund };
    await quiet(() => handleHostedCallback(cbDeps, { order: `${OID}-${AID}`, status: 'paid', amount: 299, uuid: 'PAY-9', transaction_id: 'T9', payment_hash: 'f'.repeat(32) }, NOW + 10));
    await trig(db, 'manual_review', 'manual_reconciliation', NOW + 10);
    await quiet(() => resolveManualReconciliationCore({ db, client: realClient, alert: (k, d) => paymentAlert(db, k, d), sanitizeText: (t) => String(t), serverTimestamp: 0, voidOrRefund }, { orderId: OID, action: 'refund', actor: 'disp2@tb', note: '', now: NOW + 20, claimId: 'RC1' }));
    await trig(db, 'manual_reconciliation', 'resolving_refund', NOW + 20); await trig(db, 'resolving_refund', 'manual_review', NOW + 21);
    const raised = Object.keys(db.getAt('dispatcher_alerts') || {}).filter((k) => !before.has(k));
    assert.ok(raised.length >= 1, `RA-NEVER-HIDE premise: the new episode raised its own alerts (${raised.length})`);
    const pruned = alertsToPrune(db.getAt('dispatcher_alerts'), db.getAt('orders'));
    assert.deepStrictEqual(raised.filter((k) => pruned.includes(k)), [], `🔴 RA-NEVER-HIDE: the new episode's own alerts are all kept (${raised.map((k) => db.getAt(`dispatcher_alerts/${k}/type`)).join(', ')})`);
    ok('RA-NEVER-HIDE: a closure never changes the prune (byte-identical); a new episode\'s own alerts are raised and kept');
  }
  {
    // RA-DAILY (owner bar 3): the closure only skips the CURRENT episode's reminder; the race costs at most one day
    const db = await parked();
    assert.strictEqual(await RA.isClosed(db, OID), false, 'RA-DAILY premise: open ⇒ the reminder is due');
    await attest(db);
    assert.strictEqual(await RA.isClosed(db, OID), true, '🔴 RA-DAILY: closed in its current episode ⇒ the reminder is skipped');
    // day 1: the decision is taken (closed ⇒ skipped) and, in the same instant, the order re-enters review (a new episode)
    const day1 = await RA.isClosed(db, OID);
    await trig(db, 'manual_reconciliation', 'manual_review', NOW + 60);
    assert.strictEqual(day1, true, 'RA-DAILY: day 1 decided before the new episode (the worst-case race)');
    assert.strictEqual(await RA.isClosed(db, OID), false, '🔴 RA-DAILY: day 2 sees the NEW episode open ⇒ its reminder is raised (one day late at most, never lost)');
    ok('RA-DAILY: a closure skips only its current episode\'s daily reminder; a race costs at most one day — the next run raises it');
  }
  {
    // RA-CASH-DAILY (owner bar 4): closedness ignores payment_method — a cash-labelled review is open / closed exactly like an online one
    const db = await parked(CAPTURED_NO_UUID, { payment_method: 'cash' });
    assert.strictEqual(await RA.isClosed(db, OID), false, '🔴 RA-CASH-DAILY: an open cash-labelled review is due its reminder');
    await attest(db);
    assert.strictEqual(await RA.isClosed(db, OID), true, '🔴 RA-CASH-DAILY: a closed cash-labelled review skips it');
    ok('RA-CASH-DAILY: a cash-labelled review is open / closed exactly like an online one (the daily rule\'s filter: review-attest-wiring RAW-FILTER; the real run: the emulator)');
  }
  console.log(`review-attest: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
