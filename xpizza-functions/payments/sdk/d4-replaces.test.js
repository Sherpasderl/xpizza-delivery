'use strict';
// D4 S4 / S7 (c) (PLAN §S4, CONTRACT §2.2, A2) — ONE replaces rule, shared by the SDK finish (B4) and createOrder: a
// replaces_order_id naming the CALLER's own SDK order requires that order to be placed or safe_to_switch, else 409
// previous_payment_unresolved; anything else (absent / foreign / non-SDK / the request's own id) is IGNORED — nothing about the
// named order is revealed or changed. The safe_to_switch state comes from the REAL switch (cancelSdkPending).
// Run: node payments/sdk/d4-replaces.test.js
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const RP = () => require('./replaces');
const T0 = 1_000_000;
const PREV = 'sdk_261112-101500-PREVAAAA';
const UNRESOLVED = { status: 409, body: { error: 'previous_payment_unresolved' } };
const sdkOrder = (o = {}) => ({ payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tb_rest', customer_uid: 'uid_A', total_cents: 10000, pay_deadline_at: T0 + 9e5, ...o });
function world(prev) {
  const t = T0;
  const db = makeHonestDb(prev === undefined ? {} : { orders: { [PREV]: prev } }, { now: () => t });
  return { db, deps: { db, psp: makeAdapter(makeFakePsp({}).impl), clock: () => t, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, releaseResources: async () => {},
    verifyIdToken: async (x) => (x === 'idt_A' ? { uid: 'uid_A' } : (() => { throw new Error('bad'); })()) } };
}
const ASK = (w, o = {}) => RP().replacesRefusal(w.deps, { orderId: 'sdk_new_order_1', replacesOrderId: PREV, uid: 'uid_A', pendingOrderRecord: null, ...o });

(async () => {
  await cell('SDK-D4-REPLACES-UNRESOLVED', async (L) => {
    const w = world(sdkOrder()); const before = JSON.stringify(w.db.root);
    assert.deepStrictEqual(await ASK(w), UNRESOLVED, `${L}: the caller's own UNRESOLVED SDK order ⇒ 409`);
    assert.strictEqual(JSON.stringify(w.db.root), before, `${L}: nothing written`);
  });
  await cell('SDK-D4-REPLACES-RESOLVED', async (L) => {
    assert.strictEqual(await ASK(world(sdkOrder({ status: 'new', payment_placed: { leg_id: 'L1', at: T0 } }))), null, `${L}: a PLACED order ⇒ admitted`);
    const w = world(sdkOrder());
    const sw = await require('./switch-endpoint').cancelSdkPendingCore(w.deps, { headers: { authorization: 'Bearer idt_A' }, body: { order_id: PREV } });
    assert.ok(sw.body && sw.body.safe_to_switch === true, `${L}: premise — the REAL switch made it safe_to_switch (${JSON.stringify(sw)})`);
    assert.strictEqual(await ASK(w), null, `${L}: a safe_to_switch order ⇒ admitted`);
  });
  await cell('SDK-D4-REPLACES-IGNORED', async (L) => {
    for (const [label, prev, o] of [['absent', undefined, {}], ['another member\'s', sdkOrder({ customer_uid: 'uid_B' }), {}], ['non-SDK', { ...sdkOrder(), payment_flow: undefined }, {}],
      ['the request\'s own id', sdkOrder(), { orderId: PREV }], ['no replaces_order_id', sdkOrder(), { replacesOrderId: null }], ['no caller identity', sdkOrder(), { uid: null }]]) {
      const w = world(prev); const before = JSON.stringify(w.db.root);
      assert.strictEqual(await ASK(w, o), null, `${L}: ${label} ⇒ ignored (A2)`);
      assert.strictEqual(JSON.stringify(w.db.root), before, `${L}: ${label}: nothing written`);
    }
  });
  await cell('SDK-D4-REPLACES-GUEST', async (L) => {
    // a guest (the SDK finish): the order is the caller's when its verified phone is the pending record's — and never a member's
    const gv = { phone: '50499990000', phone_hash: 'h_me' };
    const pending = { guest_verified: gv };
    assert.deepStrictEqual(await ASK(world(sdkOrder({ customer_uid: undefined, guest_verified: gv })), { uid: null, pendingOrderRecord: pending }), UNRESOLVED, `${L}: the guest's own unresolved order ⇒ 409`);
    assert.strictEqual(await ASK(world(sdkOrder({ customer_uid: undefined, guest_verified: { ...gv, phone_hash: 'h_other' } })), { uid: null, pendingOrderRecord: pending }), null, `${L}: another guest's ⇒ ignored`);
    assert.strictEqual(await ASK(world(sdkOrder({ guest_verified: gv })), { uid: null, pendingOrderRecord: pending }), null, `${L}: a member's (claimed) order ⇒ ignored for a guest`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-replaces: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
