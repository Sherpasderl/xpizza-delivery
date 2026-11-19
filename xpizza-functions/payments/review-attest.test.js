'use strict';
// «Marcar como revisado» — owner 11-19, option B (PLAN-5f-review-action-r1): a recorded HUMAN ATTESTATION ONLY. ONE order CAS adds
// manual_review_closed { outcome, amount_cents, note, by, at } (+ a payment_audit row); payment_status STAYS manual_review; NO payment,
// attempt, reward or status change. The daily aged_manual_review rule and alert-prune's unresolvedMoney skip a closed review.
//   RA-CLOSE      a REAL cancel park ⇒ attest ⇒ 200; the ONLY writes are the closed record + the audit row (whole-db diff)
//   RA-GATE       after closing, the REAL cancel still refuses (the B.2 gate's manual_review), no claim, no void
//   RA-REFUSE     not manual_review / already closed / scheduled_blocked / an order claim ⇒ 409 with its reason, nothing written
//   RA-INFLIGHT   a REAL voidOrRefund in flight (attempt `reversing`, held at the provider call) or left refund_pending ⇒ 409
//   RA-RACE       a second attestation lands right before ours (beforeTx) ⇒ ours answers already_closed; exactly one record
//   RA-BAD        a bad outcome / amount / order id ⇒ 400, nothing written
//   RA-AUTH       the endpoint authorizes FIRST: a refused auth ⇒ its code, the core never runs; the RECON_SECRET actor label only
//   RA-PRUNE      alert-prune: a CLOSED manual_review is no longer unresolved money (an unclosed one still is)
//   RA-EPISODE    Codex #217 P1: a closure belongs to ONE manual_review episode. A REAL verify-failing callback (→ manual_reconciliation) then
//                 the REAL resolver's no-uuid refund (→ manual_review) re-enter review; the episode trigger stamps manual_review_since ⇒ the
//                 old closure no longer counts (unresolved money again, re-closable)
//   RA-AUDIT      Codex #217 P2-3: the audit row's write FAILS ⇒ the decision stands (audited:false, 202 audit pending); completeAudit (the
//                 daily backstop) writes the deterministic row and flips audited — idempotent
// Run: node payments/review-attest.test.js
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const RA = require('./review-attest');
const { cancelOrderCore } = require('../cancel-order-core');
const { voidOrRefund } = require('../pixelpay-cancel');
const realClient = require('../pixelpay-client');
const { paymentAlert } = require('../lib/payment-alert');
const { unresolvedMoney, reviewClosed } = require('../alert-prune');
const { resolveManualReconciliationCore } = require('../resolve-manual');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { buildMaterializeUpdates } = require('../materialize');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const OID = 'RVA1', AID = 'c0ffee00c0ffee55', NOW = 1_800_000_000_000;
const quiet = async (f) => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await f(); } finally { console.warn = w; console.error = e; console.log = l; } };
// the stubbed PixelPay void (the REAL client + voidOrRefund run): 'ok' | 'decline' | a held promise
let provider = 'decline'; let hold = null;
globalThis.fetch = async (url) => {
  if (!String(url).endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${url}`);
  if (hold) await hold;
  return new Response(JSON.stringify(provider === 'ok' ? { success: true, message: 'ok' } : { success: false, message: 'no' }), { status: 200 });
};
const ORDER = (o = {}) => ({ order_id: OID, order_type: 'pickup', status: 'new', payment_status: 'confirmed', payment_method: 'online', total: 299, total_cents: 29900,
  customer_name: 'T', items_text: 'x', restaurant_id: 'x_pizza', active_attempt_id: AID, created_at: NOW - 3600000, ...o });
const CAPTURED_NO_UUID = { order_id: OID, hosted_state: 'paid', hosted_callback_verified: true, hosted_order_id: `${OID}-${AID}` };          // the cancel's B refusal
const AMBIGUOUS = { order_id: OID, hosted_state: 'created', payment_uuid: 'U-1', hosted_order_id: `${OID}-${AID}` };   // the C refusal (a uuid)
// a REAL park: cancelOrderCore refuses and parks the order at manual_review
const parked = async (att = CAPTURED_NO_UUID, ord = {}, hooks) => {
  const db = makeDb({ orders: { [OID]: ORDER(ord) }, payment_attempts: { [AID]: att } }, hooks);
  await quiet(() => cancelOrderCore({ db, voidOrRefund: async () => { throw new Error('must not void'); }, alert: (k, d) => paymentAlert(db, k, d), serverTimestamp: 0 },
    { orderId: OID, actor: 'disp@tb', reason: 'customer', now: NOW, claimId: 'CL1' }));
  assert.strictEqual(db.getAt(`orders/${OID}/payment_status`), 'manual_review', 'premise: the real cancel parked the order');
  return db;
};
const attest = (db, over = {}) => RA.attestManualReview(db, { orderId: OID, outcome: 'refunded_in_pixelpay', amountCents: 29900, note: 'anulado en PixelPay', actor: 'disp@tb', now: NOW + 5, serverTimestamp: 7, ...over });
const flat = (v, p = '', out = {}) => { if (v && typeof v === 'object') { for (const k of Object.keys(v)) flat(v[k], p ? `${p}/${k}` : k, out); } else out[p] = v; return out; };
const diff = (a, b) => { const A = flat(a), B = flat(b); return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => A[k] !== B[k]).sort(); };
const snapshot = (db) => JSON.parse(JSON.stringify(db.root));

(async () => {
  {
    const db = await parked();
    const before = snapshot(db);
    const r = await attest(db);
    assert.deepStrictEqual([r.status, r.body.outcome], [200, 'review_closed'], `🔴 RA-CLOSE: 200 review_closed (${JSON.stringify(r.body)})`);
    const o = db.getAt(`orders/${OID}`);
    assert.deepStrictEqual(o.manual_review_closed, { outcome: 'refunded_in_pixelpay', amount_cents: 29900, note: 'anulado en PixelPay', by: 'disp@tb', at: NOW + 5, audited: true }, '🔴 RA-CLOSE: the closed record (episode null: no stamp yet), audited');
    assert.strictEqual(o.payment_status, 'manual_review', '🔴 RA-CLOSE: payment_status STAYS manual_review');
    const changed = diff(before, snapshot(db)).map((k) => k.replace(/^payment_audit\/[^/]+\//, 'payment_audit/*/'));
    assert.deepStrictEqual([...new Set(changed)].sort(), ['orders/RVA1/manual_review_closed/amount_cents', 'orders/RVA1/manual_review_closed/at', 'orders/RVA1/manual_review_closed/audited', 'orders/RVA1/manual_review_closed/by', 'orders/RVA1/manual_review_closed/note', 'orders/RVA1/manual_review_closed/outcome',
      'payment_audit/*/action', 'payment_audit/*/actor', 'payment_audit/*/amount_cents', 'payment_audit/*/at', 'payment_audit/*/note', 'payment_audit/*/order_id', 'payment_audit/*/outcome'].sort(), '🔴 RA-CLOSE: NOTHING else is written (no payment / attempt / reward / status change)');
    const audit = db.getAt(`payment_audit/review_${OID}_${NOW + 5}`);   // a DETERMINISTIC key: a retried write is idempotent
    assert.deepStrictEqual(audit, { order_id: OID, action: 'review_attest', actor: 'disp@tb', outcome: 'refunded_in_pixelpay', amount_cents: 29900, note: 'anulado en PixelPay', at: NOW + 5 }, 'RA-CLOSE: the audit row (written from the closure itself; episode null ⇒ absent)');
    ok('RA-CLOSE: a real park ⇒ attested; only the closed record + one audit row are written; payment_status stays manual_review');
    // RA-GATE: the REAL cancel still refuses a closed review
    let voids = 0;
    const r2 = await quiet(() => cancelOrderCore({ db, voidOrRefund: async () => { voids += 1; return { voided: true }; }, alert: (k, d) => paymentAlert(db, k, d), serverTimestamp: 0 }, { orderId: OID, actor: 'disp@tb', reason: 'customer', now: NOW + 9, claimId: 'CL2' }));
    assert.deepStrictEqual([r2.status, r2.body.outcome, voids, db.getAt(`orders/${OID}/cancel_claim_id`) || null], [409, 'manual_review', 0, null], '🔴 RA-GATE: the real cancel still refuses; no claim, no void');
    ok('RA-GATE: after closing, the real cancel still refuses (no claim, no void)');
    // RA-REFUSE: already closed
    const r3 = await attest(db, { outcome: 'charge_stands' });
    assert.deepStrictEqual([r3.status, r3.body.outcome, db.getAt(`orders/${OID}/manual_review_closed/outcome`)], [409, 'already_closed', 'refunded_in_pixelpay'], '🔴 RA-REFUSE: already closed ⇒ 409, the first record stands');
  }
  {
    // RA-REFUSE: not manual_review / scheduled_blocked (the shape pixelpay-confirm.js:275 writes) / an order claim
    const cases = [
      ['not_in_review', makeDb({ orders: { [OID]: ORDER() }, payment_attempts: { [AID]: CAPTURED_NO_UUID } })],
      ['scheduled_blocked', makeDb({ orders: { [OID]: ORDER({ status: 'scheduled', payment_status: 'manual_review', scheduled_blocked: true, blocked_reason: 'confirm_slot_closed' }) }, payment_attempts: { [AID]: CAPTURED_NO_UUID } })],
      ['claim_in_flight', makeDb({ orders: { [OID]: ORDER({ payment_status: 'manual_review', cancel_claim_id: 'CLX', resolving_action: 'cancel' }) }, payment_attempts: { [AID]: CAPTURED_NO_UUID } })],
      ['claim_in_flight', makeDb({ orders: { [OID]: ORDER({ payment_status: 'manual_review', resolving_claim_id: 'RCL', resolving_phase: 'claimed' }) }, payment_attempts: { [AID]: CAPTURED_NO_UUID } })],
    ];
    for (const [why, db] of cases) {
      const before = snapshot(db);
      const r = await attest(db);
      assert.deepStrictEqual([r.status, r.body.outcome], [409, why], `🔴 RA-REFUSE: ${why} ⇒ 409 (${JSON.stringify(r.body)})`);
      assert.deepStrictEqual(diff(before, snapshot(db)), [], `🔴 RA-REFUSE: ${why} ⇒ nothing written`);
    }
    ok('RA-REFUSE: already closed / not manual_review / scheduled_blocked / an order claim ⇒ 409 with its reason, nothing written');
  }
  {
    // RA-INFLIGHT: a REAL reversal in flight on the parked order's attempt (the C park: it has a uuid)
    const db = await parked(AMBIGUOUS, { status: 'new', payment_status: 'pending' });
    let release; hold = new Promise((res) => { release = res; }); provider = 'ok';
    const inflight = voidOrRefund({ db, client: realClient, alert: (k, d) => paymentAlert(db, k, d) }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'U-1', reason: 'x', now: NOW + 1 });   // NOT quiet(): it stays pending across the assertion, and quiet() would swallow a failure's report
    for (let i = 0; i < 50 && db.getAt(`payment_attempts/${AID}/status`) !== 'reversing'; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(db.getAt(`payment_attempts/${AID}/status`), 'reversing', 'RA-INFLIGHT premise: the real reversal holds the attempt at reversing');
    const r = await attest(db);
    assert.deepStrictEqual([r.status, r.body.outcome, db.getAt(`orders/${OID}/manual_review_closed`)], [409, 'reversal_in_flight', null], '🔴 RA-INFLIGHT: a reversal in flight (reversing) ⇒ 409, nothing written');
    release(); hold = null; await inflight;
    // …and a reversal the provider declined (refund_pending: the reconciler will retry it)
    const db2 = await parked(AMBIGUOUS, { status: 'new', payment_status: 'pending' });
    provider = 'decline';
    await quiet(() => voidOrRefund({ db: db2, client: realClient, alert: (k, d) => paymentAlert(db2, k, d) }, { orderId: OID, attemptId: AID, pixelpayOrderId: `${OID}-${AID}`, paymentUuid: 'U-1', reason: 'x', now: NOW + 1 }));
    assert.strictEqual(db2.getAt(`payment_attempts/${AID}/status`), 'refund_pending', 'RA-INFLIGHT premise: refund_pending');
    const r2 = await attest(db2);
    assert.deepStrictEqual([r2.status, r2.body.outcome, db2.getAt(`orders/${OID}/manual_review_closed`)], [409, 'reversal_in_flight', null], '🔴 RA-INFLIGHT: refund_pending ⇒ 409, nothing written');
    ok('RA-INFLIGHT: a real reversal in flight (reversing) or refund_pending ⇒ 409, nothing written');
  }
  {
    // RA-RACE: another reviewer's attestation lands right before our CAS
    let fired = false; let db;
    db = await parked(CAPTURED_NO_UUID, {}, { beforeTx: async (p) => { if (!db || fired || p !== `orders/${OID}`) return; fired = true; await attest(db, { actor: 'other@tb', outcome: 'charge_stands' }); } });
    const r = await attest(db);
    assert.ok(fired, 'RA-RACE premise: the other attestation ran first');
    assert.deepStrictEqual([r.status, r.body.outcome, db.getAt(`orders/${OID}/manual_review_closed/by`)], [409, 'already_closed', 'other@tb'], '🔴 RA-RACE: ours answers already_closed; the first record stands');
    assert.strictEqual(Object.values(db.getAt('payment_audit')).filter((a) => a.action === 'review_attest').length, 1, '🔴 RA-RACE: exactly one audit row');
    ok('RA-RACE: two reviewers ⇒ exactly one record + one audit row');
  }
  {
    const db = await parked();
    const before = snapshot(db);
    for (const over of [{ outcome: 'refunded' }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: '299' }, { orderId: 'a/b' }, { note: 'x'.repeat(201) }]) {
      const r = await attest(db, over);
      assert.strictEqual(r.status, 400, `🔴 RA-BAD: ${JSON.stringify(over).slice(0, 40)} ⇒ 400`);
    }
    assert.deepStrictEqual(diff(before, snapshot(db)), [], '🔴 RA-BAD: nothing written');
    ok('RA-BAD: a bad outcome / amount / order id / note ⇒ 400, nothing written');
  }
  {
    // RA-AUTH: the endpoint (the factory index.js wires with onRequest + authorizeDispatcherAction) authorizes FIRST
    const db = await parked();
    let handler = null;
    const DISP_AUTH = { ok: true, actor: 'disp@tb', uid: 'D1', byKind: 'dispatcher' };
    const mk = (auth) => { handler = null; RA.endpoint({ onRequest: (_opts, h) => { handler = h; return h; }, authorize: async () => auth, getDatabase: () => db, sanitizeText: (s, m) => String(s || '').slice(0, m) }); return handler; };
    const call = async (h, body, method = 'POST') => { const out = {}; const res = { set() { return res; }, status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; } }; await h({ method, body }, res); return out; };
    const before = snapshot(db);
    let denied; try { denied = await call(mk({ ok: false, code: 401, msg: 'missing bearer token' }), { order_id: OID, outcome: 'charge_stands', amount_cents: 29900 }); } catch (e) { denied = { code: 'threw' }; }   // a handler that ran past a refused auth must still fail HERE
    assert.deepStrictEqual([denied.code, diff(before, snapshot(db))], [401, []], '🔴 RA-AUTH: a refused auth ⇒ its code; the core never runs');
    const get = await call(mk(DISP_AUTH), {}, 'GET');
    assert.strictEqual(get.code, 405, 'RA-AUTH: POST only');
    const svc = await call(mk({ ok: true, actor: 'recon_secret', uid: null, byKind: 'recon_secret' }), { order_id: OID, outcome: 'charge_stands', amount_cents: 29900, actor: 'server' });
    assert.deepStrictEqual([svc.code, diff(before, snapshot(db))], [403, []], '🔴 RA-AUTH: a human-only action — the service secret is refused (Codex #217 P2-2)');
    for (const [body, why] of [[{ note: 7 }, 'a non-string note'], [{ note: 'x'.repeat(201) }, 'a raw note over 200 (before any sanitizing)'], [{ amount_cents: 29901 }, 'an amount above the order total']]) {
      const r = await call(mk(DISP_AUTH), { order_id: OID, outcome: 'charge_stands', amount_cents: 29900, ...body });
      assert.deepStrictEqual([r.code, diff(before, snapshot(db))], [400, []], `🔴 RA-AUTH: ${why} ⇒ 400, nothing written (Codex #217 P3)`);
    }
    const spoof = await call(mk(DISP_AUTH), { order_id: OID, outcome: 'charge_stands', amount_cents: 29900, note: 'ok', actor: 'someone-else' });
    assert.deepStrictEqual([spoof.code, db.getAt(`orders/${OID}/manual_review_closed/by`)], [200, 'disp@tb'], '🔴 RA-AUTH: a dispatcher\'s actor is its verified identity, never the body\'s');
    ok('RA-AUTH: auth first; dispatcher identity only (no service secret); raw note + amount bounds; the actor is the verified identity');
  }
  {
    assert.strictEqual(unresolvedMoney({ status: 'cancelled', payment_status: 'manual_review' }), true, 'RA-PRUNE: an open review is unresolved');
    assert.strictEqual(unresolvedMoney({ status: 'cancelled', payment_status: 'manual_review', manual_review_closed: { outcome: 'refunded_in_pixelpay' } }), false, '🔴 RA-PRUNE: a CLOSED review is no longer unresolved money');
    assert.strictEqual(unresolvedMoney({ status: 'cancelled', payment_status: 'refund_pending', manual_review_closed: { outcome: 'x' } }), true, '🔴 RA-PRUNE: the close applies to manual_review only');
    ok('RA-PRUNE: a closed manual_review is no longer unresolved money; nothing else changes');
  }
  {
    // RA-EPISODE (Codex #217 P1, its repro with the REAL writers): close, then a later verify-failing callback → manual_reconciliation, then the
    // REAL resolver's refund finds no payment id → manual_review again. The episode trigger (RA.onPaymentStatus, run here for each payment_status
    // write exactly as the deployed trigger is) stamps the re-entry ⇒ the old closure is stale.
    const db = await parked();
    const ep = async (before, after, t) => RA.onPaymentStatus(db, { orderId: OID, before, after, eventTime: t });
    await attest(db);
    assert.strictEqual(reviewClosed(db.getAt(`orders/${OID}`)), true, 'RA-EPISODE premise: closed');
    const cbDeps = { db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund };
    await quiet(() => handleHostedCallback(cbDeps, { order: `${OID}-${AID}`, status: 'paid', amount: 299, uuid: 'PAY-9', transaction_id: 'T9', payment_hash: 'f'.repeat(32) }, NOW + 10));
    assert.strictEqual(db.getAt(`orders/${OID}/payment_status`), 'manual_reconciliation', 'RA-EPISODE premise: the real callback queued a reconciliation');
    await ep('manual_review', 'manual_reconciliation', NOW + 10);
    const rr = await quiet(() => resolveManualReconciliationCore({ db, client: realClient, alert: (k, d) => paymentAlert(db, k, d), sanitizeText: (t) => String(t), serverTimestamp: 0, voidOrRefund }, { orderId: OID, action: 'refund', actor: 'disp2@tb', note: '', now: NOW + 20, claimId: 'RC1' }));
    assert.deepStrictEqual([rr.body.outcome, db.getAt(`orders/${OID}/payment_status`)], ['manual_review', 'manual_review'], 'RA-EPISODE premise: the real resolver re-entered manual_review');
    await ep('manual_reconciliation', 'resolving_refund', NOW + 20); await ep('resolving_refund', 'manual_review', NOW + 21);
    const o = db.getAt(`orders/${OID}`);
    assert.deepStrictEqual([o.manual_review_since, reviewClosed(o), unresolvedMoney(o)], [NOW + 21, false, true], '🔴 RA-EPISODE: a NEW episode — the old closure no longer counts (its alerts and the daily breach are back)');
    const again = await attest(db, { now: NOW + 30, outcome: 'charge_stands' });
    assert.deepStrictEqual([again.status, db.getAt(`orders/${OID}/manual_review_closed/episode`), reviewClosed(db.getAt(`orders/${OID}`))], [200, NOW + 21, true], '🔴 RA-EPISODE: the new episode can be closed, bound to its own stamp');
    await ep('manual_review', 'manual_review', NOW + 40);   // a write that does not ENTER review (same value) starts nothing
    assert.strictEqual(reviewClosed(db.getAt(`orders/${OID}`)), true, 'RA-EPISODE: only an ENTRY into manual_review starts an episode');
    ok('RA-EPISODE: a re-entry into manual_review (real callback → real resolver) starts a new episode; the stale closure stops counting');
  }
  {
    // RA-AUDIT (Codex #217 P2-3): the audit row write fails right after the decision commits
    let fail = 1;
    const db = await parked(CAPTURED_NO_UUID, {}, { beforeWrite: async (p) => { if (p.startsWith('payment_audit/') && fail > 0) { fail -= 1; throw new Error('write failed'); } } });
    const r = await quiet(() => attest(db));
    assert.deepStrictEqual([r.status, r.body.outcome, r.body.audit, db.getAt(`orders/${OID}/manual_review_closed/audited`), db.getAt(`payment_audit/review_${OID}_${NOW + 5}`)], [202, 'review_closed', 'pending', false, null], '🔴 RA-AUDIT: the decision stands, the audit is pending (never a lost or half-told outcome)');
    await RA.completeAudit(db, OID);
    const row = db.getAt(`payment_audit/review_${OID}_${NOW + 5}`);
    assert.deepStrictEqual([row && row.outcome, row && row.actor, db.getAt(`orders/${OID}/manual_review_closed/audited`)], ['refunded_in_pixelpay', 'disp@tb', true], '🔴 RA-AUDIT: the backstop writes the deterministic row and flips audited');
    const before = snapshot(db); await RA.completeAudit(db, OID);
    assert.deepStrictEqual(diff(before, snapshot(db)), [], 'RA-AUDIT: completeAudit is idempotent');
    ok('RA-AUDIT: a failed audit write leaves audited:false (202 pending); the backstop completes it, idempotently');
  }
  console.log(`review-attest: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
