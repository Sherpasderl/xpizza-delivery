'use strict';
// ENVÍO — each restaurant's own maximum delivery distance (PLAN-envio-restaurant-limit-r5, APPROVED 2026-11-12): the per-BRANCH
// `max_km` lives IN platform_config/delivery_pricing (`restaurants[rid] = { max_km }`), written only by setDeliveryPricing's ONE
// transaction; every app quote / order / resume reads it from the request's ONE fresh policy read. Every VALID stored node here is
// committed by the REAL writer (setDeliveryPricingCore on the strict fake RTDB); only the shapes the writer can never produce (a
// malformed entry, the S3a legacy flags) are planted directly, as the corruption / legacy cases they are.
// Run: node delivery/limits.test.js
const assert = require('assert');
const crypto = require('crypto');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const A = require('./pricing-admin-core');
const P = require('./delivery-pricing');
const DW = require('./delivery-wire');
const Z = require('./zones');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const PATH = 'platform_config/delivery_pricing';
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9.5, cents: 7000 }];   // top 9.5
const BANDS6 = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }];                                  // top cut to 6
const HUB1 = { lat: 15.5, lng: -88.0 }; const HUB2 = { lat: 15.6, lng: -88.1 };
const north = (hub, km) => ({ lat: +(hub.lat + km / 111.195).toFixed(6), lng: hub.lng });
const pinAt = (hub, km) => ({ ...north(hub, km), confirmed: true });
const TOKENS = { admin: { uid: 'tbowner' } };
const req = (tok, body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' && tok ? `Bearer ${tok}` : null), body });
let AT = 1762800000000;
const IDS = ['tb_r1', 'tb_r2', 'tb_r3'];
const DIRECTORY = {
  brands: { tb_brand: { name: 'Marca TB' } },
  restaurants: {
    tb_r1: { identity: { name: 'TB Uno', brand_id: 'tb_brand', location_name: 'Centro', hub_lat: HUB1.lat, hub_lng: HUB1.lng } },
    tb_r2: { identity: { name: 'TB Dos', brand_id: 'tb_brand', location_name: 'Norte', hub_lat: HUB2.lat, hub_lng: HUB2.lng } },
  },                                                                          // tb_r3: registered, no identity yet
};
function world(init = {}, { registry, ids = IDS, directory = DIRECTORY } = {}) {
  const db = fakeRtdb({ platform_admins: { tbowner: true }, ...directory, ...init }, { strict: true });
  const deps = { db, verifyIdToken: async (t) => { if (!TOKENS[t]) throw new Error('bad'); return TOKENS[t]; }, timestamp: () => ++AT,
    readRegistry: registry || (async () => ({ ok: true, fresh: true, ids })) };
  // the order path reads with ref(p).get() (delivery-wire loadPricing) — the same store, read the order path's way
  const reader = { ref: (p) => ({ get: () => db.ref(p).once() }) };
  return { db, deps, reader, set: (body) => A.setDeliveryPricingCore(deps, req('admin', body)), get: () => A.getDeliveryPricingCore(deps, req('admin')) };
}
const save = async (w, over) => {
  const cur = w.db.get(PATH);
  const r = await w.set({ expected_policy_version: cur ? cur.policy_version : 0, bands: cur ? cur.bands : BANDS, ...over });
  assert.strictEqual(r.status, 200, `premise: the real writer saved (${JSON.stringify(r.body)})`);
  return r;
};
const identities = { tb_r1: { hub_lat: HUB1.lat, hub_lng: HUB1.lng }, tb_r2: { hub_lat: HUB2.lat, hub_lng: HUB2.lng } };
const getIdentity = async (_db, rid) => identities[rid];
const pricingOf = async (w) => (await DW.loadPricing(w.reader)).pricing;
const plant = (w, restaurants) => { const node = w.db.get(PATH); w.db.root.platform_config.delivery_pricing = { ...node, restaurants }; };
const order = (rid, hub, pin, extra = {}) => ({ restaurant_id: rid, order_type: 'delivery', lat: pin.lat, lng: pin.lng, hub_lat: hub.lat, hub_lng: hub.lng,
  payment_status: 'pending', delivery_cents: 5000, promo_discount_cents: 0, delivery_snapshot: { mode: 'delivery', policy_version: 1, km: 4, band: 1, promo: null }, ...extra });
const quote = (w, rid, body) => DW.quoteDeliveryFor({ get: () => null }, w.reader, rid, { entry_mode: 'app', ...body }, { getIdentity, knownUid: null });
const deliver = (w, rid, pin, mode = 'delivery') => DW.deliveryFor(w.reader, { rid, mode, pin, getIdentity, app: true });

(async () => {
  await cell('EFF-FN', async (L) => {
    const w = world();
    await save(w, { limits: [{ rid: 'tb_r1', km: 4 }, { rid: 'tb_r2', km: 9 }] });
    let pr = await pricingOf(w);
    assert.strictEqual(P.effectiveMaxKm(pr, 'tb_r1'), 4, `${L}: below the top → the stored value`);
    assert.strictEqual(P.effectiveMaxKm(pr, 'tb_r2'), 9, `${L}: 9 under a 9.5 top → 9`);
    assert.strictEqual(P.effectiveMaxKm(pr, 'tb_r3'), 9.5, `${L}: absent → the table top`);
    await save(w, { bands: BANDS6 });   // the owner cuts the top: the stored 9 is KEPT, effective at the top
    pr = await pricingOf(w);
    assert.strictEqual(w.db.get(PATH).restaurants.tb_r2.max_km, 9, `${L}: a value above a newly cut top is kept as stored`);
    assert.strictEqual(P.effectiveMaxKm(pr, 'tb_r2'), 6, `${L}: above the top → min(top, max_km) (m1)`);
    plant(w, { tb_r1: { max_km: 'x' }, tb_r2: { active: true, free_delivery: false }, tb_r3: { max_km: 4, extra: 1 } });
    pr = await pricingOf(w);
    assert.strictEqual(P.effectiveMaxKm(pr, 'tb_r1'), P.LIMIT_INVALID, `${L}: a malformed entry → that branch INVALID, never absent (m2)`);
    assert.strictEqual(P.effectiveMaxKm(pr, 'tb_r3'), P.LIMIT_INVALID, `${L}: an unknown field is malformed`);
    assert.strictEqual(P.effectiveMaxKm(pr, 'tb_r2'), 6, `${L}: an S3a legacy {active, free_delivery} entry reads as ABSENT (m2c)`);
    for (const bad of [{ max_km: 0 }, { max_km: -1 }, { max_km: Infinity }, { max_km: null }, {}, 4, { active: 'yes' }]) {
      plant(w, { tb_r1: bad }); assert.strictEqual(P.effectiveMaxKm(await pricingOf(w), 'tb_r1'), P.LIMIT_INVALID, `${L}: ${JSON.stringify(bad)} is malformed`);
    }
  });

  await cell('BLAST-RADIUS', async (L) => {
    const w = world(); await save(w, { limits: [{ rid: 'tb_r2', km: 5 }] });
    plant(w, { ...w.db.get(PATH).restaurants, tb_r1: { max_km: 'x' } });
    assert.ok(!(await pricingOf(w)).invalid, `${L}: one malformed entry does NOT invalidate the policy (m2b)`);
    assert.deepStrictEqual(await deliver(w, 'tb_r1', pinAt(HUB1, 1)), { refusal: 'delivery_pricing_invalid', httpStatus: 409 }, `${L}: the malformed branch's app ORDER is refused`);
    assert.deepStrictEqual(await quote(w, 'tb_r1', { mode: 'delivery', pin: pinAt(HUB1, 1) }), { refuse: { ok: false, error: 'delivery_pricing_invalid' }, httpStatus: 200 }, `${L}: …and its QUOTE (as an invalid table is)`);
    const pk = await deliver(w, 'tb_r1', null, 'pickup');
    assert.deepStrictEqual([pk.ctx && pk.ctx.mode, pk.ctx && pk.ctx.delivery_cents], ['pickup', 0], `${L}: its app PICKUP is priced as today (the limit is a delivery rule)`);
    const ok = await deliver(w, 'tb_r2', pinAt(HUB2, 4));
    assert.deepStrictEqual([ok.ctx && ok.ctx.mode, ok.ctx && ok.ctx.delivery_cents], ['delivery', 5000], `${L}: the OTHER branch orders normally`);
    const q2 = await quote(w, 'tb_r2', { mode: 'delivery', pin: pinAt(HUB2, 4) });
    assert.deepStrictEqual([q2.ctx && q2.ctx.delivery_cents, DW.quoteFields(q2.ctx).delivery.max_km], [5000, 5], `${L}: …and quotes, reporting its effective limit`);
    const lp = DW.loadPricing(w.reader);
    assert.deepStrictEqual(await DW.deliveryResumeRefusal(w.reader, order('tb_r1', HUB1, pinAt(HUB1, 1)), lp), { refusal: 'delivery_pricing_invalid', httpStatus: 409 }, `${L}: …and its RESUME`);
    assert.strictEqual(await DW.deliveryResumeRefusal(w.reader, order('tb_r2', HUB2, pinAt(HUB2, 4)), lp), null, `${L}: the other branch resumes`);
  });

  await cell('QUOTE-ORDER-BOUNDARY', async (L) => {
    const w = world(); await save(w, { limits: [{ rid: 'tb_r1', km: 4 }] });
    for (const [km, want] of [[3.99, 'priced'], [3.9999, 'priced'], [4.01, 'outside_delivery_bands']]) {   // 3.9999: AT the limit within the pin's 6-decimal rounding (≈ 0.1 m)
      const o = await deliver(w, 'tb_r1', pinAt(HUB1, km));
      const q = await quote(w, 'tb_r1', { mode: 'delivery', pin: pinAt(HUB1, km) });
      assert.strictEqual(o.ctx ? 'priced' : o.refusal, want, `${L}: ORDER at ${km} km → ${want} (m3: deliveryFor without maxKm)`);
      assert.strictEqual(q.ctx ? 'priced' : q.refuse.error, want, `${L}: QUOTE at ${km} km → ${want} (m4)`);
      if (!o.ctx) assert.strictEqual(o.httpStatus, 409, `${L}: the order refusal is beyond-the-table's status`);
    }
    const r2 = await deliver(w, 'tb_r2', pinAt(HUB2, 9));
    assert.strictEqual(r2.ctx && r2.ctx.mode, 'delivery', `${L}: no entry → the table top (9 km priced)`);
    const legacyForm = await DW.deliveryFor(w.reader, { rid: 'tb_r1', mode: 'delivery', pin: pinAt(HUB1, 6), getIdentity, app: false });
    assert.strictEqual(legacyForm, null, `${L}: a FORM order stays dark (the limit is app-only; FORMS-UNCHANGED, m14)`);
  });

  await cell('RESUME-GUARD', async (L) => {
    const w = world(); await save(w, { limits: [{ rid: 'tb_r1', km: 4 }] });
    const lp = () => DW.loadPricing(w.reader);
    const far = order('tb_r1', HUB1, pinAt(HUB1, 5));
    assert.deepStrictEqual(await DW.deliveryResumeRefusal(w.reader, far, lp()), { refusal: 'outside_delivery_bands', httpStatus: 409 }, `${L}: a stored pin beyond the lowered limit is not resumed`);
    assert.strictEqual(await DW.deliveryResumeRefusal(w.reader, order('tb_r1', HUB1, pinAt(HUB1, 3)), lp()), null, `${L}: inside → null`);
    // the distance is recomputed from the order's pin to the order's HUB SNAPSHOT — never the rounded snapshot km, never the identity
    assert.deepStrictEqual(await DW.deliveryResumeRefusal(w.reader, { ...far, delivery_snapshot: { ...far.delivery_snapshot, km: 1 } }, lp()), { refusal: 'outside_delivery_bands', httpStatus: 409 }, `${L}: the snapshot km is not the distance (m17)`);
    const movedHub = order('tb_r1', HUB2, pinAt(HUB2, 3));   // the order's own hub snapshot: 3 km — wherever the identity hub is now
    assert.strictEqual(await DW.deliveryResumeRefusal(w.reader, movedHub, lp()), null, `${L}: the hub is the ORDER's snapshot (m16)`);
    for (const k of ['hub_lat', 'hub_lng', 'lat', 'lng']) {
      const o = { ...far }; delete o[k];
      assert.deepStrictEqual(await DW.deliveryResumeRefusal(w.reader, o, lp()), { refusal: 'order_context_changed', httpStatus: 409 }, `${L}: a missing ${k} on an app delivery → order_context_changed`);
      assert.deepStrictEqual(await DW.deliveryResumeRefusal(w.reader, { ...far, [k]: 'x' }, lp()), { refusal: 'order_context_changed', httpStatus: 409 }, `${L}: an invalid ${k} → order_context_changed`);
    }
    const form = { ...far }; delete form.delivery_snapshot;
    assert.strictEqual(await DW.deliveryResumeRefusal(w.reader, form, lp()), null, `${L}: a FORM order (no snapshot) → null`);
    assert.strictEqual(await DW.deliveryResumeRefusal(w.reader, { ...far, order_type: 'pickup', delivery_snapshot: { mode: 'pickup', policy_version: 1 } }, lp()), null, `${L}: a stored pickup → null`);
    assert.strictEqual(await DW.deliveryResumeRefusal(world().reader, far, DW.loadPricing(world().reader)), null, `${L}: no table → null (step 1's grandfathering)`);
    const failDb = { ref: () => ({ get: async () => { throw new Error('down'); } }) };
    assert.deepStrictEqual(await DW.deliveryResumeRefusal(failDb, far), { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }, `${L}: a failed read → 503`);
  });

  await cell('RESUME-CHARGECONTEXT', async (L) => {
    const w = world(); await save(w, { limits: [{ rid: 'tb_r1', km: 4 }] });
    const now = Date.now();
    w.db.root.orders = { o1: order('tb_r1', HUB1, pinAt(HUB1, 5), { active_attempt_id: 'att1' }) };
    w.db.root.payment_attempts = { att1: { hosted_state: 'created', hosted_expires_at: now + 600000 } };
    const dq = { ctx: null };
    assert.deepStrictEqual(await DW.chargeContext(w.reader, 'o1', dq, { order_type: 'delivery' }, now, DW.loadPricing(w.reader)), { refusal: 'outside_delivery_bands', httpStatus: 409, resume: true },
      `${L}: a LIVE grandfathered checkout beyond the lowered limit is not resumed (m5)`);
    w.db.root.orders.o1 = order('tb_r1', HUB1, pinAt(HUB1, 3), { active_attempt_id: 'att1' });
    assert.strictEqual((await DW.chargeContext(w.reader, 'o1', dq, { order_type: 'delivery' }, now, DW.loadPricing(w.reader))).grandfathered, true, `${L}: inside → grandfathered as today`);
  });

  await cell('LIMIT-ZONE-PRECEDENCE', async (L) => {
    const zoneAt = (hub, km) => { const c = north(hub, km); const r = Z.normalizeInput([{ id: 'z_aaaaaaaa', name: 'Z', points: [
      { lat: c.lat - 0.005, lng: c.lng - 0.005 }, { lat: c.lat - 0.005, lng: c.lng + 0.005 }, { lat: c.lat + 0.005, lng: c.lng + 0.005 }, { lat: c.lat + 0.005, lng: c.lng - 0.005 }] }]); assert.ok(r.ok); return r.zones; };
    const w = world(); await save(w, { limits: [{ rid: 'tb_r1', km: 4 }] });
    w.db.root.platform_config.delivery_pricing.no_delivery_zones = zoneAt(HUB1, 5);   // a zone BEYOND the limit (planted: the zones writer needs closed hours)
    const lp = () => DW.loadPricing(w.reader);
    assert.strictEqual((await deliver(w, 'tb_r1', pinAt(HUB1, 5))).refusal, 'outside_delivery_bands', `${L}: beyond the limit AND in a zone → the distance answers first (m18)`);
    assert.strictEqual((await quote(w, 'tb_r1', { mode: 'delivery', pin: pinAt(HUB1, 5) })).refuse.error, 'outside_delivery_bands', `${L}: …on the quote`);
    assert.strictEqual((await DW.deliveryResumeRefusal(w.reader, order('tb_r1', HUB1, pinAt(HUB1, 5)), lp())).refusal, 'outside_delivery_bands', `${L}: …on the resume`);
    w.db.root.platform_config.delivery_pricing.no_delivery_zones = zoneAt(HUB1, 2);
    assert.strictEqual((await deliver(w, 'tb_r1', pinAt(HUB1, 2))).refusal, 'no_delivery_zone', `${L}: inside the limit, in a zone → no_delivery_zone`);
    assert.strictEqual((await DW.deliveryResumeRefusal(w.reader, order('tb_r1', HUB1, pinAt(HUB1, 2)), lp())).refusal, 'no_delivery_zone', `${L}: …on the resume`);
    plant(w, { tb_r1: { max_km: 'x' } });
    assert.strictEqual((await deliver(w, 'tb_r1', pinAt(HUB1, 2))).refusal, 'delivery_pricing_invalid', `${L}: branch-invalid AND in a zone → delivery_pricing_invalid`);
    assert.strictEqual((await DW.deliveryResumeRefusal(w.reader, order('tb_r1', HUB1, pinAt(HUB1, 2)), lp())).refusal, 'delivery_pricing_invalid', `${L}: …on the resume`);
    plant(w, { tb_r1: { max_km: 4 } }); w.db.root.platform_config.delivery_pricing.no_delivery_zones = [{ id: 'z_bad', points: [] }];
    assert.strictEqual((await deliver(w, 'tb_r1', pinAt(HUB1, 5))).refusal, 'outside_delivery_bands', `${L}: malformed zones AND beyond the limit → today's order (the distance first)`);
    assert.strictEqual((await deliver(w, 'tb_r1', pinAt(HUB1, 2))).refusal, 'delivery_zones_invalid', `${L}: malformed zones inside the limit → delivery_zones_invalid`);
    assert.strictEqual((await DW.deliveryResumeRefusal(w.reader, order('tb_r1', HUB1, pinAt(HUB1, 5)), lp())).refusal, 'outside_delivery_bands', `${L}: the resume keeps the fresh order`);
  });

  await cell('SAVE-LIMITS', async (L) => {
    const w = world();
    const r = await save(w, { limits: [{ rid: 'tb_r1', km: 4 }, { rid: 'tb_r2', km: 9.5 }] });
    let s = w.db.get(PATH);
    assert.deepStrictEqual([r.body, s.policy_version, s.restaurants], [{ ok: true, policy_version: 1 }, 1, { tb_r1: { max_km: 4 }, tb_r2: { max_km: 9.5 } }], `${L}: bands + limits in ONE transaction`);
    const sha = (m) => crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
    assert.deepStrictEqual(s.history[0].new.limits, { set: 2, deleted: 0, sha256: sha({ tb_r1: { max_km: 4 }, tb_r2: { max_km: 9.5 } }) }, `${L}: the history summary (count + sha256 of the canonical resulting map)`);
    await save(w, { limits: [{ rid: 'tb_r1', km: 5 }] });
    s = w.db.get(PATH);
    assert.deepStrictEqual(s.restaurants, { tb_r1: { max_km: 5 }, tb_r2: { max_km: 9.5 } }, `${L}: entries NOT named are carried (m7)`);
    await save(w, { limits: [{ rid: 'tb_r1', km: null }] });
    s = w.db.get(PATH);
    assert.deepStrictEqual([s.restaurants, s.history[0].new.limits.deleted], [{ tb_r2: { max_km: 9.5 } }, 1], `${L}: km:null DELETES (m8)`);
    await save(w, { limits: [{ rid: 'tb_r2', km: null }] });
    s = w.db.get(PATH);
    assert.strictEqual('restaurants' in s, false, `${L}: deleting the LAST entry leaves the key ABSENT (never {})`);
  });

  await cell('SAVE-VALIDATION', async (L) => {
    const bad = async (w, limits, reason, status = 400) => {
      const before = JSON.stringify(w.db.get(PATH));
      const r = await w.set({ expected_policy_version: 0, bands: BANDS, limits });
      assert.deepStrictEqual([r.status, r.body.error, r.body.field, r.body.reason], status === 400 ? [400, 'bad_request', 'limits', reason] : [status, r.body.error, undefined, undefined], `${L}: ${JSON.stringify(limits).slice(0, 80)} → ${status} ${reason} (${JSON.stringify(r.body)})`);
      assert.strictEqual(JSON.stringify(w.db.get(PATH)), before, `${L}: nothing written`);
    };
    const w = world();
    for (const km of [0.25, 7.25, 4.1]) await bad(w, [{ rid: 'tb_r1', km }], 'step');
    for (const km of [0, 10, -0.5]) await bad(w, [{ rid: 'tb_r1', km }], 'range');   // 10 = the top (9.5) + 0.5
    await bad(w, [{ rid: 'tb_r1', km: 4 }, { rid: 'tb_r1', km: 5 }], 'duplicate_rid');
    await bad(w, Array.from({ length: 201 }, (_, i) => ({ rid: `r${i}`, km: 4 })), 'too_many');
    for (const rid of ['a/b', '', 'x'.repeat(129), 'a.b']) await bad(w, [{ rid, km: 4 }], 'unknown_rid');
    await bad(w, [{ rid: 'tb_r9', km: 4 }], 'directory_changed');    // well-formed, not registered
    await bad(w, [{ rid: 'tb_r3', km: 4 }], 'directory_changed');    // registered, no identity (m27)
    for (const shape of [{}, [], 'x', [{ rid: 'tb_r1' }], [{ rid: 'tb_r1', km: 4, x: 1 }], [{ rid: 'tb_r1', km: '4' }]]) {
      const r = await w.set({ expected_policy_version: 0, bands: BANDS, limits: shape });
      assert.deepStrictEqual([r.status, r.body.field], [400, 'limits'], `${L}: shape ${JSON.stringify(shape)} → 400 limits`);
    }
    await bad(world({}, { registry: async () => { throw new Error('down'); } }), [{ rid: 'tb_r1', km: 4 }], null, 503);
    await bad(world({}, { registry: async () => ({ ok: true, fresh: false, ids: IDS }) }), [{ rid: 'tb_r1', km: 4 }], null, 503);
    const idFail = world(); const ref0 = idFail.db.ref; idFail.deps.db = { ref: (p) => (String(p).endsWith('/identity') ? { once: async () => { throw new Error('down'); } } : ref0(p)) };
    const r = await A.setDeliveryPricingCore(idFail.deps, req('admin', { expected_policy_version: 0, bands: BANDS, limits: [{ rid: 'tb_r1', km: 4 }] }));
    assert.deepStrictEqual([r.status, idFail.db.get(PATH)], [503, null], `${L}: an identity read failure → 503, nothing written`);
    // the stored-map cap counts the RESULT (m23): ≤ the registry's branch count
    const two = world({}, { ids: ['tb_r1', 'tb_r2'] });
    await save(two, { limits: [{ rid: 'tb_r1', km: 4 }, { rid: 'tb_r2', km: 4 }] });
    assert.ok(true);
  });

  await cell('LEGACY-MAP', async (L) => {
    const w = world(); await save(w, { limits: [{ rid: 'tb_r2', km: 5 }] });
    plant(w, { tb_r1: { active: true, free_delivery: true }, tb_r2: { max_km: 5 } });
    const g = await w.get(); const row = g.body.branches.find((b) => b.rid === 'tb_r1');
    assert.deepStrictEqual([row.max_km, row.effective_km, row.limit_invalid], [null, 9.5, false], `${L}: a legacy entry reads as absent`);
    await save(w, {});
    assert.deepStrictEqual(w.db.get(PATH).restaurants, { tb_r2: { max_km: 5 } }, `${L}: the next save drops the legacy entry and keeps the limits`);
    plant(w, { tb_r1: { active: true, free_delivery: true } }); await save(w, {});
    assert.strictEqual('restaurants' in w.db.get(PATH), false, `${L}: a legacy-only map leaves the key absent (DPW-LEGACY-MAP-DROPPED)`);
  });

  await cell('SAVE-BANDS-ONLY-GOLDEN', async (L) => {
    const w = world();
    const r = await w.set({ expected_policy_version: 0, bands: BANDS });
    const s = w.db.get(PATH);
    assert.deepStrictEqual([r.status, r.body], [200, { ok: true, policy_version: 1 }], `${L}: today's reply`);
    assert.deepStrictEqual(Object.keys(s).sort(), ['bands', 'history', 'policy_version', 'updated_at', 'updated_by'], `${L}: today's node keys exactly`);
    assert.deepStrictEqual(Object.keys(s.history[0].new).sort(), ['bands', 'zones'], `${L}: today's history entry (no limits summary)`);
    await save(w, { limits: [{ rid: 'tb_r1', km: 4 }] });
    const before = w.db.get(PATH).restaurants; const h = w.db.get(PATH).history.length;
    await save(w, { bands: BANDS6 });
    assert.deepStrictEqual([w.db.get(PATH).restaurants, 'limits' in w.db.get(PATH).history[0].new, w.db.get(PATH).history.length], [before, false, h + 1], `${L}: a bands-only save CARRIES the map, unsummarized (m11)`);
  });

  await cell('ZONES-SAVE-CARRIES-LIMITS', async (L) => {
    // the zones writer's nodeOf rebuilds the node: it must carry the map (m19). Zones change only while closed, so the save names
    // the CURRENT zones (no change → no hours lock) — the same nodeOf builds the node
    const w = world(); await save(w, { limits: [{ rid: 'tb_r1', km: 4 }] });
    await save(w, { no_delivery_zones: [] });
    assert.deepStrictEqual(w.db.get(PATH).restaurants, { tb_r1: { max_km: 4 } }, `${L}: a zones-field save keeps the limits`);
  });

  await cell('HISTORY-LIMITS-ROUNDTRIP', async (L) => {
    const w = world();
    for (const over of [{ limits: [{ rid: 'tb_r1', km: 4 }] }, { limits: [{ rid: 'tb_r1', km: 5 }] }, { limits: [{ rid: 'tb_r1', km: null }] }, {}, {}]) await save(w, over);
    const s = w.db.get(PATH);
    assert.ok(A.historyOk(s.history), `${L}: every retained entry is valid`);
    assert.strictEqual(s.history.some((e) => e.history_reset), false, `${L}: no history_reset (m20: a null leaf would reset it)`);
    assert.strictEqual('restaurants' in s, false, `${L}: the key stays absent after the deletion`);
    assert.deepStrictEqual(s.history.map((e) => e.new.limits && [e.new.limits.set, e.new.limits.deleted]), [undefined, undefined, [0, 1], [1, 0], [1, 0]], `${L}: summaries only where limits changed`);
  });

  await cell('READ-ROWS', async (L) => {
    const w = world(); await save(w, { limits: [{ rid: 'tb_r1', km: 4 }, { rid: 'tb_r2', km: 9 }] }); await save(w, { bands: BANDS6 });
    let reads = 0; const ref0 = w.db.ref; w.deps.db = { ref: (p) => { if (p === PATH) reads++; return ref0(p); } };
    const g = await w.get(); const row = (rid) => g.body.branches.find((b) => b.rid === rid);
    const pick = (b) => [b.max_km, b.effective_km, b.above_top, b.limit_invalid, b.limit_editable];
    assert.deepStrictEqual(pick(row('tb_r1')), [4, 4, false, false, true], `${L}: below the top`);
    assert.deepStrictEqual(pick(row('tb_r2')), [9, 6, true, false, true], `${L}: above the top → effective min'd (m12)`);
    assert.deepStrictEqual(pick(row('tb_r3')), [null, 6, false, false, false], `${L}: no identity → not editable`);
    assert.strictEqual(reads, 1, `${L}: no extra policy read`);
    plant(w, { tb_r1: { max_km: 'x' } });
    const g2 = await w.get(); const r1 = g2.body.branches.find((b) => b.rid === 'tb_r1');
    assert.deepStrictEqual(pick(r1), [null, null, false, true, true], `${L}: malformed → limit_invalid, never the top (m21)`);
  });

  await cell('LIMITS-ACCUMULATED-CAP', async (L) => {
    const ids = Array.from({ length: 301 }, (_, i) => `r${String(i).padStart(3, '0')}`);
    const restaurants = Object.fromEntries(ids.map((rid) => [rid, { identity: { name: rid, hub_lat: 15, hub_lng: -88 } }]));
    const w = world({}, { ids, directory: { restaurants } });
    await save(w, { limits: ids.slice(0, 200).map((rid) => ({ rid, km: 9.5 })) });
    await save(w, { limits: ids.slice(200, 300).map((rid) => ({ rid, km: 9.5 })) });
    assert.strictEqual(Object.keys(w.db.get(PATH).restaurants).length, 300, `${L}: 300 entries through successive saves`);
    const r = await w.set({ expected_policy_version: w.db.get(PATH).policy_version, bands: BANDS, limits: [{ rid: ids[300], km: 4 }] });
    assert.deepStrictEqual([r.status, r.body.reason], [400, 'too_many'], `${L}: the 301st entry → too_many on the RESULT (m23)`);
    const bytes = Buffer.byteLength(JSON.stringify(w.db.get(PATH)), 'utf8');
    assert.ok(bytes <= A.READ_BYTES_AT_CAPS, `${L}: the whole node (${bytes} B) ≤ READ_BYTES_AT_CAPS (${A.READ_BYTES_AT_CAPS})`);
  });

  await cell('DEAD-BRANCH-PRUNED', async (L) => {
    let ids = ['tb_r1', 'tb_r2', 'tb_r3'];
    const w = world({}, { registry: async () => ({ ok: true, fresh: true, ids }) });
    await save(w, { limits: [{ rid: 'tb_r1', km: 4 }, { rid: 'tb_r2', km: 5 }] });
    ids = ['tb_r2', 'tb_r3'];
    await save(w, {});
    assert.deepStrictEqual(w.db.get(PATH).restaurants, { tb_r2: { max_km: 5 } }, `${L}: an entry of a deregistered branch is pruned by the next save`);
  });

  if (fails.length) { console.log(`limits FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`limits: OK (${n})`);
})();
