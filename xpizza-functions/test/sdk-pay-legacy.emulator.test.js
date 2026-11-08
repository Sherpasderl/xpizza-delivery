'use strict';
/**
 * SDK payments against the REAL RTDB emulator (BRIEF-sdk-payment-coordinator r5 §2, §9):
 *  - the index.js scheduled loops run through their REAL exports and leave an SDK order (and its record) untouched:
 *    sweepStalePending, reconcilePayments, refundReconciler (both passes);
 *  - the coordinator's CAS on `version`, its order-level commit / cancel transactions and the bounded due query on the
 *    real Admin SDK (null-first transactions, real conflicts), with the fake PSP behind the real adapter;
 *  - the status trigger settles exactly once alongside the sweeper;
 *  - the production go-live registration (index.js) reaches the shared materialization through the SDK admission.
 * Run: npm run test:sdk-pay-legacy (destructive: clears the emulator root).
 */
require('./_emulator-required')('database');
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) { console.error('🔴 REFUSED — FIREBASE_DATABASE_EMULATOR_HOST is not set (run via npm run test:sdk-pay-legacy)'); process.exit(1); }

const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();
const C = require('../payments/sdk/coordinator');
const SW = require('../payments/sdk/sweeper');
const { makeAdapter } = require('../payments/sdk/psp-adapter');
const { makeFakePsp } = require('../payments/sdk/fake-adapter');

