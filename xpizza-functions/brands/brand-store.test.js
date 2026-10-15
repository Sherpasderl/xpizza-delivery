'use strict';
// PLATFORM F1 — brand store over an in-memory fake RTDB (PLAN-F1 r2 §1). Run: node brands/brand-store.test.js
const assert = require('assert');
const S = require('./brand-store');
const { fakeRtdb } = require('../test/_fake-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ident = (over = {}) => ({ name: 'Leg', display_name: 'Leg. Brand', hub_lat: 15.5, hub_lng: -88, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: true,
  delivery_radius_km: 7, hours: {}, active: true, version: 1, ...over });

(async () => {
  // readIdentities: ONE read of `restaurants`; rid → identity (nodes without identity skipped)
  const db0 = fakeRtdb({ restaurants: { a: { identity: ident(), item_availability: { k: 1 } }, b: { factura_config: {} } } });
  assert.deepStrictEqual(await S.readIdentities(db0), { a: ident() });
  assert.deepStrictEqual(db0.reads, ['restaurants']);
  assert.deepStrictEqual(await S.readIdentities(fakeRtdb({})), {});
  ok('readIdentities: one read of restaurants, identities only');

  // planSeedLegacy
  const p = S.planSeedLegacy({ rid: 'leg_a', identity: ident(), existing: null, nowMs: 1000 });
  assert.deepStrictEqual(p, { ok: true, row: { path: 'brands/leg_a', to: { name: 'Leg. Brand', active: true, locations: { leg_a: 'member' }, activation: { state: 'legacy', since: 1000 } } } });
  assert.strictEqual(S.planSeedLegacy({ rid: 'leg_a', identity: ident({ display_name: undefined }), existing: null, nowMs: 1 }).row.to.name, 'Leg', 'name falls back to identity.name');
  assert.strictEqual(S.planSeedLegacy({ rid: 'leg_a', identity: ident({ active: false }), existing: null, nowMs: 1 }).row.to.active, false, 'active mirrors identity.active');
  ok('planSeedLegacy: create plan (display name, else name; active mirrored; since = nowMs)');
  assert.deepStrictEqual(S.planSeedLegacy({ rid: 'leg_a', identity: ident(), existing: { ...p.row.to, activation: { state: 'legacy', since: 5 } }, nowMs: 9 }), { ok: true, noop: true }, 'identical (since ignored) → no-op');
  for (const [args, why] of [
    [{ rid: 'Bad', identity: ident() }, 'bad rid'], [{ rid: 'unknown', identity: ident() }, 'reserved rid'], [{ rid: 'leg_a', identity: null }, 'missing identity'],
    [{ rid: 'leg_a', identity: ident({ active: 'x' }) }, 'identity not routing-valid'], [{ rid: 'leg_a', identity: ident({ brand_id: 'other' }) }, 'foreign brand_id'],
    [{ rid: 'leg_a', identity: ident(), existing: { ...p.row.to, locations: { leg_a: 'member', b: 'member' } } }, 'a different existing record'],
    [{ rid: 'leg_a', identity: ident({ display_name: undefined, name: ' Leg' }) }, 'generated name padded (validateBrand; isRoutingValid accepts it)'],
    [{ rid: 'leg_a', identity: ident({ display_name: undefined, name: 'x'.repeat(81) }) }, 'generated name 81 chars'],
  ]) assert.strictEqual(S.planSeedLegacy({ existing: null, nowMs: 1, ...args }).ok, false, why);
  ok('planSeedLegacy: refuses bad / reserved rid, missing / invalid identity, foreign brand_id, a different record, a generated record validateBrand rejects');

  // applySeedLegacy
  let db = fakeRtdb({});
  assert.deepStrictEqual(await S.applySeedLegacy(db, p), { ok: true });
  assert.deepStrictEqual(db.data.brands.leg_a, p.row.to);
  db = fakeRtdb({});
  db.beforeTxn = () => { db.data.brands = { leg_a: { name: 'Other' } }; };
  const race = await S.applySeedLegacy(db, p);
  assert.strictEqual(race.ok, false, 'a node created after the plan aborts the create-only transaction');
  assert.deepStrictEqual(db.data.brands.leg_a, { name: 'Other' }, 'and leaves the other writer untouched');
  assert.strictEqual(db.sets, 0, 'never a plain set');
  ok('applySeedLegacy: create-only transaction + read-back; a concurrent create aborts it untouched');

  // planPublish / applyPublish
  const TB = { name: 'Third', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 2 } };
  const br = ident({ brand_id: 'tb_brand', location_name: 'Centro', zone: { type: 'circle', radius_km: 7 }, prep_default_min: 25, hours: { mon: { open: false } } });
  const pp = S.planPublish({ brandId: 'tb_brand', brand: TB, identities: { tb_centro: br }, current: null });
  assert.strictEqual(pp.ok, true, JSON.stringify(pp.errors));
  assert.strictEqual(pp.row.path, 'public/brands/tb_brand'); assert.strictEqual(pp.row.from, null); assert.strictEqual(pp.changed, true);
  assert.strictEqual(S.planPublish({ brandId: 'tb_brand', brand: TB, identities: { tb_centro: br }, current: pp.row.to }).changed, false, 'unchanged → changed:false');
  assert.strictEqual(S.planPublish({ brandId: 'tb_brand', brand: TB, identities: {}, current: null }).ok, false, 'builder refusal propagates');
  db = fakeRtdb({});
  assert.deepStrictEqual(await S.applyPublish(db, pp), { ok: true });
  assert.deepStrictEqual(db.data.public.brands.tb_brand, pp.row.to);
  ok('planPublish / applyPublish: changed flag, refusal propagates, written and read back');

  console.log(`brand-store: OK (${n})`);
})().catch((e) => { console.error('brand-store FAILED:', e); process.exit(1); });
