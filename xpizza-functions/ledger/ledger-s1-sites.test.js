'use strict';
// LEDGER S1 (PLAN-5f-ledger-shadow-s1-r3 §1) — the CARD sites, through the REAL writers over the honest RTDB model (_honest-rtdb-model:
// Firebase-valid values only, real transactions): the hosted snapshot rides the EXCLUSIVE payment_attempts claim
// (pixelpay-hosted-charge.js acquireHostedAttempt), the SDK snapshot rides the payment_sdk record create (payments/sdk/coordinator.js
// placeOriginal), both create-once. The cash sites (the order's own multi-path update) run on the emulator: test/ledger-s1.emulator.
// Run: node ledger/ledger-s1-sites.test.js
const assert = require('assert');
const { makeHonestDb } = require('../_honest-rtdb-model');
const LA = require('./alloc-snapshot');
const HC = require('../pixelpay-hosted-charge');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
async function cell(label, fn) { try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }

// created_at = ServerValue.TIMESTAMP, exactly as chargeOnlineOrder's pendingOrderRecord (index.js:1981) — Codex #110
const PENDING = { order_id: 'tb_o1', restaurant_id: 'tb_rest', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'pickup',
  created_at: require('firebase-admin/database').ServerValue.TIMESTAMP, total_cents: 10000, subtotal_cents: 8696, tax_cents: 1304 };
const acquire = (db, snap, k = { n: 0 }) => HC.acquireHostedAttempt(db, 'tb_o1', PENDING, 'fp1', 1000, [], () => `aid${++k.n}`, () => 'tok',
  null, false, false, false, false, null, null, 0, false, null, snap);
const attempts = (db) => db.getAt('payment_attempts') || {};
// RTDB stores no null leaf (and drops an object left empty): what a write of the snapshot STORES — the projector reads absent as null
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return o; };

(async () => {
  await cell('S1-HOSTED: the snapshot rides the EXCLUSIVE payment_attempts claim, equal to snapshotOf(the pending record, the request mode)', async () => {
    const db = makeHonestDb({}, { now: () => 5 });
    const snap = LA.snapshotOf(PENDING, LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: { app: 'capp', deployment: 'orders-app' } }));
    const out = await acquire(db, snap);
    assert.strictEqual(out.outcome, 'claimed', JSON.stringify(out));
    const a = attempts(db)[out.attempt_id];
    const orderAt = db.getAt('orders/tb_o1/created_at');
    assert.ok(Number.isSafeInteger(orderAt) && orderAt > 0, 'premise: the order\'s created_at resolved to a number');
    assert.deepStrictEqual(a.ledger, stored({ ...snap, created_at: orderAt }), '🔴 S1-HOSTED: the claimed attempt carries the snapshot with the COMMITTED order time (as RTDB stores it)');
    assert.deepStrictEqual([a.ledger.mode, a.ledger.total_cents, a.ledger.order_type], ['app', 10000, 'pickup']);
    assert.strictEqual(db.getAt('orders/tb_o1/ledger'), null, '🔴 S1-HOSTED: never on the dispatcher-writable order');
  });

  await cell('S1-HOSTED-ABSENT: a caller that passes no snapshot (older callers / tests) writes the claim exactly as before — no `ledger` key', async () => {
    const db = makeHonestDb({}, { now: () => 5 });
    const out = await acquire(db, undefined);
    assert.strictEqual(out.outcome, 'claimed');
    assert.ok(!('ledger' in attempts(db)[out.attempt_id]), '🔴 S1-HOSTED-ABSENT');
  });

  await cell('S1-HOSTED-ONCE: a re-run that finds the claim taken never rewrites it (the claim is create-once)', async () => {
    const db = makeHonestDb({}, { now: () => 5 });
    const k = { n: 0 };
    const first = LA.snapshotOf(PENDING, LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: {} }));
    const out = await acquire(db, first, k);
    const other = LA.snapshotOf({ ...PENDING, total_cents: 1 }, LA.modeOf({ body: {}, clientHdr: {} }));
    await acquire(db, other, { n: 0 });   // the same attempt id is generated again → the claim exists → aborts / re-reads
    assert.deepStrictEqual(attempts(db)[out.attempt_id].ledger, stored({ ...first, created_at: db.getAt('orders/tb_o1/created_at') }), '🔴 S1-HOSTED-ONCE: the first snapshot stands');
  });

  await cell('S1-SDK: the snapshot (mode sdk, trusted) rides the payment_sdk record create through the REAL placeOriginal', async () => {
    const { makeAdapter } = require('../payments/sdk/psp-adapter');
    const { makeFakePsp } = require('../payments/sdk/fake-adapter');
    const OID = 'tb_sdk_1';
    const order = { restaurant_id: 'tb_rest', payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'delivery',
      hub_lat: 14.1, hub_lng: -87.2, items: [{ name: 'tb_item', qty: 1, unit: 100 }], total_cents: 10000, subtotal_cents: 7000, tax_cents: 0, delivery_cents: 3000, created_at: 900 };
    let t = 100000;
    const db = makeHonestDb({ orders: { [OID]: order } }, { now: () => t });
    const fake = makeFakePsp({}, {});
    const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: () => false, releaseResources: async () => {}, goLive: async () => ({ ok: true }) };
    await require('../payments/sdk/coordinator').placeOriginal(deps, { attempt_id: 'att_fixed_l00001', orderId: OID, token: 'T-tb', amount_cents: 10000 });
    const rec = db.getAt(`payment_sdk/${OID}`);
    assert.deepStrictEqual(rec.ledger, stored(LA.snapshotOf(order, LA.modeOf({ sdk: true, clientHdr: { app: null, deployment: 'orders-app' } }))), '🔴 S1-SDK: the record carries the snapshot (as RTDB stores it)');
    assert.deepStrictEqual([rec.ledger.mode, rec.ledger.mismatch, rec.ledger.envio.delivery_cents, rec.ledger.evidence.client_deployment], ['sdk', false, 3000, 'orders-app']);
  });
  console.log(`ledger-s1-sites: OK (${n})`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
