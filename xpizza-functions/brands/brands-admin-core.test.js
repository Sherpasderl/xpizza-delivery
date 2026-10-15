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

  console.log(`brands-admin-core: OK (${n})`);
})().catch((e) => { console.error('brands-admin-core FAILED:', e); process.exit(1); });
