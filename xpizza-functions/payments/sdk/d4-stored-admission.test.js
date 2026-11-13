'use strict';
// D4 post-merge (asm7 HIGH gate P1, advisor 2026-11-12) — finishSdk admits a REUSED order's STORED delivery facts with Envío's ONE resume
// guard (delivery/zone-resume.js deliveryResumeRefusal) BEFORE enrol, the subject claim and any dispatch; a create-once reuse of an order
// the first read did not see (a concurrent same-owner create) is admitted after the txn, still before the claim / dispatch (the race
// backstop). The SDK order comes from the REAL writer (finishSdk's create-once), the pricing node from Envío's REAL writer
// (setDeliveryPricingCore), the guard is the REAL one. Run: node payments/sdk/d4-stored-admission.test.js
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const { fakeRtdb } = require('../../test/_fake-rtdb-sdk');
const A = require('../../delivery/pricing-admin-core');
const DW = require('../../delivery/delivery-wire');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const FIN = () => require('./finish');
const T0 = 1_000_000;
const OID = 'tb_sa_1';
const RID = 'tb_r1';
const HUB = { lat: 15.5, lng: -88.0 };
const north = (km) => ({ lat: +(HUB.lat + km / 111.195).toFixed(6), lng: HUB.lng });
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9.5, cents: 7000 }];
const NEW_CARD = { kind: 'new', sdk_token: 'tok_new', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } };
const NO_FLAGS = { controlRefuseFresh: false, menuRefuseFresh: false, choiceRefuseFresh: false, extrasRefuseFresh: null, cartBlocked: [], refuseFresh: false, payerRefuseFresh: false };
// the pending record hosted builds for an app delivery (index.js: DW.orderFields + lat/lng + hubSnapshot) — written by finishSdk's create-once
const pending = (km, o = {}) => ({ order_id: OID, restaurant_id: RID, status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'delivery',
  customer_name: 'Ana Pérez', customer_phone: '+50499990000', customer_uid: 'uid_A', items_text: '1x Pizza', total: 150, total_cents: 15000, subtotal_cents: 8696, tax_cents: 1304,
  lat: north(km).lat, lng: north(km).lng, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_cents: 5000, promo_discount_cents: 0,
  delivery_snapshot: { mode: 'delivery', policy_version: 1, km, band: 1, promo: null }, created_at: T0, ...o });

// the pricing node, from Envío's REAL writer (a limit of `limitKm` for RID, or none)
let AT = 1762800000000;
async function pricingNode(limitKm) {
  const db = fakeRtdb({ platform_admins: { tbowner: true }, restaurants: { [RID]: { identity: { name: 'TB', hub_lat: HUB.lat, hub_lng: HUB.lng } } } }, { strict: true });
  const deps = { db, verifyIdToken: async () => ({ uid: 'tbowner' }), timestamp: () => ++AT, readRegistry: async () => ({ ok: true, fresh: true, ids: [RID] }) };
  const req = { get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer admin' : null), body: { expected_policy_version: 0, bands: BANDS, ...(limitKm == null ? {} : { limits: [{ rid: RID, km: limitKm }] }) } };
  assert.strictEqual((await A.setDeliveryPricingCore(deps, req)).status, 200, 'premise: the real pricing writer saved the node');
  return JSON.parse(JSON.stringify(db.root.platform_config.delivery_pricing));
}

function world({ seed = {}, script = {}, hooks = {} } = {}) {
  const t = T0;
  const db = makeHonestDb({ platform_config: { sdk_pay: { available: true, restaurants: { [RID]: true } } }, ...seed }, { now: () => t, ...hooks });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: () => false, ppNamespace: 'sandbox', releaseResources: async () => {}, goLive: async () => {} };
  const guardCalls = [];
  // production's injection (index.js B4): the REAL guard with the request's ONE pricing read
  const deliveryResume = (o) => { guardCalls.push(o && o.order_id); return DW.deliveryResumeRefusal(db, o, DW.loadPricing(db)); };
  return { db, fake, deps, guardCalls, deliveryResume };
}
const ctx = (w, o = {}) => ({ orderId: OID, kind: 'member', uid: 'uid_A', guestPhoneHash: null, attemptId: 'att_sa_cell_000000001', card: NEW_CARD, replacesOrderId: null,
  pendingOrderRecord: pending(5), fingerprint: 'fp_cart_1', tipCents: 0, flags: NO_FLAGS, nowTs: T0,
  runGate: async () => ({ refuse: null, provenance: null }), answerRefusal: (r) => ({ status: 'REFUSAL', body: r }), deliveryResume: w.deliveryResume, ...o });
const FINISH = (w, o) => FIN().finishSdk(w.deps, ctx(w, o));
const snap = (w) => JSON.stringify(w.db.root);
// an existing SDK order, written by the REAL create-once (attempt 1 declined), then the restaurant's limit set by the REAL pricing writer
async function existingOrder(km, limitKm, { pendingOver = {} } = {}) {
  const w = world({ script: { authorize: [{ outcome: 'definitive_decline', code: '05' }] } });
  w.db.setAt('platform_config/delivery_pricing', await pricingNode(null));
  const first = await FINISH(w, { attemptId: 'att_sa_first_0000001', pendingOrderRecord: pending(km, pendingOver) });
  assert.ok(first.body && first.body.outcome === 'declined', `premise: attempt 1 created the SDK order and was declined (${JSON.stringify(first.body)})`);
  w.db.setAt('platform_config/delivery_pricing', await pricingNode(limitKm));
  return w;
}

