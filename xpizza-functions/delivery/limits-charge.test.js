'use strict';
// ENVÍO restaurant limit — the CHARGE path's resume guards (PLAN-envio-restaurant-limit-r5 §2.3 / §2.4), unit level: the acquire's
// reuseGuard (outcome 'delivery_refused'), the hosted flow's interception before the generic fallback (owned hold only, own stamps
// removed), the stamp compensation, and chargeOnlineOrder's pre-bookkeeping check on both dq routes. The stored nodes come from the
// REAL writer (setDeliveryPricingCore) and the real acquire; the emulator half (the full write trace) is test/envlim.emulator.test.js.
// Run: node delivery/limits-charge.test.js
const assert = require('assert');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const A = require('./pricing-admin-core');
const DW = require('./delivery-wire');
const { acquireHostedAttempt } = require('../pixelpay-hosted-charge');
const { resolveHostedAttemptAction } = require('../hosted-charge-flow');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const PATH = 'platform_config/delivery_pricing';
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9.5, cents: 7000 }];
const HUB = { lat: 15.5, lng: -88.0 };
const north = (km) => ({ lat: +(HUB.lat + km / 111.195).toFixed(6), lng: HUB.lng });
const req = (body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer admin' : null), body });
let AT = 1762800000000;
const NOW = 1_800_000_000_000;
function world(init = {}) {
  const db = fakeRtdb({ platform_admins: { tbowner: true }, restaurants: { tb_r1: { identity: { name: 'TB', hub_lat: HUB.lat, hub_lng: HUB.lng } } }, ...init }, { strict: true });
  const deps = { db, verifyIdToken: async () => ({ uid: 'tbowner' }), timestamp: () => ++AT, readRegistry: async () => ({ ok: true, fresh: true, ids: ['tb_r1'] }) };
  // the order path reads with ref(p).get(); the acquire with ref(p).once() / transaction — one store
  const both = { ref: (p) => { const r = db.ref(p); return { ...r, get: () => r.once() }; } };
  return { db, deps, both, set: (b) => A.setDeliveryPricingCore(deps, req(b)) };
}
const liveOrder = (km) => ({ order_id: 'O1', restaurant_id: 'tb_r1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'delivery',
  lat: north(km).lat, lng: north(km).lng, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_cents: 5000, promo_discount_cents: 0,
  delivery_snapshot: { mode: 'delivery', policy_version: 1, km, band: 1, promo: null }, active_attempt_id: 'AT1', payment_fingerprint: 'fp' });
const liveAttempt = { hosted_state: 'created', hosted_expires_at: NOW + 600000, hosted_checkout_url: 'https://pay.example/c', poll_token: 'tok' };
async function limitedWorld(km) {
  const w = world({ orders: { O1: liveOrder(km) }, payment_attempts: { AT1: liveAttempt } });
  assert.strictEqual((await w.set({ expected_policy_version: 0, bands: BANDS, limits: [{ rid: 'tb_r1', km: 4 }] })).status, 200, 'premise: the real writer saved the limit');
  return w;
}

(async () => {
  await cell('ACQUIRE-REUSE-GUARD', async (L) => {
    const w = await limitedWorld(5);
    const guard = (o) => DW.deliveryResumeRefusal(w.both, o, DW.loadPricing(w.both));
    const before = JSON.stringify(w.db.root.orders) + JSON.stringify(w.db.root.payment_attempts);
    const r = await acquireHostedAttempt(w.db, 'O1', liveOrder(5), 'fp', NOW, [], undefined, undefined, null, false, false, false, false, null, null, 0, false, guard);
    assert.deepStrictEqual(r, { outcome: 'delivery_refused', refusal: { refusal: 'outside_delivery_bands', httpStatus: 409 } }, `${L}: a live checkout beyond the lowered limit is NOT reused`);
    assert.strictEqual(JSON.stringify(w.db.root.orders) + JSON.stringify(w.db.root.payment_attempts), before, `${L}: the order and the attempt are unchanged`);
    const inside = await limitedWorld(3);
    const ok = await acquireHostedAttempt(inside.db, 'O1', liveOrder(3), 'fp', NOW, [], undefined, undefined, null, false, false, false, false, null, null, 0, false, (o) => DW.deliveryResumeRefusal(inside.both, o, DW.loadPricing(inside.both)));
    assert.strictEqual(ok.outcome, 'reuse', `${L}: inside the limit → reuse as today`);
    const noGuard = await acquireHostedAttempt(w.db, 'O1', liveOrder(5), 'fp', NOW, []);
    assert.strictEqual(noGuard.outcome, 'reuse', `${L}: no guard passed (every other caller) → today's reuse`);
  });

  await cell('FLOW-DELIVERY-REFUSED', async (L) => {
    const calls = [];
    const opts = (acq) => ({ acq, orderId: 'O1', totalCents: 1000, log: { log() {} },
      releaseHold: async () => calls.push('release'), retireAttempt: async () => calls.push('retire'), runGate: async () => { calls.push('gate'); return {}; }, dropOwnStamps: async () => calls.push('stamps') });
    const d = await resolveHostedAttemptAction(opts({ outcome: 'delivery_refused', refusal: { refusal: 'outside_delivery_bands', httpStatus: 409 } }));
    assert.deepStrictEqual(d, { respond: { status: 409, body: { error: 'outside_delivery_bands', order_id: 'O1' } } }, `${L}: answered as the fresh refusal (never the generic 503, m25)`);
    assert.deepStrictEqual(calls, ['release', 'stamps'], `${L}: the OWNED-only release and the own-stamp removal; no gate, no retire`);
    calls.length = 0;
    const d5 = await resolveHostedAttemptAction(opts({ outcome: 'delivery_refused', refusal: { refusal: 'delivery_pricing_unavailable', httpStatus: 503 } }));
    assert.deepStrictEqual(d5.respond, { status: 503, body: { error: 'delivery_pricing_unavailable', retryable: true, order_id: 'O1' } }, `${L}: a 503 refusal stays retryable`);
  });

  await cell('DROP-OWN-STAMPS', async (L) => {
    const w = world({ recent_order_content: { ph: { ck1: { at: 1, order_id: 'O1', payment_method: 'online' }, a8: { at: 2, order_id: 'O1', payment_method: 'online' }, other: { at: 3, order_id: 'O2', payment_method: 'online' } } } });
    await DW.dropOwnStamps(w.db, 'ph', 'O1');
    assert.deepStrictEqual(w.db.get('recent_order_content/ph'), { other: { at: 3, order_id: 'O2', payment_method: 'online' } }, `${L}: both stamps naming O1 (bookkeeping + A8) removed; O2's untouched (m28, m29)`);
    await DW.dropOwnStamps(w.db, null, 'O1');
    assert.ok(true);
  });

  await cell('PRE-BOOKKEEPING', async (L) => {
    const w = await limitedWorld(5);
    const dpP = DW.loadPricing(w.both);
    assert.deepStrictEqual(await DW.preBookkeepingRefusal(w.both, 'O1', null, dpP), { refusal: 'outside_delivery_bands', httpStatus: 409 }, `${L}: null-dq route — ONE order read, refused (m15)`);
    assert.strictEqual(await DW.preBookkeepingRefusal(w.both, 'O_NEW', null, dpP), null, `${L}: a first attempt (no order) → null`);
    const dq = await DW.chargeContext(w.both, 'O1', { ctx: null }, { order_type: 'delivery' }, NOW, dpP);
    assert.deepStrictEqual(await DW.preBookkeepingRefusal(w.both, 'O1', dq, dpP), { refusal: 'outside_delivery_bands', httpStatus: 409, resume: true }, `${L}: dq route — chargeContext's guarded return answers here`);
    assert.strictEqual(await DW.preBookkeepingRefusal(w.both, 'O1', { refusal: 'pin_required', httpStatus: 409 }, dpP), null, `${L}: a FRESH refusal keeps today's gate placement`);
    let reads = 0; const counting = { ref: (p) => { reads++; return w.both.ref(p); } };
    await DW.preBookkeepingRefusal(counting, 'O1', dq, dpP);
    assert.strictEqual(reads, 0, `${L}: the dq route re-reads nothing`);
  });

  if (fails.length) { console.log(`limits-charge FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`limits-charge: OK (${n})`);
})();
