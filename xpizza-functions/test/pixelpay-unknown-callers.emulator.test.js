/**
 * P5a (codex r1 #2–#4) — the REAL outer callers and the REAL scheduled entrypoints keep the money invariant when a
 * PixelPay outcome is UNKNOWN: a reward hold is NEVER released on an unconfirmed void, and a capture whose outcome
 * is unknown is durably escalated (never declined, never re-captured).
 *
 * The REAL pixelpay-client runs under a stubbed globalThis.fetch (real Response objects; never the network) inside
 * the REAL resolveManualReconciliationCore, handleHostedCallback→voidPaid, cancelOrderCore, and index.js's
 * sweepStalePending / refundReconciler / confirmOnlinePayment HTTP handler, against the RTDB emulator, with redeemed
 * orders and reward reservations seeded. Every assertion message starts with its cell label (POU-E-…).
 * Run: npm run test:pixelpay-unknown-callers
 */
require('./_emulator-required')('database');   // refuse if the emulator host vars are unset (would hit real infrastructure, or a foreign emulator)

const assert = require('assert');
const http = require('http');
process.env.PIXELPAY_MODE = 'sandbox';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'tb-make-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('🔴 REFUSED — FIREBASE_DATABASE_EMULATOR_HOST is not set (this harness clears the database root).');
  process.exit(1);
}

// ---- TEST-OWNED failure-injection seam (codex P5a r2): the reward-ledger helpers are wrapped in require.cache BEFORE
// index.js loads, so every module that destructures them (cancel-order-core, resolve-manual, index.js, …) gets the wrapper.
// With no injection armed the wrapper is the real function, byte-for-byte behaviour.
const inject = { reverseRedemption: 0, reverseEarn: 0 };
{
  const RR = require('../rewards-reserve'); const realRev = RR.reverseRedemptionForOrder;
  RR.reverseRedemptionForOrder = async (...a) => { if (inject.reverseRedemption > 0) { inject.reverseRedemption--; return { ok: false, error: true }; } return realRev(...a); };
  const RE = require('../rewards-earn'); const realEarn = RE.reverseEarnForOrder;
  RE.reverseEarnForOrder = async (...a) => { if (inject.reverseEarn > 0) { inject.reverseEarn--; return { ok: false, error: true }; } return realEarn(...a); };
}
const app = require('../index.js');            // initializes admin against the emulator + registers the exports
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();
const realClient = require('../pixelpay-client');
const { voidOrRefund } = require('../pixelpay-cancel');
const { resolveManualReconciliationCore } = require('../resolve-manual');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { cancelOrderCore } = require('../cancel-order-core');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');

const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'TB Kitchen', phone: '+50400000000' };
const OID = 'TBUNK1', AID = 'a1b2c3d4e5f6a7b8', UID = 'uTbUnk', RID = 'tb_rest';
const NOW = Date.now();

// ---- fetch stub: PixelPay scripted per action; every other URL (alerts / messaging) answers 200 {} ----
const enc = new TextEncoder();
const json = (status, body) => ({ kind: 'json', status, body });
let script = {}; let calls = { status: 0, capture: 0, void: 0 };
function respond(step) {
  if (step.kind === 'json') return new Response(JSON.stringify(step.body), { status: step.status });
  if (step.kind === 'bodyLost') return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"succ')); c.error(new TypeError('terminated')); } }), { status: 200 });
  throw new Error(`unknown step ${step.kind}`);
}
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!u.startsWith('https://pixelpay.dev/api/v2/transaction/')) return new Response('{}', { status: 200 });
  const action = u.split('/').pop();
  const q = script[action] || [];
  const step = q[Math.min(calls[action] || 0, q.length - 1)];
  calls[action] = (calls[action] || 0) + 1;
  if (!step) throw new Error(`POU-E-HARNESS: no scripted PixelPay response for ${action}`);
  return respond(step);
};
function useScript(s) { script = s; calls = { status: 0, capture: 0, void: 0 }; }