(async () => {
  await cell('SDK-D4-SA-BEYOND-LIMIT', async (L) => {
    // Codex asm7 P1 reproduction: the stored pin is now beyond the lowered effective limit ⇒ refused BEFORE any write / claim / dispatch
    const w = await existingOrder(5, 4);
    const before = snap(w); const auths = w.fake.callCount('authorize');
    const r = await FINISH(w);
    assert.deepStrictEqual(r, { status: 409, body: { error: 'outside_delivery_bands', order_id: OID } }, `${L}: Envío's refusal contract (${JSON.stringify(r)})`);
    assert.strictEqual(snap(w), before, `${L}: ZERO writes (no payment_sdk_due, no attempt, no subject)`);
    assert.strictEqual(w.fake.callCount('authorize'), auths, `${L}: ZERO authorizations`);
  });

  await cell('SDK-D4-SA-MISSING-HUB', async (L) => {
    const w = await existingOrder(3, 4, { pendingOver: { hub_lat: null, hub_lng: null } });
    const before = snap(w); const auths = w.fake.callCount('authorize');
    const r = await FINISH(w, { pendingOrderRecord: pending(3, { hub_lat: null, hub_lng: null }) });
    assert.deepStrictEqual(r, { status: 409, body: { error: 'order_context_changed', order_id: OID } }, `${L}: a stored order with no hub snapshot fails CLOSED (${JSON.stringify(r)})`);
    assert.ok(snap(w) === before && w.fake.callCount('authorize') === auths, `${L}: zero writes, zero authorizations`);
  });

  await cell('SDK-D4-SA-PRICING-UNAVAILABLE', async (L) => {
    const w = await existingOrder(3, 4);
    const failing = { ref: (p) => (p === 'platform_config/delivery_pricing' ? { get: async () => { throw new Error('UNAVAILABLE'); } } : w.db.ref(p)) };
    const before = snap(w); const auths = w.fake.callCount('authorize');
    const r = await FINISH(w, { deliveryResume: (o) => DW.deliveryResumeRefusal(failing, o, DW.loadPricing(failing)) });
    assert.deepStrictEqual(r, { status: 503, body: { error: 'delivery_pricing_unavailable', retryable: true, order_id: OID } }, `${L}: a pricing read failure ⇒ 503 retryable (${JSON.stringify(r)})`);
    assert.ok(snap(w) === before && w.fake.callCount('authorize') === auths, `${L}: zero writes, zero authorizations`);
  });

  await cell('SDK-D4-SA-IN-RANGE', async (L) => {
    const w = await existingOrder(3, 4);
    const auths = w.fake.callCount('authorize');
    const r = await FINISH(w);
    assert.ok(w.guardCalls.includes(OID), `${L}: the stored order WAS admitted by the guard`);
    assert.strictEqual(w.fake.callCount('authorize'), auths + 1, `${L}: inside the limit ⇒ the new attempt proceeds (${JSON.stringify(r.body)})`);
  });

  await cell('SDK-D4-SA-FRESH-ORDER', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved' }] } });
    w.db.setAt('platform_config/delivery_pricing', await pricingNode(4));
    const r = await FINISH(w, { pendingOrderRecord: pending(3) });
    assert.deepStrictEqual(w.guardCalls, [], `${L}: a FRESH order (stamped from the current hub by this request) never calls the guard`);
    assert.ok(r.status === 200 && ['placed', 'bank_pending'].includes(r.body.outcome) && w.fake.callCount('authorize') === 1, `${L}: and proceeds to the authorization (${JSON.stringify(r.body)})`);
  });

  await cell('SDK-D4-SA-RACE-BACKSTOP', async (L) => {
    // the first read sees no order; a concurrent same-owner create (beyond the limit) lands before the create-once txn ⇒ the txn REUSES
    // it ⇒ admitted after the txn, BEFORE the subject claim and any dispatch; the only write is enrol's sweeper due entry (C4)
    const src = await existingOrder(5, 4);
    const raced = src.db.getAt(`orders/${OID}`);
    let landed = false;
    const w = world({ script: { authorize: [{ outcome: 'approved' }] }, hooks: { beforeTx: async (p, api) => { if (p === `orders/${OID}` && !landed) { landed = true; w.db.setAt(`orders/${OID}`, raced); } } } });
    w.db.setAt('platform_config/delivery_pricing', src.db.getAt('platform_config/delivery_pricing'));
    const r = await FINISH(w);
    assert.ok(landed, `${L}: premise — the concurrent create landed between the read and the txn`);
    assert.deepStrictEqual(r, { status: 409, body: { error: 'outside_delivery_bands', order_id: OID } }, `${L}: refused (${JSON.stringify(r)})`);
    assert.strictEqual(w.fake.callCount('authorize'), 0, `${L}: ZERO authorizations`);
    assert.ok(w.db.getAt('sdk_checkout_subject') == null, `${L}: no subject claimed`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.db.getAt(`orders/${OID}`))), JSON.parse(JSON.stringify(raced)), `${L}: the raced order is untouched`);
  });

  await cell('SDK-D4-SA-REQUIRED', async (L) => {
    const w = world();
    await assert.rejects(() => FINISH(w, { deliveryResume: undefined }), /deliveryResume is required/, `${L}: no injected guard ⇒ throws (never silently unguarded)`);
    assert.ok(w.db.getAt('payment_sdk_due') == null, `${L}: before any write`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-stored-admission: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
