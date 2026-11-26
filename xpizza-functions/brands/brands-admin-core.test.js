'use strict';
// PLATFORM F1 — the brands CLI core: exit codes and WRITE COUNTS (zero writes without --apply). Run: node brands/brands-admin-core.test.js
const assert = require('assert');
const { runBrandsAdmin } = require('./brands-admin-core');
const { fakeRtdb } = require('../test/_fake-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ident = (over = {}) => ({ name: 'Leg', hub_lat: 15.5, hub_lng: -88, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: true,
  delivery_radius_km: 7, hours: { mon: { open: false } }, active: true, version: 1, ...over });
const branch = (over = {}) => ident({ brand_id: 'tb_brand', location_name: 'Centro', zone: { type: 'circle', radius_km: 7 }, prep_default_min: 25, ...over });
const TB = { name: 'Third', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 2 } };
const seedState = () => ({ restaurants: { leg_a: { identity: ident() }, tb_centro: { identity: branch() } }, brands: { tb_brand: TB } });
const writes = (db) => db.sets + db.txns;
const run = async (db, op, id, apply) => { const lines = []; const code = await runBrandsAdmin({ rtdb: db, op, id, apply, nowMs: 1000, log: (l) => lines.push(l) }); return { code, out: lines.join('\n') }; };

