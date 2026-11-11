'use strict';
// ENVÍO STEP 2 — drawn no-delivery zones on the order path (PLAN-envio-zones-step2-r2 §4; Codex r1 F1/F4/F5). Zone lists are built by
// the writer's own normalizer (zones.js normalizeInput), never by hand. Run: node delivery/zones-wire.test.js
const assert = require('assert');
const P = require('./delivery-pricing');
const DW = require('./delivery-wire');
const Z = require('./zones');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const HUB = { lat: 14.1, lng: -87.2 };
const north = (km) => ({ lat: +(HUB.lat + km / 111.195).toFixed(6), lng: HUB.lng });
const PIN = { ...north(4), confirmed: true };   // ≈ 14.135972, -87.2
const ZONES = (() => { const r = Z.normalizeInput([{ id: 'z_aaaaaaaa', name: 'Sector A', points: [
  { lat: 14.13, lng: -87.21 }, { lat: 14.13, lng: -87.19 }, { lat: 14.14, lng: -87.19 }, { lat: 14.14, lng: -87.21 }] }]); assert.ok(r.ok); return r.zones; })();
const BANDS = [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }, { max_km: 8, cents: 7000 }];
const RAW = (extra = {}) => ({ policy_version: 3, bands: BANDS, ...extra });
const MALFORMED = [{ ...ZONES[0], points: ZONES[0].points.slice(0, 2) }];   // direct corruption: a 2-point stored zone
// a db over a path map (pricing + orders + attempts)
const fakeDb = (paths) => ({ ref: (p) => ({ get: async () => ({ val: () => (p in paths ? paths[p] : null), exists: () => paths[p] != null }) }) });
const getIdentity = async () => ({ hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8 });
const PRICING = 'platform_config/delivery_pricing';

