'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2, §3, §4, §6) — the SHERPA-admin branches CLI core over the faithful
// in-memory RTDB: every mutation command is a DRY RUN (ZERO writes, the plan printed) unless `apply`; with apply it writes through
// branch-store and then republishes the brand projection (a write whose projection is refused exits 1, named). Exit codes: 0 ok /
// dry run / no-op, 1 refusal, 2 usage. Run: node branches/branches-admin-core.test.js
const assert = require('assert');
const { runBranchesAdmin, parseOpts } = require('./branches-admin-core');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = 1_800_000_000_000;
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const DRAFT = { brand_id: 'tb_brand', location_name: 'Centro', phone: '+50499990000', hours: H7, prep_default_min: 20, created_at: 1, created_by: 'own1', op_id: 'op1' };
const NORTE = { name: 'Third', brand_id: 'tb_brand', location_name: 'Norte', phone: '+50499990001', hours: H7, prep_default_min: 20, hub_lat: 15.6, hub_lng: -88.0,
  address_line: 'Calle 1', zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false, active: true, active_changed_at: 1, version: 3 };
const BOUNDS = { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 };
const state = (over = {}) => ({
  brands: { tb_brand: { name: 'Third', active: true, locations: { tb_norte: 'member' }, activation: { state: 'on', since: 1 } } },
  restaurants: { tb_norte: { identity: NORTE }, tb_brand_centro: { draft: DRAFT } },
  rid_reservations: { tb_brand_centro: { op_id: 'op1', brand_id: 'tb_brand' } }, platform_config: { service_bounds: BOUNDS }, ...over });
