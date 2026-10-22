'use strict';
// S3a — envío, pure core + the order-path seam (no I/O beyond an injected fake db). Run: node delivery/delivery-pricing.test.js
// The emulator suite (test/s3a-envio.emulator.test.js) drives the REAL handlers; this file pins the decisions.
const assert = require('assert');
const P = require('./delivery-pricing');
const DW = require('./delivery-wire');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  const HUB = { lat: 14.1, lng: -87.2 };
  const north = (km) => ({ lat: HUB.lat + km / 111.195, lng: HUB.lng });       // 1° latitude ≈ 111.195 km on the 6371 km sphere
  // PLACEHOLDER bands (tests only — the real values are an owner input before activation)
  const RAW = { policy_version: 3, bands: [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }, { max_km: 8, cents: 7000 }], restaurants: { r1: { active: true, free_delivery: false }, r2: { active: false, free_delivery: true }, r3: { active: true, free_delivery: true } } };

  // ── the distance ──
  assert.ok(Math.abs(P.haversineKm(HUB.lat, HUB.lng, north(1).lat, north(1).lng) - 1) < 1e-6);
  assert.ok(Math.abs(P.haversineKm(15.5003, -88.025, 15.5075, -88.0398) - 1.774) < 0.01, 'a real San Pedro Sula pair, straight line');
  ok('haversine: straight-line km on the 6371 km sphere');

  // ── config → dark / active / invalid ──
  for (const raw of [null, undefined, {}, { ...RAW, restaurants: {} }]) assert.strictEqual(P.readPricing(raw, 'r1'), null, 'absent → dark');
  assert.strictEqual(P.readPricing(RAW, 'r2'), null, 'restaurant active:false → dark (even with free_delivery set)');
  assert.strictEqual(P.readPricing(RAW, 'nope'), null, 'unlisted restaurant → dark');
  assert.deepStrictEqual(P.readPricing(RAW, 'r1'), { policy_version: 3, bands: RAW.bands, free_delivery: false });
  assert.deepStrictEqual(P.readPricing({ ...RAW, bands: { 0: RAW.bands[0], 1: RAW.bands[1] } }, 'r1').bands, RAW.bands.slice(0, 2), 'RTDB array-as-object bands');
  for (const bad of [{ bands: [] }, { bands: [{ max_km: 2, cents: 3000 }, { max_km: 2, cents: 5000 }] }, { bands: [{ max_km: 5, cents: 3000 }, { max_km: 2, cents: 5000 }] },
    { bands: [{ max_km: 2, cents: 30.5 }] }, { bands: [{ max_km: 2, cents: -1 }] }, { bands: [{ max_km: 0, cents: 1 }] }, { policy_version: 0 }, { policy_version: '3' }]) {
    assert.deepStrictEqual(P.readPricing({ ...RAW, ...bad }, 'r1'), { invalid: true }, `invalid config ${JSON.stringify(bad)} → invalid (refused, never free)`);
  }
  ok('config: absent / restaurant not active / unlisted → DARK; empty, non-ascending, fractional or negative bands, bad policy_version → INVALID (refused)');

  // ── the envío for one request ──
  const pr = P.readPricing(RAW, 'r1');
  const q = (o) => P.quoteDelivery({ pricing: pr, hub: HUB, mode: 'delivery', pin: { ...north(1), confirmed: true }, customerUid: null, ...o });
  assert.deepStrictEqual(q({}).ctx, { mode: 'delivery', delivery_cents: 3000, promo_discount_cents: 0, policy_version: 3, km: 1, band: 0, promo: null });
  assert.strictEqual(q({ pin: { ...north(2), confirmed: true } }).ctx.delivery_cents, 3000, 'exactly max_km → that band (inclusive)');
  assert.strictEqual(q({ pin: { ...north(2.001), confirmed: true } }).ctx.delivery_cents, 5000, 'just past → the next band');
  assert.strictEqual(q({ pin: { ...north(7.9), confirmed: true } }).ctx.band, 2);
  assert.deepStrictEqual(q({ pin: { ...north(8.01), confirmed: true } }), { refusal: 'outside_delivery_bands' }, 'beyond the last band → refused, never free');
  assert.deepStrictEqual(q({ mode: 'pickup', pin: null }).ctx, { mode: 'pickup', delivery_cents: 0, promo_discount_cents: 0, policy_version: 3 }, 'pickup → 0, no pin needed');
  for (const mode of [undefined, null, '', 'Delivery', 'dine_in']) assert.deepStrictEqual(q({ mode }), { refusal: 'mode_required' }, `mode ${mode} → refused (omitted context is never legacy-free)`);
  for (const pin of [null, { ...north(1) }, { ...north(1), confirmed: 'true' }, { lat: NaN, lng: -87.2, confirmed: true }, { lat: 91, lng: 0, confirmed: true }, { lat: 14, lng: 181, confirmed: true }]) {
    assert.deepStrictEqual(q({ pin }), { refusal: 'pin_required' }, `pin ${JSON.stringify(pin)} → refused`);
  }
  assert.deepStrictEqual(q({ hub: { lat: undefined, lng: -87 } }), { refusal: 'delivery_pricing_invalid' }, 'a hub without coordinates → refused');
  assert.deepStrictEqual(P.quoteDelivery({ pricing: { invalid: true }, hub: HUB, mode: 'pickup' }), { refusal: 'delivery_pricing_invalid' }, 'invalid config refuses even pickup');
  ok('envío: inclusive bands by straight-line km; pickup 0; no/odd mode, unconfirmed or invalid pin, beyond the bands, invalid config → refused');

  // ── the promo: account only, envío only ──
  const p3 = P.readPricing(RAW, 'r3');
  const prom = (uid) => P.quoteDelivery({ pricing: p3, hub: HUB, mode: 'delivery', pin: { ...north(3), confirmed: true }, customerUid: uid }).ctx;
  assert.deepStrictEqual([prom('u1').delivery_cents, prom('u1').promo_discount_cents, prom('u1').promo], [5000, 5000, 'free_delivery']);
  for (const g of [null, undefined, '']) assert.deepStrictEqual([prom(g).promo_discount_cents, prom(g).promo], [0, null], 'a guest pays envío');
  assert.strictEqual(P.netDeliveryCents(prom('u1')), 0); assert.strictEqual(P.netDeliveryCents(prom(null)), 5000); assert.strictEqual(P.netDeliveryCents(null), 0);
  ok('promo: free_delivery ON + an authenticated customer → envío free; guests pay; net envío = max(0, delivery − promo)');

  // ── the seam: dark is the identity; active adds envío to the TOTAL only (food subtotal/tax untouched) ──
  const bd = { total_cents: 34000, subtotal_cents: 29565, tax_cents: 4435 };
  assert.strictEqual(DW.withDelivery(null, bd), bd, 'dark → the SAME breakdown object');
  assert.strictEqual(DW.withDelivery({ refusal: 'pin_required', httpStatus: 409 }, bd), bd, 'refused → unchanged (the gate step refuses)');
  assert.deepStrictEqual(DW.orderFields(bd), {}, 'dark → no order field');
  assert.deepStrictEqual(DW.gateExtra(null), {}, 'dark → the gate input is untouched');
  const act = DW.withDelivery({ ctx: q({}).ctx }, bd);
  assert.deepStrictEqual(act, { ...bd, total_cents: 37000, delivery_cents: 3000, promo_discount_cents: 0, delivery_snapshot: { mode: 'delivery', policy_version: 3, km: 1, band: 0, promo: null } });
  assert.deepStrictEqual(DW.withDelivery({ ctx: prom('u1') }, bd).total_cents, 34000, 'promo → the food total');
  assert.deepStrictEqual(DW.withDelivery({ ctx: q({ mode: 'pickup' }).ctx }, bd).delivery_snapshot, { mode: 'pickup', policy_version: 3 });
  assert.deepStrictEqual(Object.keys(DW.orderFields(act)), ['delivery_cents', 'promo_discount_cents', 'delivery_snapshot']);
  assert.deepStrictEqual(DW.gateExtra({ ctx: q({}).ctx }), { deliveryContext: q({}).ctx });
  assert.deepStrictEqual([DW.totalLempiras(null, 340), DW.totalLempiras({ refusal: 'pin_required' }, 340), DW.totalLempiras({ ctx: q({}).ctx }, 340), DW.totalLempiras({ ctx: prom('u1') }, 340)], [340, 340, 370, 340], 'the lempira total the driver collects = food + net envío (dark/refused: food)');
  ok('seam: dark/refused leave the breakdown and the gate input untouched; active adds the NET envío to total_cents only and snapshots it');

  // ── the refusal at the gate step releases the hold; null otherwise ──
  let released = 0;
  assert.strictEqual(await DW.refusalGate(null, async () => { released++; }, 'o1'), null);
  assert.strictEqual(await DW.refusalGate({ ctx: {} }, async () => { released++; }, 'o1'), null);
  assert.strictEqual(released, 0);
  const r = await DW.refusalGate({ refusal: 'pin_required', httpStatus: 409 }, async () => { released++; }, 'o1');
  assert.deepStrictEqual([r.refuse, released], [{ status: 409, body: { error: 'pin_required', order_id: 'o1' } }, 1]);
  const r503 = await DW.refusalGate({ refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, async () => { throw new Error('x'); }, 'o2');
  assert.deepStrictEqual(r503.refuse.body, { error: 'delivery_pricing_unavailable', retryable: true, order_id: 'o2' }, 'a failing release never masks the refusal');
  ok('gate step: a refusal releases the reward hold and answers its typed status; no refusal → the real gate runs');

  // ── reads: dark costs one config read; a read FAILURE refuses (never free) ──
  const reads = [];
  const fakeDb = (cfg, { fail = false } = {}) => ({ ref: (p) => ({ get: async () => { reads.push(p); if (fail) throw new Error('rtdb down'); return { val: () => (p === 'platform_config/delivery_pricing' ? cfg : null), exists: () => false }; } }) });
  const idReads = [];
  const getIdentity = async (db, rid) => { idReads.push(rid); return { hub_lat: HUB.lat, hub_lng: HUB.lng }; };
  assert.strictEqual(await DW.deliveryFor(fakeDb(null), { rid: 'r1', mode: 'delivery', pin: null, customerUid: null, getIdentity }), null);
  assert.deepStrictEqual([reads, idReads], [['platform_config/delivery_pricing'], []], 'dark: ONE config read, no identity read');
  assert.deepStrictEqual(await DW.deliveryFor(fakeDb(null, { fail: true }), { rid: 'r1', getIdentity }), { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, '🔴 an unreadable config is a 503 refusal, never free');
  assert.deepStrictEqual((await DW.deliveryFor(fakeDb(RAW), { rid: 'r1', mode: 'delivery', pin: { ...north(4), confirmed: true }, customerUid: null, getIdentity })).ctx.delivery_cents, 5000);
  assert.deepStrictEqual(await DW.deliveryFor(fakeDb(RAW), { rid: 'r1', mode: 'delivery', pin: { ...north(4) }, getIdentity }), { refusal: 'pin_required', httpStatus: 409 });
  assert.deepStrictEqual(await DW.deliveryFor(fakeDb(RAW), { rid: 'r1', mode: 'delivery', pin: { ...north(4), confirmed: true }, getIdentity: async () => { throw Object.assign(new Error('x'), { statusCode: 503 }); } }), { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, 'an unreadable hub → 503 refusal');
  reads.length = 0;
  const early = DW.loadPricing(fakeDb(RAW), 'r1');                       // a handler starts the read early …
  assert.deepStrictEqual((await DW.deliveryFor(fakeDb(null), { rid: 'r1', mode: 'pickup', getIdentity, pricingP: early })).ctx.mode, 'pickup', '… and deliveryFor uses THAT read');
  assert.deepStrictEqual(reads, ['platform_config/delivery_pricing'], 'no second config read');
  await DW.loadPricing(fakeDb(null, { fail: true }), 'r1').then((x) => assert.deepStrictEqual(x, { failed: true }));   // never rejects
  ok('reads: dark = one config read and nothing else; an unreadable config or hub refuses 503 (fail closed); a pre-started read is reused, never repeated, and never rejects');

  // ── the order / quote pins ──
  assert.deepStrictEqual(DW.orderPin({ lat: 14.2, lng: '-87.1', pin_confirmed: true }), { lat: 14.2, lng: -87.1, confirmed: true });
  assert.deepStrictEqual(DW.orderPin({ lat: 14.2, lng: -87.1, pin_confirmed: 'yes' }).confirmed, false, 'only the boolean true confirms');
  assert.ok(Number.isNaN(DW.orderPin({ lat: '' }).lat));
  assert.deepStrictEqual(DW.quotePin({ pin: { lat: 14.2, lng: -87.1, confirmed: true } }), { lat: 14.2, lng: -87.1, confirmed: true });
  assert.strictEqual(DW.quotePin({}), null);
  assert.deepStrictEqual(DW.quoteFields(null), {}, 'a dark quote response gains nothing');
  ok('pins: the order body (lat/lng + pin_confirmed:true) and the quote body (pin:{lat,lng,confirmed}); a dark quote response is unchanged');

  // ── the money seams: computeServerNet charges ONLY a server-made ctx; the gate's recompute includes it ──
  const { computeServerNet } = require('../compute-server-net');
  const { applyConfirmedNetGate } = require('../token-gate');
  const cart = [{ name: 'Margherita', qty: 1 }];
  const base = computeServerNet({ items: cart, rid: 'x_pizza' });
  assert.ok(!base.error && base.components.delivery_cents === 0, JSON.stringify(base));
  const ctx = q({}).ctx;
  const withC = computeServerNet({ items: cart, rid: 'x_pizza', deliveryContext: ctx });
  assert.deepStrictEqual([withC.net_total_cents, withC.components.delivery_cents, Object.keys(withC.components)], [base.net_total_cents + 3000, 3000, Object.keys(base.components)], 'envío joins the net; the components SHAPE is unchanged');
  assert.deepStrictEqual(computeServerNet({ items: cart, rid: 'x_pizza', deliveryContext: JSON.parse(JSON.stringify(ctx)) }), base, '🔴 a JSON copy of a server ctx (what a request could carry) is ignored');
  assert.deepStrictEqual(computeServerNet({ items: cart, rid: 'x_pizza', deliveryContext: prom('u1') }).net_total_cents, base.net_total_cents, 'promo → envío free in the net');
  const quiet = { warn() {}, log() {}, error() {} };
  const gi = { submittedCart: cart, rid: 'x_pizza', expectedNetCents: base.net_total_cents + 3000, enforce: false, nowMs: Date.now() };
  const g1 = await applyConfirmedNetGate({ gateInput: gi, recordedTotalCents: base.net_total_cents + 3000, releaseHold: async () => {}, orderId: 'o', log: quiet, deliveryContext: ctx });
  assert.deepStrictEqual([g1.refuse, g1.provenance.charged_net_cents], [null, base.net_total_cents + 3000], 'the gate approves food + envío');
  const g0 = await applyConfirmedNetGate({ gateInput: gi, recordedTotalCents: base.net_total_cents + 3000, releaseHold: async () => {}, orderId: 'o', log: quiet });
  assert.strictEqual(g0.refuse.status, 409, 'without the ctx the gate recomputes food only → divergence refused (the recorded total includes envío)');
  ok('money seams: computeServerNet adds the NET envío of a server-made ctx only (a JSON copy is ignored; components shape unchanged); the gate recompute includes it');

  // ── an early return while the pre-started read FAILS leaves no unhandled rejection (the read is captured at creation) ──
  {
    const unhandled = []; const onU = (e) => unhandled.push(e); process.on('unhandledRejection', onU);
    const throwSync = { ref: () => { throw new Error('ref threw synchronously'); } };
    const failGet = { ref: () => ({ get: () => Promise.reject(new Error('rtdb down')) }) };
    const p1 = DW.loadPricing(throwSync, 'r1'); const p2 = DW.loadPricing(failGet, 'r1');   // started, never awaited (the handler returned early)
    await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', onU);
    assert.deepStrictEqual(unhandled, [], '🔴 a pre-started read that fails must never surface as an unhandled rejection');
    assert.deepStrictEqual([await p1, await p2], [{ failed: true }, { failed: true }], 'both settle to the 503 refusal marker');
    ok('early return: a pre-started config read that throws (sync or async) settles to { failed } — no unhandled rejection; deliveryFor turns it into the 503 refusal');
  }

  console.log(`\ndelivery-pricing: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