(async () => {
  await cell('ZW-READER-ZONES', (L) => {
    const r = P.readPricing({ ...RAW({ no_delivery_zones: ZONES }), restaurants: { app: { active: true, free_delivery: false } } }, 'app');
    assert.deepStrictEqual(r.zones, ZONES, `${L}: the stored zones ride the pricing`);
    assert.ok(!r.invalid && !r.zonesInvalid, `${L}: valid`);
    const absent = P.readPricing({ ...RAW(), restaurants: { app: { active: true, free_delivery: false } } }, 'app');
    assert.deepStrictEqual(Object.keys(absent).sort(), ['bands', 'free_delivery', 'policy_version'], `${L}: absent zones → step 1's exact object`);
  });

  await cell('ZW-MALFORMED-ZONES-DELIVERY-ONLY', async (L) => {
    const r = P.readPricing({ ...RAW({ no_delivery_zones: MALFORMED }), restaurants: { app: { active: true, free_delivery: false } } }, 'app');
    assert.deepStrictEqual([r.invalid, r.zonesInvalid, Array.isArray(r.bands)], [undefined, true, true], `${L}: malformed zones are NOT invalid bands`);
    const db = fakeDb({ [PRICING]: RAW({ no_delivery_zones: MALFORMED }) });
    assert.deepStrictEqual(await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'delivery', pin: PIN, getIdentity, app: true }), { refusal: 'delivery_zones_invalid', httpStatus: 503 }, `${L}: an app DELIVERY fails closed`);
    const pk = await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'pickup', pin: null, getIdentity, app: true });
    assert.deepStrictEqual([pk.ctx && pk.ctx.mode, pk.ctx && pk.ctx.delivery_cents], ['pickup', 0], `${L}: an app PICKUP is priced as today`);
    assert.strictEqual(await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'delivery', pin: PIN, getIdentity, app: false }), null, `${L}: a FORM order is today's dark path`);
  });

  await cell('ZW-ORDER-IN-ZONE', async (L) => {
    const db = fakeDb({ [PRICING]: RAW({ no_delivery_zones: ZONES }) });
    assert.deepStrictEqual(await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'delivery', pin: PIN, getIdentity, app: true }), { refusal: 'no_delivery_zone', httpStatus: 409 }, `${L}: an app delivery inside a zone is refused 409`);
    const out = await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'delivery', pin: { ...north(1), confirmed: true }, getIdentity, app: true });
    assert.strictEqual(out.ctx && out.ctx.delivery_cents, 3000, `${L}: outside the zone and in the limit → priced`);
    const pk = await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'pickup', pin: PIN, getIdentity, app: true });
    assert.strictEqual(pk.ctx && pk.ctx.mode, 'pickup', `${L}: a pickup is never checked against zones`);
    assert.strictEqual(await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'delivery', pin: PIN, getIdentity, app: false }), null, `${L}: a FORM order is never checked (D2)`);
  });

  await cell('ZW-PRECEDENCE-BANDS-FIRST', async (L) => {
    const far = Z.normalizeInput([{ id: 'z_bbbbbbbb', name: 'Lejos', points: [{ lat: 14.17, lng: -87.21 }, { lat: 14.17, lng: -87.19 }, { lat: 14.19, lng: -87.19 }, { lat: 14.19, lng: -87.21 }] }]).zones;
    const db = fakeDb({ [PRICING]: RAW({ no_delivery_zones: far }) });
    const pin = { ...north(9.5), confirmed: true };   // beyond the last band (8 km) AND inside the far zone
    assert.ok(Z.inZone(far, pin), 'premise: the pin is inside the zone');
    assert.deepStrictEqual(await DW.deliveryFor(db, { rid: 'tb_r1', mode: 'delivery', pin, getIdentity, app: true }), { refusal: 'outside_delivery_bands', httpStatus: 409 }, `${L}: beyond the limit answers outside_delivery_bands first`);
  });

  await cell('ZW-QUOTE-WIRE-409', async (L) => {
    const db = fakeDb({ [PRICING]: RAW({ no_delivery_zones: ZONES }) });
    const q = await DW.quoteDeliveryFor({ get: () => null }, db, 'tb_r1', { mode: 'delivery', pin: PIN, entry_mode: 'app' }, { getIdentity, knownUid: null });
    assert.deepStrictEqual(q, { refuse: { ok: false, error: 'no_delivery_zone' }, httpStatus: 409 }, `${L}: the quote wire answers 409 for a zone (F4)`);
    const q2 = await DW.quoteDeliveryFor({ get: () => null }, db, 'tb_r1', { mode: 'delivery', pin: { ...north(4), confirmed: false }, entry_mode: 'app' }, { getIdentity, knownUid: null });
    assert.deepStrictEqual(q2.httpStatus, 200, `${L}: every other refusal keeps its fail-soft 200 (${JSON.stringify(q2)})`);
    const q3 = await DW.quoteDeliveryFor({ get: () => null }, fakeDb({ [PRICING]: RAW({ no_delivery_zones: MALFORMED }) }), 'tb_r1', { mode: 'delivery', pin: PIN, entry_mode: 'app' }, { getIdentity, knownUid: null });
    assert.deepStrictEqual(q3, { refuse: { ok: false, error: 'delivery_zones_invalid' }, httpStatus: 503 }, `${L}: malformed zones are a 503 config refusal on the quote`);
  });

  await cell('ZW-RESUME-GUARD-CHARGECONTEXT', async (L) => {
    const now = Date.now();
    const order = { order_type: 'delivery', lat: PIN.lat, lng: PIN.lng, payment_status: 'pending', active_attempt_id: 'att1', delivery_cents: 5000, promo_discount_cents: 0, delivery_snapshot: { mode: 'delivery', policy_version: 3, km: 4, band: 1, promo: null } };
    const paths = (zones) => ({ [PRICING]: RAW(zones ? { no_delivery_zones: zones } : {}), 'orders/o1': order, 'payment_attempts/att1': { hosted_state: 'created', hosted_expires_at: now + 600000 } });
    const refused = { refusal: 'no_delivery_zone', httpStatus: 409 };
    assert.deepStrictEqual(await DW.chargeContext(fakeDb(paths(ZONES)), 'o1', refused, { order_type: 'delivery', lat: PIN.lat, lng: PIN.lng }, now), refused, `${L}: a LIVE checkout whose stored pin is in a zone is NOT resumed (F1)`);
    const g = await DW.chargeContext(fakeDb(paths(null)), 'o1', refused, { order_type: 'delivery', lat: PIN.lat, lng: PIN.lng }, now);
    assert.strictEqual(g.grandfathered, true, `${L}: premise — with no zones the live checkout is grandfathered (step 1)`);
    const pick = { ...order, order_type: 'pickup', delivery_snapshot: { mode: 'pickup', policy_version: 3 } };
    const gp = await DW.chargeContext(fakeDb({ ...paths(ZONES), 'orders/o1': pick }), 'o1', { ctx: null }, { order_type: 'pickup' }, now);
    assert.strictEqual(gp.grandfathered, true, `${L}: a stored PICKUP is never checked against zones`);
  });

  await cell('ZW-RESUME-GUARD', async (L) => {
    const app = { order_type: 'delivery', lat: PIN.lat, lng: PIN.lng, delivery_snapshot: { mode: 'delivery', policy_version: 3 } };
    assert.deepStrictEqual(await DW.zoneResumeRefusal(fakeDb({ [PRICING]: RAW({ no_delivery_zones: ZONES }) }), app), { refusal: 'no_delivery_zone', httpStatus: 409 }, `${L}: a stored app delivery in a zone`);
    assert.strictEqual(await DW.zoneResumeRefusal(fakeDb({ [PRICING]: RAW({ no_delivery_zones: ZONES }) }), { ...app, lat: north(1).lat }), null, `${L}: outside → null`);
    assert.strictEqual(await DW.zoneResumeRefusal(fakeDb({ [PRICING]: RAW({ no_delivery_zones: ZONES }) }), { order_type: 'delivery', lat: PIN.lat, lng: PIN.lng }), null, `${L}: a FORM order (no snapshot) → null`);
    assert.deepStrictEqual(await DW.zoneResumeRefusal(fakeDb({ [PRICING]: RAW({ no_delivery_zones: MALFORMED }) }), app), { refusal: 'delivery_zones_invalid', httpStatus: 503 }, `${L}: malformed zones → fail closed`);
    assert.strictEqual(await DW.zoneResumeRefusal(fakeDb({}), app), null, `${L}: no table → null (step 1 unchanged)`);
    const failDb = { ref: () => ({ get: async () => { throw new Error('down'); } }) };
    assert.deepStrictEqual(await DW.zoneResumeRefusal(failDb, app), { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, `${L}: a failed read → 503`);
  });

  await cell('ZW-READ-COUNT-PINNED', async (L) => {
    // F8: zones add NO read to the order path — one pricing read per order and per quote, as step 1
    const counting = (paths) => { const reads = []; return { reads, db: { ref: (p) => ({ get: async () => { reads.push(p); return { val: () => (p in paths ? paths[p] : null), exists: () => paths[p] != null }; } }) } }; };
    const o = counting({ [PRICING]: RAW({ no_delivery_zones: ZONES }) });
    await DW.deliveryFor(o.db, { rid: 'tb_r1', mode: 'delivery', pin: { ...north(1), confirmed: true }, getIdentity, app: true });
    assert.deepStrictEqual(o.reads, [PRICING], `${L}: an order reads the pricing node once (${JSON.stringify(o.reads)})`);
    const q = counting({ [PRICING]: RAW({ no_delivery_zones: ZONES }) });
    await DW.quoteDeliveryFor({ get: () => null }, q.db, 'tb_r1', { mode: 'delivery', pin: { ...north(1), confirmed: true }, entry_mode: 'app' }, { getIdentity, knownUid: null });
    assert.deepStrictEqual(q.reads, [PRICING], `${L}: a quote reads the pricing node once (${JSON.stringify(q.reads)})`);
  });

  // Codex build r1 #2: the RESUME guards reuse the request's one pricing read (the handler's dpP) — the complete traces are pinned
  await cell('ZW-RESUME-TRACE-ONE-PRICING-READ', async (L) => {
    const counting = (paths) => { const reads = []; return { reads, db: { ref: (p) => ({ get: async () => { reads.push(p); return { val: () => (p in paths ? paths[p] : null), exists: () => paths[p] != null }; } }) } }; };
    const NOW = 1_800_000_000_000;
    const stored = { order_type: 'delivery', lat: PIN.lat, lng: PIN.lng, payment_status: 'pending', active_attempt_id: 'att1', delivery_snapshot: { mode: 'delivery', policy_version: 3 } };
    const world = { [PRICING]: RAW({ no_delivery_zones: ZONES }), 'orders/o1': stored, 'payment_attempts/att1': { hosted_state: 'created', hosted_expires_at: NOW + 60000 } };
    // chargeContext (a LIVE app checkout whose stored pin is in a zone): pricing → order → attempt, and nothing else
    const c = counting(world); const pricingP = DW.loadPricing(c.db, 'tb_r1');
    const dq = await DW.deliveryFor(c.db, { rid: 'tb_r1', mode: 'delivery', pin: { ...north(1), confirmed: true }, getIdentity, pricingP, app: true });
    const out = await DW.chargeContext(c.db, 'o1', dq, { entry_mode: 'app' }, NOW, pricingP);
    assert.deepStrictEqual(out, { refusal: 'no_delivery_zone', httpStatus: 409 }, `${L}: premise: the live resume is refused`);
    assert.deepStrictEqual(c.reads, [PRICING, 'orders/o1', 'payment_attempts/att1'], `${L}: chargeContext trace (${JSON.stringify(c.reads)})`);
    // the reward-bound resume: the probe already read the order; the guard reads NOTHING when handed the request's pricing
    const b = counting(world); const pb = DW.loadPricing(b.db, 'tb_r1'); await pb;
    const zr = await DW.zoneResumeRefusal(b.db, stored, pb);
    assert.deepStrictEqual(zr, { refusal: 'no_delivery_zone', httpStatus: 409 }, `${L}: premise: the bound resume is refused`);
    assert.deepStrictEqual(b.reads, [PRICING], `${L}: the bound guard adds no read (${JSON.stringify(b.reads)})`);
  });

  if (fails.length) { console.log(`zones-wire FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`zones-wire: OK (${n})`);
})();
