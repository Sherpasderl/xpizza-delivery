'use strict';
// D4 S4 (PLAN-sdk-d4-r4 S4, W4) — switching method: cancelSdkPending (A1: absent ≡ foreign ≡ non-SDK; a placed order is never
// cancelled; safe_to_switch from durable state, stable once true) + the pending-only cancel (row 8) + the order-deadline expiry for
// a record-less order (rows 8, 11). Run: node payments/sdk/d4-s4.test.js
const assert = require('assert');
const crypto = require('crypto');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const C = require('./coordinator');
const R = require('./record');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const SW = () => require('./switch-endpoint');
const OID = 'tb_switch_1';
const T0 = 1_000_000;
const ATT = 'att_switch_cell_0001';
const NO_SDK = { status: 200, body: { cancelled: false, safe_to_switch: true, reason: 'no_sdk_order' } };
function world({ script = {}, order = {}, contractOnlyStatus = false, extra = {} } = {}) {
  let t = T0;
  const db = makeHonestDb({ orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tb_rest', customer_uid: 'uid_A', customer_name: 'Ana Pérez', pay_deadline_at: T0 + 900000, ...order } }, ...extra }, { now: () => t });
  const fake = makeFakePsp(script, { contractOnlyStatus });
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, releaseResources: async () => {},
    verifyIdToken: async (x) => (x === 'idt_A' ? { uid: 'uid_A' } : x === 'idt_B' ? { uid: 'uid_B' } : (() => { throw new Error('bad'); })()) };
  return { db, fake, deps, tick: (ms) => { t += ms; } };
}
const SWITCH = (w, id = OID, h = { authorization: 'Bearer idt_A' }) => SW().cancelSdkPendingCore(w.deps, { headers: h, body: { order_id: id } });

(async () => {
  await cell('SDK-D4-NO-SDK-ORDER', async (L) => {
    const w = world({ extra: { orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', customer_uid: 'uid_A', pay_deadline_at: T0 + 900000, restaurant_id: 'r' }, ord_cash: { status: 'new', customer_uid: 'uid_A', restaurant_id: 'r' } } } });
    const before = JSON.stringify(w.db.getAt('orders'));
    const absent = await SWITCH(w, 'no_such_order');
    const foreign = await SWITCH(w, OID, { authorization: 'Bearer idt_B' });
    const nonSdk = await SWITCH(w, 'ord_cash');
    assert.deepStrictEqual([absent, foreign, nonSdk], [NO_SDK, NO_SDK, NO_SDK], `${L}: absent ≡ foreign ≡ a non-SDK order ⇒ the identical 200 no_sdk_order (A1)`);
    assert.strictEqual(JSON.stringify(w.db.getAt('orders')), before, `${L}: zero writes`);
    assert.strictEqual(w.db.getAt(`payment_sdk/${OID}`), null, `${L}: no record created for a foreign caller`);
    assert.strictEqual((await SWITCH(w, OID, { authorization: 'Bearer junk' })).status, 401, `${L}: a bad token ⇒ 401 (the usual auth check first)`);
  });

  await cell('SDK-D4-SWITCH-PLACED', async (L) => {
    const w = world();
    await C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: 'T', amount_cents: 100 });
    const r = await SWITCH(w);
    assert.deepStrictEqual(r, { status: 409, body: { error: 'already_placed' } }, `${L}: a placed order ⇒ 409 already_placed (got ${JSON.stringify(r)})`);
    assert.ok(!w.db.getAt(`orders/${OID}/payment_cancel`), `${L}: never cancelled`);
  });

  await cell('SDK-D4-PENDING-ONLY', async (L) => {
    // the pending-only cancel (row 8) refuses an order that is no longer pending, even if the caller raced the placement
    const w = world({ order: { status: 'new', payment_placed: { leg_id: 'L1', at: T0 } } });
    const r = await C.cancelSdkOrder(w.deps, { orderId: OID, kind: 'cancel', pendingOnly: true });
    assert.ok(r.outcome === 'refused' && !w.db.getAt(`orders/${OID}/payment_cancel`), `${L}: pendingOnly never cancels a placed order (got ${JSON.stringify(r)})`);
  });

  await cell('SDK-D4-SWITCH-UNKNOWN-OP', async (L) => {
    // an UNKNOWN answer that carries a uuid (a LOST answer has none ⇒ manual reconciliation, never safe — production behaviour).
    // CONTRACT-ONLY: the bank's later answer is injected as an amount-bearing status (binds the unverified uuid by its amount)
    const w = world({ script: { authorize: [{ outcome: 'unknown', uuid: 'P-u1' }], status: [(a) => ({ state: 'inconclusive', uuid: a.uuid }), (a) => ({ state: 'declined', uuid: a.uuid, amount_cents: 100 })] } });   // the cancel's own reconcile reads inconclusive first
    await C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: 'T', amount_cents: 100 });
    const r1 = await SWITCH(w);
    assert.deepStrictEqual(r1, { status: 200, body: { cancelled: true, safe_to_switch: false } }, `${L}: an unanswered op ⇒ cancelled, NOT safe (got ${JSON.stringify(r1)})`);
    w.tick(C.RECONCILE_AFTER_MS + 1);
    await C.reconcileSdkOps(w.deps, { orderId: OID });
    const r2 = await SWITCH(w);
    assert.deepStrictEqual(r2.body, { cancelled: true, safe_to_switch: true }, `${L}: once the op is answered and nothing is live ⇒ safe (got ${JSON.stringify(r2)})`);
    w.tick(60000);
    assert.deepStrictEqual((await SWITCH(w)).body, { cancelled: true, safe_to_switch: true }, `${L}: safe_to_switch is stable once true`);
  });

  await cell('SDK-D4-W4-PAUSED-PLACEMENT', async (L) => {
    // the switch lands while the first placement is paused after the order commit and BEFORE any record (W4)
    const w = world();
    assert.strictEqual(w.db.getAt(`payment_sdk/${OID}`), null, `${L}: premise — no record`);
    const r = await SWITCH(w);
    assert.deepStrictEqual(r.body, { cancelled: true, safe_to_switch: true }, `${L}: an owned SDK order with no record goes through the cancel (never no_sdk_order) (got ${JSON.stringify(r)})`);
    assert.strictEqual(w.db.getAt(`payment_sdk/${OID}/phase`), 'cancelled', `${L}: the cancel created the FENCE record`);
    const p = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: 'T', amount_cents: 100 });
    assert.ok(p.outcome === 'refused' && w.fake.callCount('authorize') === 0, `${L}: the resumed placement makes ZERO PSP calls after the switch (got ${JSON.stringify(p)})`);
  });

  await cell('SDK-D4-W4-JOURNALED-FIRST', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = world({ script: { authorize: [{ pause: gate }] } });
    const placing = C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: 'T', amount_cents: 100 });
    await new Promise((r) => setTimeout(r, 20));
    const r = await SWITCH(w);
    assert.deepStrictEqual(r.body, { cancelled: true, safe_to_switch: false }, `${L}: the auth journaled before the switch ⇒ NOT safe while it is in flight (got ${JSON.stringify(r)})`);
    release(); await placing;
  });

  await cell('SDK-D4-SWITCH-RELEASES-SUBJECT', async (L) => {
    const w = world({ extra: { sdk_checkout_subject: { u_uid_A: { order_id: OID, at: T0 } } } });
    await SWITCH(w);
    assert.strictEqual(w.db.getAt('sdk_checkout_subject/u_uid_A'), null, `${L}: a safe switch releases the C6 subject`);
  });

  await cell('SDK-D4-EXPIRE-ORDER-DEADLINE', async (L) => {
    // row 8 / row 11: a pending SDK order with NO record expires on the ORDER's pay_deadline_at
    const w = world();
    const early = await C.cancelSdkOrder(w.deps, { orderId: OID, kind: 'expire' });
    assert.ok(early.outcome === 'refused' && !w.db.getAt(`orders/${OID}/payment_cancel`), `${L}: before the deadline ⇒ not expired`);
    w.tick(900000);
    await require('./sweeper').visitDueOrder(w.deps, OID);
    assert.strictEqual(w.db.getAt(`orders/${OID}/payment_cancel/kind`), 'expire', `${L}: the sweeper expires a record-less orphan at the order's deadline`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-s4: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
