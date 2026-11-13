'use strict';
// DELIVERY PRICING APP-ONLY (PLAN-delivery-pricing-app-only r2 §1, owner 2026-11-10): the Sherpa envío and the tip apply only to
// customer-app requests (entry_mode:'app'). Any other request — the frozen order forms — takes today's DARK path even when its
// restaurant is active: one config read, nothing priced, no pin/mode refusal, a tip refused as tip_not_enabled. The reader
// (readPricing) keeps its exact current outcomes. Run: node delivery/dpao-wire.test.js
const assert = require('assert');
const P = require('./delivery-pricing');
const DW = require('./delivery-wire');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const HUB = { lat: 14.1, lng: -87.2 };
const north = (km) => ({ lat: HUB.lat + km / 111.195, lng: HUB.lng });
const RAW = { policy_version: 3, bands: [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }, { max_km: 8, cents: 7000 }], restaurants: { tb_r1: { active: true, free_delivery: false } } };
const reads = [], idReads = [];
const fakeDb = (cfg) => ({ ref: (p) => ({ get: async () => { reads.push(p); return { val: () => (p === 'platform_config/delivery_pricing' ? cfg : null), exists: () => cfg != null }; } }) });
const getIdentity = async (db, rid) => { idReads.push(rid); return { hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8 }; };
const PIN = { ...north(4), confirmed: true };