// ---- seeds ----
const clearAll = () => db.ref('/').set(null);
const redemption = { model: 'add_free', free_item_key: 'Tb' };
async function seed({ order = {}, attempt = {}, resv = 'reserved' } = {}) {
  await db.ref(`orders/${OID}`).set({
    order_id: OID, order_type: 'pickup', payment_method: 'online', payment_status: 'confirmed', status: 'new',
    total: 299, total_cents: 29900, customer_name: 'Tb', items_text: 'x', active_attempt_id: AID, created_at: NOW - 3600000,
    customer_uid: UID, restaurant_id: RID, redemption, ...order,
  });
  await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, hosted_order_id: `${OID}-${AID}`, ...attempt });
  await db.ref(`user_rewards/${UID}/${RID}`).set({ balance: 100, reserved: 8, reservations: { [OID]: { state: resv, cost: 8, seq: 1, created_at: 0 } } });
}
const oVal = async () => (await db.ref(`orders/${OID}`).once('value')).val();
const aVal = async () => (await db.ref(`payment_attempts/${AID}`).once('value')).val();
const holdState = async () => (await db.ref(`user_rewards/${UID}/${RID}/reservations/${OID}/state`).once('value')).val();
const alertsDeps = () => { const alerts = []; return { alerts, alert: async (k, d) => { alerts.push([k, d]); } }; };

let pass = 0; const fails = [];
async function cell(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); }
}

// Drive the confirm HTTP handler (express app inside onRequest) over a local socket, body pre-parsed as the platform does.
function postConfirm(body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => { req.body = body; app.confirmOnlinePayment(req, res); });
    srv.listen(0, '127.0.0.1', () => {
      const r = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/', headers: { authorization: `Bearer ${process.env.MAKE_SECRET}`, 'content-type': 'application/json' } }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { srv.close(); try { resolve({ status: res.statusCode, body: JSON.parse(t) }); } catch (e) { reject(e); } });
      });
      r.on('error', (e) => { srv.close(); reject(e); }); r.end(JSON.stringify(body));
    });
  });
}

