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
    [{ rid: 'leg_a', identity: ident(), existing: { ...p.row.to, locations: { leg_a: 'member', b: 'member' } } }, 'a different existing record (invalid)'],
    [{ rid: 'leg_a', identity: ident(), existing: { ...p.row.to, name: 'Renamed' } }, 'a VALID existing legacy record with a different name'],
    [{ rid: 'leg_a', identity: ident(), existing: { ...p.row.to, active: false } }, 'a VALID existing legacy record with a different active'],
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
  assert.deepStrictEqual(await S.applyPublish(db, pp), { ok: true }, 'the first publish over an ABSENT projection writes');
  assert.deepStrictEqual(db.data.public.brands.tb_brand, pp.row.to);
  ok('planPublish / applyPublish: changed flag, refusal propagates, written and read back');

  // orchestration §6 — fenced publication: source = {gen, versions:{member rid: identity version}}
  assert.deepStrictEqual(pp.row.to.source, { gen: 0, versions: { tb_centro: 1 } }, 'no projection_gen yet → gen 0');
  const TBg = { ...TB, projection_gen: 4, locations: { tb_centro: 'member', tb_norte: 'staged' } };
  assert.deepStrictEqual(S.projectionSource(TBg, { tb_centro: br, tb_norte: ident({ version: 9 }) }), { gen: 4, versions: { tb_centro: 1 } }, 'members only');
  // RTDB drops empty objects: a brand with NO member (all staged — a new brand before opening — or all retired) must not carry
  // `versions: {}`, or the read-back never equals what was written (false superseded_after_write) and a re-plan never reports unchanged.
  const rtdbShape = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length ? undefined : x)));
  for (const locations of [{ tb_centro: 'retired' }, { tb_centro: 'staged' }, {}]) {
    const B0 = { ...TB, projection_gen: 2, locations };
    assert.deepStrictEqual(S.projectionSource(B0, { tb_centro: br }), { gen: 2 }, `O1a-SRC-EMPTY no member (${JSON.stringify(locations)}) → no versions key`);
  }
  const ppR = S.planPublish({ brandId: 'tb_brand', brand: { ...TB, locations: { tb_centro: 'retired' } }, identities: { tb_centro: br }, current: null });
  assert.strictEqual(ppR.ok, true, JSON.stringify(ppR.errors));
  assert.deepStrictEqual(rtdbShape(ppR.row.to), ppR.row.to, 'O1a-SRC-EMPTY the all-retired projection survives an RTDB round-trip unchanged');
  assert.strictEqual(S.planPublish({ brandId: 'tb_brand', brand: { ...TB, locations: { tb_centro: 'retired' } }, identities: { tb_centro: br }, current: rtdbShape(ppR.row.to) }).changed, false,
    'O1a-SRC-EMPTY a re-plan over the stored (RTDB-shaped) projection reports unchanged');
  assert.strictEqual(S.compareSource({ gen: 2 }, { gen: 2 }), 'equal', 'a versions-less source compares equal to itself');
  const C = S.compareSource;
  const src = (gen, versions) => ({ gen, versions });
  assert.strictEqual(C(src(1, { a: 1 }), src(1, { a: 1 })), 'equal');
  assert.strictEqual(C(src(1, { a: 2 }), src(1, { a: 1 })), 'newer');
  assert.strictEqual(C(src(2, { a: 1, b: 1 }), src(1, { a: 1 })), 'newer', 'a member added: gen covers the new component');
  assert.strictEqual(C(src(2, { a: 1 }), src(1, { a: 1, b: 3 })), 'newer', 'a member left: gen covers the dropped component');
  assert.strictEqual(C(src(1, { a: 1 }), src(1, { a: 2 })), 'older');
  assert.strictEqual(C(src(1, { a: 5 }), src(2, { a: 1 })), 'incomparable', 'newer identity read with an older brand read');
  assert.strictEqual(C(src(1, { a: 2, b: 1 }), src(1, { a: 1, b: 2 })), 'incomparable');
  assert.strictEqual(C(src(1, { a: 1, b: 1 }), src(1, { a: 1 })), 'incomparable', 'same gen, different member sets');
  assert.strictEqual(C(src(0, { a: 1 }), undefined), 'newer', 'a pre-v2 projection (no source) is always superseded');
  ok('compareSource: equal / newer / older / incomparable — component-wise, gen covers membership; an unstamped projection is older');

  const v = (ver, over = {}) => ({ brand: TB, identities: { tb_centro: { ...br, version: ver, ...over } } });
  const planOf = (st) => S.planPublish({ brandId: 'tb_brand', ...st, current: null });
  db = fakeRtdb({ public: { brands: { tb_brand: { name: 'Third' } } } });   // a pre-v2 projection
  assert.deepStrictEqual(await S.applyPublish(db, planOf(v(2))), { ok: true }, 'a stamped publish supersedes a pre-v2 projection');
  assert.deepStrictEqual(db.data.public.brands.tb_brand.source, { gen: 0, versions: { tb_centro: 2 } });
  const sets0 = db.sets;
  assert.deepStrictEqual(await S.applyPublish(db, planOf(v(1, { location_name: 'Viejo' }))), { ok: false, error: 'superseded' }, 'a late OLDER publisher never overwrites');
  assert.strictEqual(db.data.public.brands.tb_brand.locations.tb_centro.location_name, 'Centro');
  assert.deepStrictEqual(await S.applyPublish(db, planOf(v(2))), { ok: true, unchanged: true }, 'equal source → no write');
  assert.strictEqual(db.sets, sets0, 'publication never uses a plain set');
  assert.deepStrictEqual(await S.applyPublish(db, S.planPublish({ brandId: 'tb_brand', brand: { ...TB, projection_gen: 1 }, identities: { tb_centro: { ...br, version: 1 } }, current: null })),
    { ok: false, error: 'incomparable' }, 'an incomparable source is refused');
  assert.deepStrictEqual(db.data.public.brands.tb_brand.source, { gen: 0, versions: { tb_centro: 2 } }, 'incomparable → nothing written');
  ok('applyPublish (fenced transaction): older → superseded untouched; equal → no write; incomparable → refused; read-back compares source');

  // publishBrandProjection: read → plan → fenced apply; an incomparable mixed read re-reads (≤ 3), then ONE admin alert
  db = fakeRtdb({ brands: { tb_brand: TB }, restaurants: { tb_centro: { identity: { ...br, version: 3 } } } });
  assert.deepStrictEqual(await S.publishBrandProjection(db, 'tb_brand', { now: 50 }), { ok: true, source: { gen: 0, versions: { tb_centro: 3 } } }, 'publishBrandProjection publishes and reads back');
  assert.deepStrictEqual(await S.publishBrandProjection(db, 'tb_brand', { now: 51 }), { ok: true, unchanged: true, source: { gen: 0, versions: { tb_centro: 3 } } }, 'a repeat publish is unchanged');
  let flips = 0;   // every read sees a newer brand gen than the stored projection's but an OLDER identity version → incomparable each time
  db.data.public.brands.tb_brand.source = { gen: 0, versions: { tb_centro: 9 } };
  db.data.brands.tb_brand.projection_gen = 1;
  db.beforeTxn = function again() { flips += 1; db.beforeTxn = again; };
  assert.deepStrictEqual(await S.publishBrandProjection(db, 'tb_brand', { now: 52 }), { ok: false, error: 'projection_unfenced' }, 'projection_unfenced after 3 incomparable reads');
  assert.strictEqual(flips, 4, '3 fenced attempts + the create-only alert');
  assert.deepStrictEqual(db.data.dispatcher_alerts.projection_unfenced_tb_brand, { type: 'projection_unfenced', brand_id: 'tb_brand', created_at: 52 });
  db.beforeTxn = null;
  assert.strictEqual((await S.publishBrandProjection(fakeRtdb({ brands: { tb_brand: TB } }), 'tb_brand', { now: 1 })).error, 'refused', 'an invalid brand state is never published');
  assert.deepStrictEqual(await S.publishBrandProjection(fakeRtdb({}), 'tb_brand', { now: 1 }), { ok: false, error: 'brand_not_found' });
  ok('publishBrandProjection: publishes + reads back; repeat unchanged; 3 incomparable reads → projection_unfenced + one create-only alert; refusal / missing brand never publish');

  console.log(`brand-store: OK (${n})`);
})().catch((e) => { console.error('brand-store FAILED:', e); process.exit(1); });