(async () => {
  let db = fakeRtdb(seedState());
  let r = await run(db, 'seed-legacy', 'leg_a', false);
  assert.strictEqual(r.code, 0); assert.strictEqual(writes(db), 0, 'seed-legacy dry run: 0 writes'); assert.match(r.out, /DRY RUN/);
  r = await run(db, 'publish', 'tb_brand', false);
  assert.strictEqual(r.code, 0); assert.strictEqual(writes(db), 0, 'publish dry run: 0 writes'); assert.match(r.out, /DRY RUN/);
  ok('seed-legacy and publish without --apply: exit 0, ZERO writes');

  r = await run(db, 'seed-legacy', 'leg_a', true);
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual(writes(db), 1, 'seed-legacy --apply: exactly 1 write');
  assert.deepStrictEqual(db.data.brands.leg_a.locations, { leg_a: 'member' });
  r = await run(db, 'publish', 'tb_brand', true);
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual(writes(db), 2, 'publish --apply: exactly 1 more write');
  assert.strictEqual(db.data.public.brands.tb_brand.name, 'Third');
  ok('with --apply: exactly one write each, read back');

  r = await run(db, 'seed-legacy', 'leg_a', true);
  assert.strictEqual(r.code, 0); assert.strictEqual(writes(db), 2, 'identical re-run: 0 writes');
  r = await run(db, 'publish', 'tb_brand', true);
  assert.strictEqual(r.code, 0); assert.strictEqual(writes(db), 2, 'unchanged publish: 0 writes');
  ok('re-runs: identical seed and unchanged publish write nothing');

  // orchestration §6: a stored projection stamped NEWER than this read is never overwritten — exit 1, named, nothing written
  db.data.public.brands.tb_brand.source = { gen: 0, versions: { tb_centro: 9 } };
  db.data.restaurants.tb_centro.identity.location_name = 'Viejo';
  const before = JSON.stringify(db.data.public.brands.tb_brand);
  r = await run(db, 'publish', 'tb_brand', true);
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /REFUSED \(fenced\) — superseded/);
  assert.strictEqual(JSON.stringify(db.data.public.brands.tb_brand), before, 'the newer projection is untouched');
  ok('publish over a NEWER stored projection: exit 1 "REFUSED (fenced) — superseded", nothing overwritten');

  r = await run(db, 'status', undefined, false);
  assert.strictEqual(r.code, 0, r.out); assert.deepStrictEqual(JSON.parse(r.out).findings, []);
  db = fakeRtdb({ ...seedState(), restaurants: { tb_centro: { identity: branch({ brand_id: 'other_b' }) } } });
  r = await run(db, 'status', undefined, true);
  assert.strictEqual(r.code, 1); assert.ok(JSON.parse(r.out).findings.length > 0); assert.strictEqual(writes(db), 0, 'status never writes');
  ok('status: consistent → exit 0; a finding → exit 1; never writes (even with --apply)');

  // codex build r1 P2 — status never fails open on a malformed /brands root or an invalid brand
  const unbranded = { leg_a: { identity: ident() } };   // no identity claims a brand, so an empty /brands is consistent
  db = fakeRtdb({ restaurants: unbranded });
  r = await run(db, 'status', undefined, false);
  assert.strictEqual(r.code, 0, `absent /brands = empty, OK\n${r.out}`); assert.deepStrictEqual(JSON.parse(r.out).findings, []);
  for (const [label, root] of [['false', false], ['42', 42], ['a numeric-key array', [TB]], ['a string', 'x']]) {
    db = fakeRtdb({ restaurants: unbranded, brands: root });
    r = await run(db, 'status', undefined, false);
    assert.strictEqual(r.code, 1, `/brands = ${label} → non-zero exit\n${r.out}`);
    assert.ok(JSON.parse(r.out).findings.some((f) => f.code === 'brands_root_invalid'), `/brands = ${label} → a brands_root_invalid finding`);
  }
  db = fakeRtdb({ restaurants: seedState().restaurants, brands: { tb_brand: TB, bad_b: { name: 'Bad' } } });
  r = await run(db, 'status', undefined, false);
  assert.strictEqual(r.code, 1, 'one invalid brand → non-zero exit');
  assert.strictEqual(JSON.parse(r.out).brands.bad_b.valid, false);
  assert.ok(JSON.parse(r.out).findings.some((f) => f.code === 'brand_invalid' && f.brandId === 'bad_b'), 'the invalid brand is a finding');
  ok('status: absent /brands → exit 0; scalar / array root → brands_root_invalid, exit 1; any valid:false brand → finding, exit 1');

  db = fakeRtdb(seedState());
  assert.strictEqual((await run(db, 'seed-legacy', 'nobody', true)).code, 1, 'refused seed → exit 1');
  assert.strictEqual((await run(db, 'publish', 'nobody', true)).code, 1, 'refused publish → exit 1');
  assert.strictEqual((await run(db, 'frobnicate', 'x', true)).code, 2, 'unknown op → 2');
  assert.strictEqual((await run(db, 'seed-legacy', undefined, true)).code, 2, 'missing id → 2');
  assert.strictEqual(writes(db), 0, 'refusals and usage errors write nothing');
  ok('refusals → exit 1, usage → exit 2, zero writes');

  // ML r4 §1 E2 rollout gate — `resolution`: every restaurant identity resolves through brandIdOf; 'unknown' is a finding (G1 would
  // refuse that restaurant's intake). The legacy founders are DATA seeded through the REAL writer (seed-legacy), never a literal.
  const twoLegacy = () => ({ restaurants: { leg_a: { identity: ident() }, leg_b: { identity: ident({ name: 'Leg B' }) }, tb_centro: { identity: branch() } }, brands: { tb_brand: TB } });
  db = fakeRtdb(twoLegacy());
  r = await run(db, 'resolution', undefined, true);
  assert.strictEqual(r.code, 1, `unseeded legacy restaurants → exit 1\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(r.out).findings, [{ code: 'unresolved', rid: 'leg_a' }, { code: 'unresolved', rid: 'leg_b' }], 'each unseeded restaurant is named');
  assert.strictEqual(JSON.parse(r.out).resolution.tb_centro, 'tb_brand', 'a branch resolves to its brand_id');
  for (const rid of ['leg_a', 'leg_b']) assert.strictEqual((await run(db, 'seed-legacy', rid, true)).code, 0, `the real writer seeds ${rid}`);
  const seeded = writes(db);
  r = await run(db, 'resolution', undefined, true);
  assert.strictEqual(r.code, 0, `seeded → exit 0\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(r.out), { resolution: { leg_a: 'leg_a', leg_b: 'leg_b', tb_centro: 'tb_brand' }, legacy_self: ['leg_a', 'leg_b'], findings: [] });
  assert.strictEqual(writes(db), seeded, 'resolution never writes (even with --apply)');
  assert.doesNotMatch(r.out, /hub_lat|phone|whatsapp|Leg B/, 'names / ids only: no identity values printed');
  ok('resolution: unseeded legacy restaurants → «unresolved», exit 1; after the REAL seed-legacy → each resolves to ITSELF, exit 0; never writes; ids only');

  db = fakeRtdb(twoLegacy());
  for (const rid of ['leg_a', 'leg_b']) await run(db, 'seed-legacy', rid, true);
  db.data.restaurants.leg_a.identity.brand_id = 'leg_a';
  r = await run(db, 'resolution', undefined, false);
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual(JSON.parse(r.out).resolution.leg_a, 'leg_a');
  ok('resolution: identity.brand_id === its own rid on a legacy brand → still itself');

  db = fakeRtdb(twoLegacy());
  for (const rid of ['leg_a', 'leg_b']) await run(db, 'seed-legacy', rid, true);
  db.data.brands.leg_a.activation.state = 'off';   // a founder flipped out of legacy with no brand_id on its identity
  r = await run(db, 'resolution', undefined, false);
  assert.strictEqual(r.code, 1, `NOT-LEGACY: exit 1\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(r.out).findings, [{ code: 'unresolved', rid: 'leg_a' }], 'NOT-LEGACY: a non-legacy record without brand_id does not resolve to itself');
  ok('resolution: a founder whose record is no longer legacy → unresolved');

  db = fakeRtdb(twoLegacy());
  for (const rid of ['leg_a', 'leg_b']) await run(db, 'seed-legacy', rid, true);
  db.data.brands.leg_a.name = ' Leg';   // legacy, but invalid (padded name)
  r = await run(db, 'resolution', undefined, false);
  assert.strictEqual(r.code, 1, `INVALID: exit 1\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(r.out).findings, [{ code: 'unresolved', rid: 'leg_a' }], 'INVALID: an invalid legacy record does not resolve');
  ok('resolution: an invalid legacy record → unresolved');

  // Codex #383 P2: a NON-legacy brand whose id equals its member rid (identity.brand_id === rid) resolves to itself through brandIdOf,
  // but it is not a legacy founder — legacy_self requires the brand record's activation.state === 'legacy' too
  db = fakeRtdb(twoLegacy());
  for (const rid of ['leg_a', 'leg_b']) await run(db, 'seed-legacy', rid, true);
  db.data.restaurants.tb_self = { identity: branch({ brand_id: 'tb_self' }) };
  db.data.brands.tb_self = { name: 'Self', active: true, locations: { tb_self: 'member' }, activation: { state: 'off', since: 3 } };
  r = await run(db, 'resolution', undefined, false);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(JSON.parse(r.out).resolution.tb_self, 'tb_self', 'an explicit self brand_id resolves to itself');
  assert.deepStrictEqual(JSON.parse(r.out).legacy_self, ['leg_a', 'leg_b'], 'SELF-NOT-LEGACY: an off brand with brand_id === rid is not legacy_self');
  ok('resolution: an off brand whose id is its own rid resolves to itself but is NOT legacy_self');

  for (const [label, root] of [['42', 42], ['a numeric-key array', [TB]]]) {
    db = fakeRtdb({ restaurants: twoLegacy().restaurants, brands: root });
    r = await run(db, 'resolution', undefined, false);
    assert.strictEqual(r.code, 1, `/brands = ${label} → exit 1`);
    assert.ok(JSON.parse(r.out).findings.some((f) => f.code === 'brands_root_invalid'), `/brands = ${label} → brands_root_invalid`);
  }
  ok('resolution: a malformed /brands root → brands_root_invalid, exit 1 (never fails open)');

  console.log(`brands-admin-core: OK (${n})`);
})().catch((e) => { console.error('brands-admin-core FAILED:', e); process.exit(1); });