const run = async (db, op, id, opts = {}, apply = false) => {
  const lines = [];
  const code = await runBranchesAdmin({ rtdb: db, op, id, opts, apply, nowMs: NOW, callId: 'cli1', log: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
};

(async () => {
  // argv → opts
  assert.deepStrictEqual(parseOpts(['--lat', '15.5', '--lng', '-88.03', '--address', 'Blvd 1', '--reference', 'frente al parque', '--radius', '4', '--expected-version', '3',
    '--location-name', 'Centro', '--prep', '20', '--open', 'tb_a,tb_b']),
  { lat: 15.5, lng: -88.03, address: 'Blvd 1', reference: 'frente al parque', radius: 4, expectedVersion: 3, locationName: 'Centro', prep: 20, open: ['tb_a', 'tb_b'] });
  assert.deepStrictEqual(parseOpts(['--lat', 'x']), { error: '--lat must be a number' });
  assert.deepStrictEqual(parseOpts(['--bogus', '1']), { error: 'unknown flag --bogus' });
  assert.deepStrictEqual(parseOpts(['--lat']), { error: '--lat needs a value' });
  ok('parseOpts: numbers parsed, --open split, an unknown / valueless / non-numeric flag is an error (never ignored)');

  // usage
  for (const [op, id] of [[undefined, undefined], ['materialize', undefined], ['nonsense', 'x']]) assert.strictEqual((await run(fakeRtdb(state()), op, id)).code, 2, `${op} ${id} → usage`);
  ok('usage errors exit 2');

  // materialize: dry run = the planned identity, ZERO writes; apply = staged + projection republished
  {
    const db = fakeRtdb(state());
    const loc = { lat: 15.51, lng: -88.03, address: 'Blvd 1' };
    let r = await run(db, 'materialize', 'tb_brand_centro', loc);
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /DRY RUN/); assert.match(r.out, /"hub_lat": 15.51/); assert.deepStrictEqual(db.writes, [], 'dry run: ZERO writes');
    r = await run(db, 'materialize', 'tb_brand_centro', { ...loc, lat: 99 });
    assert.strictEqual(r.code, 1); assert.match(r.out, /REFUSED — bad_location: (bad_hub|out_of_bounds)/);
    r = await run(db, 'materialize', 'tb_brand_centro', loc, true);
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /staged/); assert.match(r.out, /projection published/);
    assert.strictEqual(db.get('brands/tb_brand/locations/tb_brand_centro'), 'staged');
    assert.deepStrictEqual(db.get('public/brands/tb_brand/source'), { gen: 1, versions: { tb_norte: 3 } }, 'republished at the new gen (staged never projected)');
  }
  ok('materialize: dry run prints the planned identity with ZERO writes; a bad location is refused (exit 1, named); apply stages it and republishes the projection');

  // set-location: dry run reports the guard (live orders) without writing; apply moves an OFF drained branch
  {
    const offId = { ...NORTE, active: false, active_changed_at: NOW - 11 * 60_000 };
    const db = fakeRtdb(state({ restaurants: { tb_norte: { identity: offId } }, orders: { o1: { restaurant_id: 'tb_norte', status: 'preparing' } } }));
    let r = await run(db, 'set-location', 'tb_norte', { lat: 15.62, lng: -88.01, expectedVersion: 3 });
    assert.strictEqual(r.code, 1); assert.match(r.out, /REFUSED — refused: branch_has_live_orders/); assert.deepStrictEqual(db.writes, []);
    db.root.orders.o1.status = 'delivered';
    r = await run(db, 'set-location', 'tb_norte', { lat: 15.62, lng: -88.01, expectedVersion: 3 });
    assert.strictEqual(r.code, 0); assert.match(r.out, /"hub_lat": 15.62/); assert.deepStrictEqual(db.writes, [], 'dry run: ZERO writes');
    r = await run(db, 'set-location', 'tb_norte', { lat: 15.62, lng: -88.01 });
    assert.strictEqual(r.code, 2, '--expected-version is required');
    r = await run(db, 'set-location', 'tb_norte', { lat: 15.62, lng: -88.01, expectedVersion: 3 }, true);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual([db.get('restaurants/tb_norte/identity/hub_lat'), db.get('restaurants/tb_norte/identity/version')], [15.62, 4]);
    assert.deepStrictEqual(db.get('public/brands/tb_brand/locations/tb_norte/hub'), { lat: 15.62, lng: -88.01 }, 'the projection carries the move');
  }
  ok('set-location: the live-order guard refuses in the dry run too (nothing written); --expected-version required; apply moves the pin (version +1) and republishes');

  // a write whose projection is REFUSED afterwards is never reported as success (exit 1, named)
  {
    const offId = { ...NORTE, active: false, active_changed_at: NOW - 11 * 60_000 };
    const db = fakeRtdb(state({ brands: { tb_brand: { name: 'Third', active: true, locations: { tb_norte: 'member', tb_mal: 'member' }, activation: { state: 'on', since: 1 } } },
      restaurants: { tb_norte: { identity: offId }, tb_mal: { identity: { name: 'Third', brand_id: 'tb_brand' } } } }));
    const r = await run(db, 'set-location', 'tb_norte', { lat: 15.62, lng: -88.01, expectedVersion: 3 }, true);
    assert.strictEqual(r.code, 1, 'a refused projection after the write exits 1');
    assert.match(r.out, /written; projection NOT published — refused/, 'and says the write landed but the projection did not');
    assert.strictEqual(db.get('restaurants/tb_norte/identity/hub_lat'), 15.62, 'the write itself stands');
  }
  ok('a write whose projection is refused afterwards exits 1, named ("written; projection NOT published")');

  // enrich-legacy: a legacy brand's projection refusal after the write is surfaced (exit 1), never silent
  {
    const leg = { ...NORTE, brand_id: undefined, location_name: undefined, zone: undefined, prep_default_min: undefined, version: 1 };
    const db = fakeRtdb({ brands: { tb_leg: { name: 'L', active: true, locations: { tb_leg: 'member' }, activation: { state: 'legacy', since: 1 } } }, restaurants: { tb_leg: { identity: JSON.parse(JSON.stringify(leg)) } } });
    let r = await run(db, 'enrich-legacy', 'tb_leg', { expectedVersion: 1, locationName: 'Centro', prep: 20 });
    assert.strictEqual(r.code, 0); assert.match(r.out, /"location_name": "Centro"/); assert.deepStrictEqual(db.writes, []);
    r = await run(db, 'enrich-legacy', 'tb_leg', { expectedVersion: 1, locationName: 'Centro', prep: 20 }, true);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual([db.get('restaurants/tb_leg/identity/brand_id'), db.get('restaurants/tb_leg/identity/version')], ['tb_leg', 2]);
    assert.deepStrictEqual(db.get('public/brands/tb_leg/source'), { gen: 0, versions: { tb_leg: 2 } });
  }
  ok('enrich-legacy: dry run prints the additive patch with ZERO writes; apply writes it (version +1) and the now-complete legacy branch publishes');

  // resume / delete-draft
  {
    const db = fakeRtdb(state({ branch_ops: { tb_brand_centro: { kind: 'materialize', op_id: 'c0', inputs: { brand_id: 'tb_brand', location: {}, identity: { ...NORTE, location_name: 'Centro', active: false, version: 1 } },
      payload_hash: 'h', lease: { call_id: 'c0', until: NOW - 1 }, step: 'start', rid: 'tb_brand_centro', started_at: 1, updated_at: 1 } } }));
    let r = await run(db, 'resume', 'tb_brand_centro');
    assert.strictEqual(r.code, 0); assert.match(r.out, /materialize/); assert.deepStrictEqual(db.writes, []);
    r = await run(db, 'delete-draft', 'tb_brand_centro', {}, true);
    assert.strictEqual(r.code, 1); assert.match(r.out, /op_in_progress/, 'a draft under an unfinished op is not deleted');
    r = await run(db, 'resume', 'tb_brand_centro', {}, true);
    assert.strictEqual(r.code, 0, r.out); assert.strictEqual(db.get('brands/tb_brand/locations/tb_brand_centro'), 'staged');
    assert.strictEqual((await run(db, 'resume', 'tb_brand_centro', {}, true)).code, 0, 'nothing to resume → no-op');
    const db2 = fakeRtdb(state());
    r = await run(db2, 'delete-draft', 'tb_brand_centro');
    assert.strictEqual(r.code, 0); assert.deepStrictEqual(db2.writes, []);
    r = await run(db2, 'delete-draft', 'tb_brand_centro', {}, true);
    assert.strictEqual(r.code, 0, r.out); assert.strictEqual(db2.get('restaurants/tb_brand_centro'), null); assert.strictEqual(db2.get('rid_reservations/tb_brand_centro'), null);
  }
  ok('resume: dry run shows the unfinished op; apply finishes it from its durable inputs; nothing to resume → no-op. delete-draft: refused under an unfinished op; dry run ZERO writes; apply removes draft + reservation');

  // activate-brand / deactivate-brand (dry run = every readiness check, no write) + resync-projection
  {
    const db = fakeRtdb(state({ brands: { tb_brand: { name: 'Third', active: true, locations: { tb_norte: 'staged' }, activation: { state: 'off', since: 1 } } },
      restaurants: { tb_norte: { identity: { ...NORTE, active: false } } } }));
    let r = await run(db, 'activate-brand', 'tb_brand', { open: ['tb_norte'] });
    assert.strictEqual(r.code, 1); assert.match(r.out, /not_ready/); assert.match(r.out, /no_owner_or_manager/); assert.deepStrictEqual(db.writes, []);
    r = await run(db, 'deactivate-brand', 'tb_brand', {}, true);
    assert.strictEqual(r.code, 1); assert.match(r.out, /not_on/);
    const on = fakeRtdb(state());
    r = await run(on, 'deactivate-brand', 'tb_brand');
    assert.strictEqual(r.code, 0); assert.deepStrictEqual(on.writes, []);
    r = await run(on, 'deactivate-brand', 'tb_brand', {}, true);
    assert.strictEqual(r.code, 0, r.out); assert.strictEqual(on.get('brands/tb_brand/activation/state'), 'off');

    const rs = fakeRtdb(state({ public: { brands: { tb_brand: { name: 'Third', source: { gen: 0, versions: { tb_norte: 3 } } } } } }));   // stale content, equal source
    r = await run(rs, 'resync-projection', 'tb_norte');
    assert.strictEqual(r.code, 0); assert.match(r.out, /version 3 → 4/); assert.deepStrictEqual(rs.writes, []);
    r = await run(rs, 'resync-projection', 'tb_norte', {}, true);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(rs.get('public/brands/tb_brand/source'), { gen: 0, versions: { tb_norte: 4 } });
    assert.strictEqual(rs.get('public/brands/tb_brand/locations/tb_norte/location_name'), 'Norte', 'the stale projection now carries the identity');
  }
  ok('activate-brand: the dry run runs every readiness check (no team reader → not_ready, nothing written); deactivate-brand dry/apply; resync-projection bumps version only and the fenced publish lands the stale content');

  // create-brand (advisor ruling): the brand + its first draft in ONE op — dry run ZERO writes; apply + read-back; re-run resumes
  {
    const db = fakeRtdb(state());
    const o = { name: 'Nueva', firstBranch: 'Centro', phone: '+50499990000', prep: 20, hours: H7 };
    let r = await run(db, 'create-brand', 'tb_nueva', o);
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /"state": "off"/); assert.match(r.out, /tb_nueva_centro/); assert.deepStrictEqual(db.writes, [], 'create-brand dry run: ZERO writes');
    r = await run(db, 'create-brand', 'tb_brand', o);
    assert.strictEqual(r.code, 1); assert.match(r.out, /REFUSED — brand_exists/);
    r = await run(db, 'create-brand', 'tb_nueva', { ...o, hours: { mon: DAY } });
    assert.strictEqual(r.code, 1); assert.match(r.out, /REFUSED — bad_draft: bad_hours/);
    r = await run(db, 'create-brand', 'tb_nueva', { name: 'Nueva' });
    assert.strictEqual(r.code, 2, 'every first-branch field is required');
    r = await run(db, 'create-brand', 'tb_nueva', o, true);
    assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /created and read back/);
    assert.deepStrictEqual(db.get('brands/tb_nueva/locations'), { tb_nueva_centro: 'staged' });
    assert.strictEqual(db.get('restaurants/tb_nueva_centro/draft/location_name'), 'Centro');
    const n0 = db.writes.length;
    assert.strictEqual((await run(db, 'create-brand', 'tb_nueva', o, true)).code, 0, 'a re-run resumes / is a no-op');
    assert.strictEqual(db.writes.length, n0, 'and writes nothing');
  }
  assert.deepStrictEqual(parseOpts(['--hours', '{bad']), { error: '--hours must be JSON' });
  assert.deepStrictEqual(parseOpts(['--name', 'Nueva', '--first-branch', 'Centro', '--phone', '+504', '--hours', '{"mon":{"open":false}}']).hours, { mon: { open: false } });
  ok('create-brand: the brand (OFF) + its first draft in ONE op; dry run ZERO writes; existing brand / bad hours refused; every field required; apply reads back; re-run writes nothing');

  // status is read-only
  {
    const db = fakeRtdb(state({ brands: { tb_brand: { name: 'Third', active: true, locations: { tb_norte: 'member', tb_sur: 'staged' }, activation: { state: 'on', since: 1 } } },
      restaurants: { tb_norte: { identity: NORTE }, tb_sur: { identity: { ...NORTE, location_name: 'Sur', active: false } }, tb_brand_centro: { draft: DRAFT } } }));
    const r = await run(db, 'status', 'tb_brand');
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(JSON.parse(r.out).branches, { tb_brand_centro: 'draft', tb_norte: 'active', tb_sur: 'staged' });
    assert.deepStrictEqual(db.writes, []);
  }
  ok('status <brand>: every branch as draft / staged / inactive / active; read-only');

  console.log(`\nbranches-admin-core: OK (${n})`);
})().catch((e) => { console.error('branches-admin-core FAILED:', e); process.exit(1); });