(async () => {
  await cell('DPAO-ISAPP-EXPORTED', (L) => {
    assert.strictEqual(typeof DW.isApp, 'function', `${L}: isApp is exported for the handlers`);
    assert.deepStrictEqual([{ entry_mode: 'app' }, { entry_mode: 'direct' }, {}, null, undefined, { entry_mode: 'APP' }].map(DW.isApp), [true, false, false, false, false, false], `${L}: only entry_mode === 'app' is an app request`);
  });

  await cell('DPAO-ORDER-NON-APP-IS-DARK', async (L) => {
    reads.length = 0; idReads.length = 0;
    for (const mode of ['delivery', 'pickup', undefined]) {
      assert.strictEqual(await DW.deliveryFor(fakeDb(RAW), { rid: 'tb_r1', mode, pin: null, customerUid: null, getIdentity, app: false }), null, `${L}: a form ${mode} order on an ACTIVE restaurant is dark (no pin/mode refusal)`);
    }
    assert.strictEqual(await DW.deliveryFor(fakeDb(RAW), { rid: 'tb_r1', mode: 'delivery', pin: PIN, customerUid: null, getIdentity }), null, `${L}: no app flag is a form request`);
    assert.deepStrictEqual([reads.length, idReads.length], [4, 0], `${L}: one config read each, no identity read — exactly today's dark path`);
    assert.deepStrictEqual(await DW.deliveryFor(fakeDb(RAW), { rid: 'tb_r1', mode: 'delivery', pin: PIN, getIdentity, app: false, tip: 2000 }), { refusal: 'tip_not_enabled', httpStatus: 409 }, `${L}: a form tip is refused exactly as on a dark restaurant`);
    const failDb = { ref: () => ({ get: async () => { throw new Error('down'); } }) };
    assert.deepStrictEqual(await DW.deliveryFor(failDb, { rid: 'tb_r1', mode: 'delivery', getIdentity, app: false }), { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, `${L}: a failed read still refuses 503, as today`);
  });

  await cell('DPAO-ORDER-APP-IS-PRICED', async (L) => {
    const r = await DW.deliveryFor(fakeDb(RAW), { rid: 'tb_r1', mode: 'delivery', pin: PIN, customerUid: null, getIdentity, app: true });
    assert.strictEqual(r.ctx.delivery_cents, 5000, `${L}: an app delivery on an active restaurant carries the envío`);
    assert.deepStrictEqual(await DW.deliveryFor(fakeDb(RAW), { rid: 'tb_r1', mode: 'delivery', pin: null, getIdentity, app: true }), { refusal: 'pin_required', httpStatus: 409 }, `${L}: an app delivery still needs its confirmed pin`);
    assert.strictEqual((await DW.deliveryFor(fakeDb(RAW), { rid: 'tb_r1', mode: 'delivery', pin: PIN, getIdentity, app: true, tip: 2000 })).ctx.tip_cents, 2000, `${L}: an app tip rides the ctx`);
  });

  await cell('DPAO-QUOTE-NON-APP-IS-DARK', async (L) => {
    const req = { get: () => null };
    idReads.length = 0;
    for (const body of [{ restaurant_id: 'tb_r1', items: [] }, { mode: 'delivery', pin: PIN }, { mode: 'delivery', pin: PIN, entry_mode: 'direct' }]) {
      assert.deepStrictEqual(await DW.quoteDeliveryFor(req, fakeDb(RAW), 'tb_r1', body, { getIdentity, knownUid: null }), { ctx: null, uid: null }, `${L}: a form quote on an ACTIVE restaurant is dark: ${JSON.stringify(body)}`);
    }
    assert.strictEqual(idReads.length, 0, `${L}: no identity read for a form quote`);
    assert.deepStrictEqual(await DW.quoteDeliveryFor(req, fakeDb(RAW), 'tb_r1', { mode: 'delivery', pin: PIN, tip_cents: 2000 }, { getIdentity, knownUid: null }), { refuse: { ok: false, error: 'tip_not_enabled' }, httpStatus: 409 }, `${L}: a form quote tip → tip_not_enabled, as dark`);
    assert.deepStrictEqual(await DW.quoteDeliveryFor(req, fakeDb(RAW), 'tb_r1', { mode: 'delivery', pin: PIN }, { getIdentity, knownUid: 'tb_u1' }), { ctx: null, uid: 'tb_u1' }, `${L}: the caller's known uid passes through, as dark`);
  });

  await cell('DPAO-QUOTE-APP-IS-PRICED', async (L) => {
    const q = await DW.quoteDeliveryFor({ get: () => null }, fakeDb(RAW), 'tb_r1', { mode: 'delivery', pin: PIN, entry_mode: 'app' }, { getIdentity, knownUid: null });
    assert.deepStrictEqual(DW.quoteFields(q.ctx).delivery.delivery_cents, 5000, `${L}: an app quote carries the envío`);
  });

  // Addendum A (owner 2026-11-10): the fee applies to EVERY restaurant on the app path — the stored per-restaurant map is
  // ignored and free delivery is off; the band table is the app's only distance limit; an absent config refuses an app
  // DELIVERY (503) and leaves an app PICKUP on today's dark path.
  await cell('DPAO-APP-IGNORES-THE-RESTAURANT-MAP', async (L) => {
    const priced = async (raw, uid = null) => (await DW.deliveryFor(fakeDb(raw), { rid: 'tb_r1', mode: 'delivery', pin: PIN, customerUid: uid, getIdentity, app: true })).ctx;
    const B = { policy_version: 3, bands: RAW.bands };
    assert.strictEqual((await priced({ ...B }))?.delivery_cents, 5000, `${L}: a restaurant with no map entry is priced`);
    assert.strictEqual((await priced({ ...B, restaurants: { tb_r1: { active: false, free_delivery: false } } }))?.delivery_cents, 5000, `${L}: active:false in the map is ignored`);
    const m = await priced({ ...B, restaurants: { tb_r1: { active: true, free_delivery: true } } }, 'tb_member');
    assert.deepStrictEqual([m?.delivery_cents, m?.promo_discount_cents, m?.promo], [5000, 0, null], `${L}: free delivery is off — a member pays the fee`);
    const q = await DW.quoteDeliveryFor({ get: () => null }, fakeDb({ ...B, restaurants: { other: { active: true, free_delivery: false } } }), 'tb_r1', { mode: 'delivery', pin: PIN, entry_mode: 'app' }, { getIdentity, knownUid: 'tb_member' });
    assert.strictEqual(DW.quoteFields(q.ctx).delivery?.delivery_cents, 5000, `${L}: the quote path too`);
  });

  await cell('DPAO-APP-ABSENT-CONFIG', async (L) => {
    const o = (mode, tip) => DW.deliveryFor(fakeDb(null), { rid: 'tb_r1', mode, pin: PIN, getIdentity, app: true, ...(tip ? { tip } : {}) });
    assert.deepStrictEqual(await o('delivery'), { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, `${L}: an app delivery with no band table is refused (fail closed)`);
    assert.deepStrictEqual(await o('delivery', 2000), { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, `${L}: with a tip too`);
    assert.strictEqual(await o('pickup'), null, `${L}: an app pickup stays on today's dark path`);
    assert.deepStrictEqual(await o('pickup', 2000), { refusal: 'tip_not_enabled', httpStatus: 409 }, `${L}: an app pickup tip, as today`);
    const q = (body) => DW.quoteDeliveryFor({ get: () => null }, fakeDb(null), 'tb_r1', { entry_mode: 'app', ...body }, { getIdentity, knownUid: null });
    assert.deepStrictEqual(await q({ mode: 'delivery', pin: PIN }), { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 }, `${L}: an app delivery quote is refused`);
    assert.deepStrictEqual(await q({ mode: 'pickup' }), { ctx: null, uid: null }, `${L}: an app pickup quote stays dark`);
    assert.strictEqual(await DW.deliveryFor(fakeDb(null), { rid: 'tb_r1', mode: 'delivery', pin: PIN, getIdentity, app: false }), null, `${L}: a form delivery is unaffected`);
    const bad = await DW.deliveryFor(fakeDb({ policy_version: 3, bands: [] }), { rid: 'tb_r1', mode: 'pickup', getIdentity, app: true });
    assert.deepStrictEqual(bad, { refusal: 'delivery_pricing_invalid', httpStatus: 409 }, `${L}: an INVALID table refuses (never dark)`);
  });

  await cell('DPAO-APP-BANDS-ARE-THE-ONLY-LIMIT', async (L) => {
    const tight = async () => ({ hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 3.5 });
    const q = await DW.quoteDeliveryFor({ get: () => null }, fakeDb(RAW), 'tb_r1', { mode: 'delivery', pin: PIN, entry_mode: 'app' }, { getIdentity: tight, knownUid: null });
    assert.deepStrictEqual([DW.quoteFields(q.ctx).delivery?.delivery_cents, DW.quoteFields(q.ctx).delivery?.max_km], [5000, 8], `${L}: a pin beyond the restaurant radius but within the bands is priced; coverage = the last band`);
    const far = { lat: HUB.lat + 8.5 / 111.195, lng: HUB.lng, confirmed: true };
    const f = await DW.quoteDeliveryFor({ get: () => null }, fakeDb(RAW), 'tb_r1', { mode: 'delivery', pin: far, entry_mode: 'app' }, { getIdentity: tight, knownUid: null });
    assert.deepStrictEqual(f.refuse, { ok: false, error: 'outside_delivery_bands' }, `${L}: beyond the last band is refused`);
  });

  await cell('DPAO-HALF-KM-BANDS', async (L) => {
    const raw = { policy_version: 1, bands: [{ max_km: 9, cents: 6000 }, { max_km: 9.5, cents: 7000 }] };
    const at = async (km) => DW.deliveryFor(fakeDb(raw), { rid: 'tb_r1', mode: 'delivery', pin: { lat: HUB.lat + km / 111.195, lng: HUB.lng, confirmed: true }, getIdentity, app: true });
    assert.deepStrictEqual([(await at(9.4)).ctx.delivery_cents, (await at(9.4)).ctx.band, (await at(9.6)).refusal], [7000, 1, 'outside_delivery_bands'], `${L}: 9.4 km prices in the 9.5 band; 9.6 km is beyond it`);
  });

  // The live reader keeps its CURRENT outcomes (plan r2 F4: not tightened in this slice).
  await cell('DPAO-READER-OUTCOMES-PINNED', (L) => {
    const T = (raw, rid = 'tb_r1') => JSON.stringify(P.readPricing(raw, rid));
    const B = RAW.bands;
    assert.deepStrictEqual([
      T({ ...RAW, bands: { 0: B[0], 1: B[1] } }),                                  // object-shaped bands accepted
      T({ ...RAW, restaurants: { tb_r1: { active: 'yes' } } }),                    // malformed activation → dark
      T({ ...RAW, policy_version: 2 ** 53 - 1 }),                                  // unsafe-for-the-writer version accepted
      T({ ...RAW, bands: [] }),                                                    // empty → invalid
      T({ ...RAW, bands: [B[1], B[0]] }),                                          // unordered → invalid
      T({ ...RAW, restaurants: {} }),                                              // no restaurants → dark
    ], [
      JSON.stringify({ policy_version: 3, bands: [B[0], B[1]], free_delivery: false }), 'null',
      JSON.stringify({ policy_version: 2 ** 53 - 1, bands: B, free_delivery: false }), '{"invalid":true}', '{"invalid":true}', 'null',
    ], `${L}: readPricing's outcomes are unchanged`);
  });

  if (fails.length) { console.log(`FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`OK (${n})`);
})();