const OID = 'tb_sdk_emu';
const sdkOrder = (o = {}) => ({ payment_flow: 'sdk_auth_v1', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', restaurant_id: 'tb_rest', order_type: 'delivery', total: 100, total_cents: 10000, created_at: Date.now() - 3 * 3600 * 1000, ...o });
const val = async (p) => (await db.ref(p).once('value')).val();
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const depsWith = (script = {}) => { const fake = makeFakePsp(script); return { fake, deps: { db, psp: makeAdapter(fake.impl), clock: () => Date.now(), voidEligible: () => false, releaseResources: async () => {} } }; };

(async () => {
  // ── the index.js loops leave an SDK order untouched ──
  await db.ref('/').set(null);
  const placedRecord = { flow: 'sdk_auth_v1', version: 3, phase: 'open', committed_revision: 0, fulfillment_total_cents: 10000, created_at: 1, ttl_at: 2,
    legs: { L1: { kind: 'original', amount_cents: 10000, role: 'committed', state: 'approved', pp_uuid: 'P-1', created_at: 1, hold_expires_at: 9e15 } } };
  await db.ref().update({
    [`orders/${OID}`]: sdkOrder({ active_attempt_id: 'a1b2c3d4e5f6a7b8', payment_status: 'manual_reconciliation', resolving_action: 'cancel', resolving_at: 1 }),
    [`payment_sdk/${OID}`]: placedRecord,
    'payment_attempts/a1b2c3d4e5f6a7b8': { order_id: OID, status: 'refund_pending', payment_uuid: 'P-1', reversing_at: 1 },
  });
  const before = JSON.stringify({ o: await val(`orders/${OID}`), r: await val(`payment_sdk/${OID}`) });
  for (const name of ['sweepStalePending', 'reconcilePayments', 'refundReconciler']) {
    await app[name].run({});
    const after = JSON.stringify({ o: await val(`orders/${OID}`), r: await val(`payment_sdk/${OID}`) });
    assert.strictEqual(after, before, `SPLE-LOOPS: ${name} must leave the SDK order and its record untouched`);
    ok(`SPLE-LOOPS ${name} (real export) skips the SDK order`);
  }

  // ── the coordinator on the real Admin SDK ──
  await db.ref('/').set(null);
  await db.ref(`orders/${OID}`).set(sdkOrder({ created_at: Date.now() }));
  const w1 = depsWith();
  const r1 = await C.placeOriginal(w1.deps, { orderId: OID, token: 'T-emu', amount_cents: 10000 });
  assert.strictEqual(r1.outcome, 'placed', `SPLE-PLACE: placed on the real transaction (got ${JSON.stringify(r1)})`);
  assert.ok((await val(`payment_sdk/${OID}/version`)) >= 2 && (await val(`orders/${OID}/payment_placed/leg_id`)) === 'L1', 'SPLE-PLACE: CAS on version + the order decision');
  ok('SPLE-PLACE real CAS + order transaction');
  // two concurrent settlements (trigger + sweeper) → one capture
  await db.ref(`orders/${OID}/status`).set('delivered');
  await Promise.all([C.settleTerminal(w1.deps, { orderId: OID }), C.settleTerminal(w1.deps, { orderId: OID }), SW.sweepSdkPayments(w1.deps)]);
  assert.strictEqual(w1.fake.callCount('capture'), 1, `SPLE-RACE: exactly one capture on real transactions (got ${w1.fake.callCount('capture')})`);
  ok('SPLE-RACE concurrent settle + sweep → one capture');
  // the adjustment loses to a terminal write that lands first
  await db.ref('/').set(null);
  await db.ref(`orders/${OID}`).set(sdkOrder({ created_at: Date.now() }));
  const w2 = depsWith();
  await C.placeOriginal(w2.deps, { orderId: OID, token: 'T-emu', amount_cents: 10000 });
  await db.ref(`orders/${OID}/status`).set('delivered');
  const adj = await C.requestDecrease(w2.deps, { orderId: OID, new_total_cents: 8000 });
  assert.ok(adj.outcome === 'refused' && !(await val(`orders/${OID}/payment_commit`)), `SPLE-ADJUST-AFTER-TERMINAL: refused, nothing committed (got ${JSON.stringify(adj)})`);
  ok('SPLE-ADJUST-AFTER-TERMINAL refused on the real order');
  // cancel wins first, a later terminal write cannot reopen money
  await db.ref('/').set(null);
  await db.ref(`orders/${OID}`).set(sdkOrder({ created_at: Date.now() }));
  const w3 = depsWith();
  await C.placeOriginal(w3.deps, { orderId: OID, token: 'T-emu', amount_cents: 10000 });
  await db.ref(`orders/${OID}/status`).set('preparing');
  const c3 = await C.cancelSdkOrder(w3.deps, { orderId: OID, kind: 'cancel' });
  assert.ok(c3.outcome === 'cancelled' && (await val(`orders/${OID}/payment_cancel/kind`)) === 'cancel', `SPLE-CANCEL: decided on the real order (got ${JSON.stringify(c3)})`);
  await db.ref(`orders/${OID}/status`).set('delivered');
  await C.settleTerminal(w3.deps, { orderId: OID });
  assert.strictEqual(w3.fake.callCount('capture'), 0, 'SPLE-CANCEL: no capture after a committed cancel');
  ok('SPLE-CANCEL decision first; a later terminal write does not reopen money');
  // ruling #9 A: the PRODUCTION go-live (registered by index.js) admits a placed SDK order into the shared materialization,
  // with confirm dependencies that carry no refund capability
  await db.ref('/').set(null);
  await db.ref(`orders/${OID}`).set(sdkOrder({ created_at: Date.now(), items: [{ name: 'tb_item', qty: 1, unit: 100 }], items_text: '1x tb_item', lat: 14.08, lng: -87.19, hub_lat: 14.1, hub_lng: -87.2, address_detected: 'tb calle 1', address_details: 'tb casa', customer_name: 'tb Cliente', customer_phone: '+50499990000', restaurant_name: 'tb R', restaurant_phone: '+50400000000' }));
  const w4 = depsWith(); w4.deps.goLive = require('../payments/sdk/deps').productionDeps(db).goLive;
  const p4 = await C.placeOriginal(w4.deps, { orderId: OID, token: 'T-emu', amount_cents: 10000 });
  const o4 = await val(`orders/${OID}`);
  assert.ok(p4.outcome === 'placed' && ['confirmed', 'manual_reconciliation'].includes(o4.payment_status), `SPLE-GOLIVE: the registered go-live admitted and claimed the placed SDK order (got ${JSON.stringify({ p4, ps: o4.payment_status, st: o4.status })})`);
  assert.ok(!o4.refunding_at && o4.payment_status !== 'refunded' && w4.fake.callCount('capture') === 0 && w4.fake.callCount('void') === 0, 'SPLE-GOLIVE: never refunded, captured or voided by the go-live');
  ok(`SPLE-GOLIVE production wiring → ${o4.payment_status} / ${o4.status}`);
  // the bounded due query on the real database
  await db.ref('/').set(null);
  const due = {}; for (let i = 0; i < 60; i++) due[`tb_due_${String(i).padStart(2, '0')}`] = 1000 + i;
  await db.ref('payment_sdk_due').set(due);
  const page = (await db.ref('payment_sdk_due').orderByValue().endAt(Date.now()).limitToFirst(SW.PAGE).once('value')).val();
  assert.deepStrictEqual(Object.keys(page).sort(), Object.keys(due).slice(0, 50).sort(), 'SPLE-DUE: the real bounded query returns the 50 oldest');
  ok('SPLE-DUE bounded orderByValue page on the real database');
  console.log(`\nsdk-pay legacy + real RTDB (emulator): OK (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