(async () => {
  // ── resolve-manual refund, void outcome UNKNOWN → refund_pending AND the hold secured (never released) ──
  await cell('POU-E-RESOLVE-REFUND-UNKNOWN', async () => {
    const L = 'POU-E-RESOLVE-REFUND-UNKNOWN';
    await clearAll();
    await seed({ order: { status: 'pending_payment', payment_status: 'manual_reconciliation' }, attempt: { payment_uuid: 'S-1', status: 'capture_unverified' }, resv: 'held_paid' });
    useScript({ void: [{ kind: 'bodyLost' }] });
    const { alert } = alertsDeps();
    const deps = { db, client: realClient, buildMaterializeUpdates, restaurant: RESTAURANT, genToken: () => 'TOK', alert,
      getIdentity: async () => ({ active: true }), sanitizeText: (s) => String(s || '').slice(0, 200), serverTimestamp: 111 };
    await resolveManualReconciliationCore(deps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    assert.strictEqual(calls.void, 1, `${L}: one void sent`);
    assert.strictEqual((await oVal()).payment_status, 'refund_pending', `${L}: refund_pending`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the hold must stay secured on an unconfirmed void (got ${await holdState()})`);
  });

  // control: a CONFIRMED manual refund still releases the hold, exactly as today
  await cell('POU-E-RESOLVE-REFUND-CONFIRMED', async () => {
    const L = 'POU-E-RESOLVE-REFUND-CONFIRMED';
    await clearAll();
    await seed({ order: { status: 'pending_payment', payment_status: 'manual_reconciliation' }, attempt: { payment_uuid: 'S-1', status: 'capture_unverified' }, resv: 'held_paid' });
    useScript({ void: [json(200, { success: true, message: 'anulada' })] });
    const { alert } = alertsDeps();
    const deps = { db, client: realClient, buildMaterializeUpdates, restaurant: RESTAURANT, genToken: () => 'TOK', alert,
      getIdentity: async () => ({ active: true }), sanitizeText: (s) => String(s || '').slice(0, 200), serverTimestamp: 111 };
    await resolveManualReconciliationCore(deps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    assert.strictEqual((await oVal()).payment_status, 'refunded', `${L}: refunded`);
    assert.strictEqual(await holdState(), 'released', `${L}: a confirmed refund releases the hold (got ${await holdState()})`);
  });

  // ── hosted late paid callback on a cancelled order, void outcome UNKNOWN → refund_pending, hold secured ──
  await cell('POU-E-HOSTED-LATE-VOID-UNKNOWN', async () => {
    const L = 'POU-E-HOSTED-LATE-VOID-UNKNOWN';
    await clearAll();
    await seed({ order: { status: 'pending_payment', payment_status: 'pending' }, attempt: { hosted_state: 'created', cancel_pending: true } });
    useScript({ void: [{ kind: 'bodyLost' }] });
    const { alert } = alertsDeps();
    const deps = { db, restaurant: RESTAURANT, buildMaterializeUpdates, alert, genToken: () => 'TOK', client: realClient, voidOrRefund };
    const cb = { order: `${OID}-${AID}`, status: 'paid', amount: 299, uuid: 'P-paid-1', transaction_id: 'TXN', payment_hash: paymentHash(`${OID}-${AID}`, KEY, SECRET) };
    const r = await handleHostedCallback(deps, cb, NOW);
    assert.strictEqual(r.outcome, 'cancelled_refund_pending', `${L}: cancelled_refund_pending, got ${r.outcome}`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the hold must be secured, not released, on an unconfirmed void (got ${await holdState()})`);
  });

  // ── dispatcher cancel of a captured order, void outcome UNKNOWN → refund_pending, hold secured ──
  await cell('POU-E-CANCEL-VOID-UNKNOWN', async () => {
    const L = 'POU-E-CANCEL-VOID-UNKNOWN';
    await clearAll();
    await seed({ order: { status: 'new', payment_status: 'confirmed' }, attempt: { payment_uuid: 'S-1', status: 'captured', captured_at: NOW - 60000 } });
    useScript({ void: [{ kind: 'bodyLost' }] });
    const { alert } = alertsDeps();
    const r = await cancelOrderCore({ db, client: realClient, voidOrRefund, alert, serverTimestamp: 111 }, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(calls.void, 1, `${L}: one void sent`);
    assert.strictEqual((await oVal()).payment_status, 'refund_pending', `${L}: refund_pending (got ${(await oVal()).payment_status}, ${r && r.body && r.body.outcome})`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the hold must be secured, not released, on an unconfirmed void (got ${await holdState()})`);
  });

  // control: a CONFIRMED cancel void releases the hold, exactly as today
  await cell('POU-E-CANCEL-VOID-CONFIRMED', async () => {
    const L = 'POU-E-CANCEL-VOID-CONFIRMED';
    await clearAll();
    await seed({ order: { status: 'new', payment_status: 'confirmed' }, attempt: { payment_uuid: 'S-1', status: 'captured', captured_at: NOW - 60000 } });
    useScript({ void: [json(200, { success: true, message: 'anulada' })] });
    const { alert } = alertsDeps();
    await cancelOrderCore({ db, client: realClient, voidOrRefund, alert, serverTimestamp: 111 }, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual((await oVal()).payment_status, 'refunded', `${L}: refunded`);
    assert.strictEqual(await holdState(), 'released', `${L}: a confirmed cancel void releases the hold (got ${await holdState()})`);
  });

  // ── the REAL refundReconciler: a later CONFIRMED retry releases the secured hold; an unknown retry keeps it ──
  await cell('POU-E-RECON-KEEPS-ON-UNKNOWN', async () => {
    const L = 'POU-E-RECON-KEEPS-ON-UNKNOWN';
    await clearAll();
    await seed({ order: { status: 'cancelled', payment_status: 'refund_pending' }, attempt: { payment_uuid: 'S-1', status: 'refund_pending', refunded_at: NOW - 3600000 }, resv: 'held_paid' });
    useScript({ void: [{ kind: 'bodyLost' }] });
    await app.refundReconciler.run({});
    assert.strictEqual(calls.void, 1, `${L}: the reconciler retried the void once`);
    assert.strictEqual((await aVal()).status, 'refund_pending', `${L}: still refund_pending`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the hold stays secured while the refund is unconfirmed (got ${await holdState()})`);
  });
  await cell('POU-E-RECON-RELEASES-ON-CONFIRMED', async () => {
    const L = 'POU-E-RECON-RELEASES-ON-CONFIRMED';
    await clearAll();
    await seed({ order: { status: 'cancelled', payment_status: 'refund_pending' }, attempt: { payment_uuid: 'S-1', status: 'refund_pending', refunded_at: NOW - 3600000 }, resv: 'held_paid' });
    useScript({ void: [json(200, { success: true, message: 'anulada' })] });
    await app.refundReconciler.run({});
    assert.strictEqual((await aVal()).status, 'refunded', `${L}: the retry confirmed the refund`);
    assert.strictEqual(await holdState(), 'released', `${L}: a confirmed reconciler refund releases the secured hold (got ${await holdState()})`);
  });

  // ── the REAL sweepStalePending: a stale SDK `capturing` attempt (lost capture response) is durably escalated ──
  await cell('POU-E-SWEEP-STALE-CAPTURE', async () => {
    const L = 'POU-E-SWEEP-STALE-CAPTURE';
    await clearAll();
    await seed({ order: { status: 'pending_payment', payment_status: 'pending' }, attempt: { payment_uuid: 'S-1', status: 'capturing', capturing_started_at: Date.now() - 20 * 60000 } });
    useScript({});
    await app.sweepStalePending.run({});
    assert.strictEqual(calls.capture + calls.status + calls.void, 0, `${L}: the sweep makes NO PixelPay call (got ${JSON.stringify(calls)})`);
    assert.strictEqual((await aVal()).status, 'capture_unverified', `${L}: attempt escalated to capture_unverified (got ${(await aVal()).status})`);
    assert.strictEqual((await oVal()).payment_status, 'manual_reconciliation', `${L}: order to manual_reconciliation (got ${(await oVal()).payment_status})`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the hold is secured held_paid (got ${await holdState()})`);
  });
  // control: a FRESH capturing claim (an in-flight confirm) is left alone
  await cell('POU-E-SWEEP-FRESH-CAPTURE-LEFT', async () => {
    const L = 'POU-E-SWEEP-FRESH-CAPTURE-LEFT';
    await clearAll();
    await seed({ order: { status: 'pending_payment', payment_status: 'pending' }, attempt: { payment_uuid: 'S-1', status: 'capturing', capturing_started_at: Date.now() - 30000 } });
    useScript({});
    await app.sweepStalePending.run({});
    assert.strictEqual((await aVal()).status, 'capturing', `${L}: an in-flight claim is untouched`);
    assert.strictEqual((await oVal()).payment_status, 'pending', `${L}: order untouched`);
    assert.strictEqual(await holdState(), 'reserved', `${L}: hold untouched`);
  });

  // ── the REAL confirm HTTP handler: an unconfirmed mismatch void is reported refund_pending, never "failed" ──
  await cell('POU-E-CONFIRM-HTTP-MISMATCH-UNKNOWN', async () => {
    const L = 'POU-E-CONFIRM-HTTP-MISMATCH-UNKNOWN';
    await clearAll();
    await seed({ order: { status: 'pending_payment', payment_status: 'pending' }, attempt: { payment_uuid: 'S-1', status: 'active', total_cents: 29900, pixelpay_order_id: `${OID}-${AID}`, created_at: 1 } });
    await db.ref(`restaurants/${RID}/identity`).set({ active: true, hub_lat: 15.5, hub_lng: -88.0, name: 'TB', phone: 'p', version: 1, delivery_radius_km: 7 });
    useScript({ status: [json(200, { success: true, data: { status: 'authorized' } })],
      capture: [json(200, { success: true, data: { response_approved: true, transaction_approved_amount: 299, payment_hash: 'deadbeef', transaction_reference: 'R' } })],
      void: [{ kind: 'bodyLost' }] });
    const r = await postConfirm({ order_id: OID, payment_uuid: 'S-1' });
    if (r.body && r.body.payment_status === 'manual_reconciliation') throw new Error(`${L}: PREMISE — confirm did not reach the mismatch branch (${JSON.stringify(r.body)})`);
    assert.strictEqual(calls.capture, 1, `${L}: PREMISE — one capture reached (${JSON.stringify(calls)}, body ${JSON.stringify(r.body)})`);
    assert.strictEqual(r.body.payment_status, 'refund_pending', `${L}: an unconfirmed mismatch void is reported refund_pending, got ${JSON.stringify(r.body)}`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the hold is secured held_paid (got ${await holdState()})`);
  });

  // ── codex P5a r2 #1: refunding an OLDER attempt never restores points a newer captured sale consumed ──
  await cell('POU-E-RECON-OLDER-ATTEMPT-NO-RELEASE', async () => {
    const L = 'POU-E-RECON-OLDER-ATTEMPT-NO-RELEASE';
    await clearAll();
    const BID = 'b1b2c3d4e5f6a7b8';
    await seed({ order: { status: 'new', payment_status: 'confirmed', active_attempt_id: BID }, attempt: { payment_uuid: 'S-A', status: 'refund_pending', refunded_at: NOW - 3600000 } });
    await db.ref(`payment_attempts/${BID}`).set({ order_id: OID, status: 'captured', payment_uuid: 'S-B' });
    await db.ref(`user_rewards/${UID}/${RID}`).set({ balance: 92, reserved: 0, reservations: { [OID]: { state: 'consumed', cost: 8, debit_applied: 8, seq: 1, created_at: 0 } } });
    useScript({ void: [json(200, { success: true, message: 'anulada' })] });
    await app.refundReconciler.run({});
    assert.strictEqual((await aVal()).status, 'refunded', `${L}: PREMISE — the older attempt's refund confirmed`);
    assert.strictEqual((await db.ref(`user_rewards/${UID}/${RID}/balance`).once('value')).val(), 92, `${L}: the live sale's consumed points are NOT restored (balance stays 92)`);
    assert.strictEqual(await holdState(), 'consumed', `${L}: the reservation stays consumed (got ${await holdState()})`);
  });

  // ── codex P5a r2 #4: a confirmed refund whose hold release FAILS is journaled and healed by the sweep ──
  await cell('POU-E-RECON-RELEASE-FAILURE-JOURNALED', async () => {
    const L = 'POU-E-RECON-RELEASE-FAILURE-JOURNALED';
    await clearAll();
    await seed({ order: { status: 'cancelled', payment_status: 'refund_pending' }, attempt: { payment_uuid: 'S-1', status: 'refund_pending', refunded_at: NOW - 3600000 }, resv: 'held_paid' });
    useScript({ void: [json(200, { success: true, message: 'anulada' })] });
    inject.reverseRedemption = 1;
    await app.refundReconciler.run({});
    inject.reverseRedemption = 0;
    assert.strictEqual((await aVal()).status, 'refunded', `${L}: PREMISE — the refund confirmed`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: PREMISE — the injected failure left the hold held`);
    const rec = (await db.ref(`reward_ledger_repair/${OID}`).once('value')).val();
    assert.ok(rec, `${L}: the failed release is JOURNALED (reward_ledger_repair/${OID}), never dropped`);
    await app.sweepStalePending.run({});
    assert.strictEqual(await holdState(), 'released', `${L}: the sweep's ledger-repair retry releases the hold (got ${await holdState()})`);
    assert.strictEqual((await db.ref(`reward_ledger_repair/${OID}`).once('value')).val(), null, `${L}: the journal clears once healed`);
  });

  // ── codex P5a r2 #2: an UNCONFIRMED cancel refund + an earn-reversal failure → the repair retry keeps the hold ──
  await cell('POU-E-CANCEL-UNKNOWN-REPAIR-KEEPS-HOLD', async () => {
    const L = 'POU-E-CANCEL-UNKNOWN-REPAIR-KEEPS-HOLD';
    await clearAll();
    await seed({ order: { status: 'new', payment_status: 'confirmed' }, attempt: { payment_uuid: 'S-1', status: 'captured', captured_at: NOW - 60000 } });
    useScript({ void: [{ kind: 'bodyLost' }] });
    inject.reverseEarn = 1;
    const { alert } = alertsDeps();
    await cancelOrderCore({ db, client: realClient, voidOrRefund, alert, serverTimestamp: 111 }, { orderId: OID, actor: 'A', reason: 'x', now: NOW, claimId: 'CID' });
    inject.reverseEarn = 0;
    assert.strictEqual((await oVal()).payment_status, 'refund_pending', `${L}: PREMISE — refund_pending`);
    assert.ok((await db.ref(`reward_ledger_repair/${OID}`).once('value')).val(), `${L}: PREMISE — the earn failure was journaled`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: PREMISE — the hold was secured`);
    await app.sweepStalePending.run({});
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the repair retry must NOT release a hold whose refund is unconfirmed (got ${await holdState()})`);
    assert.strictEqual((await db.ref(`user_rewards/${UID}/${RID}/reserved`).once('value')).val(), 8, `${L}: reserved stays 8`);
  });

  // ── codex P5a r2 #3: an escalation interrupted after its attempt CAS (attempt capture_unverified, order still pending)
  //    is RESUMED by the next sweep, idempotently ──
  await cell('POU-E-SWEEP-RESUMES-PARTIAL-ESCALATION', async () => {
    const L = 'POU-E-SWEEP-RESUMES-PARTIAL-ESCALATION';
    await clearAll();
    await seed({ order: { status: 'pending_payment', payment_status: 'pending' }, attempt: { payment_uuid: 'S-1', status: 'capture_unverified', manual_reason: 'stale_capturing_unrecovered', capturing_started_at: Date.now() - 20 * 60000 } });
    useScript({});
    await app.sweepStalePending.run({});
    assert.strictEqual(calls.capture + calls.status + calls.void, 0, `${L}: no PixelPay call`);
    assert.strictEqual((await oVal()).payment_status, 'manual_reconciliation', `${L}: the order completes to manual_reconciliation (got ${(await oVal()).payment_status})`);
    assert.strictEqual(await holdState(), 'held_paid', `${L}: the hold is secured (got ${await holdState()})`);
    await app.sweepStalePending.run({});
    assert.strictEqual((await oVal()).payment_status, 'manual_reconciliation', `${L}: a second sweep is a no-op`);
  });

  if (fails.length) { console.error(`\nFAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`\nAll ${pass} unknown-outcome caller cells passed.`);
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
