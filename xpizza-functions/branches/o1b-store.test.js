'use strict';
// ORCHESTRATION O1b (PLAN-orch-o1b r3) — the WRITER-level cells: T6 readiness propagation through the real activate writers.
// Logical time only (the wall clock is disabled for the whole file, as in branch-store.test.js).
// Run: node branches/o1b-store.test.js
const assert = require('assert');
const S = require('./branch-store');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');   // faithful Admin-SDK transaction semantics (cached-null first pass)
const { portalReaders } = require('./readiness-readers');

Date.now = () => { throw new Error('o1b-store.test: Date.now() read — every lifecycle call here runs on logical time'); };
for (const k of ['createDraft', 'createBrandWithDraft', 'deleteBranchDraft', 'materializeBranch', 'resumeBranchOp', 'setBranchActive', 'activateBrand', 'deactivateBrand']) {
  const f = S[k];
  S[k] = (db, o = {}) => f(db, Number.isFinite(o.now) && typeof o.clock !== 'function' ? { ...o, clock: () => o.now } : o);
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('o1b-store: FAILED — exited without completing'); process.exitCode = 1; } });

const NOW = 1_800_000_000_000;
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const g = { granted_at: 1, granted_by: 'x' };
// tb_brand ON; tb_sur staged (paired handheld, owner present, menu published) — its identity is the knob
const SUR = { name: 'Third', brand_id: 'tb_brand', location_name: 'Sur', phone: '+50431234567', hours: H7, prep_default_min: 20, hub_lat: 15.6, hub_lng: -88.0,
  zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, active: false, active_changed_at: 1, version: 2 };
const world = (sur = SUR, brandState = 'on') => fakeRtdb({
  brands: { tb_brand: { name: 'Third', active: true, locations: { tb_sur: 'staged' }, activation: { state: brandState, since: 1 }, projection_gen: 1 } },
  restaurants: { tb_sur: { identity: sur, handhelds: { h1: { kind: 'handheld', last_seen: NOW - 1000 } } } },
  brand_members: { tb_brand: { owners: { ownerTB: g } } },
  menus: { tb_brand: { published: true } },
});

(async () => {
  // ── T6: identity_gaps through the REAL setBranchActive (activate) writer ──
  {
    const db = world({ ...SUR, hub_lat: 95, prep_default_min: 2 });
    const r = await S.setBranchActive(db, { rid: 'tb_sur', active: true, expectedVersion: 2, now: NOW, readers: portalReaders(db, 'tb_brand') });
    assert.deepStrictEqual(r, { ok: false, error: 'not_ready', unmet: ['identity_invalid'], identity_gaps: ['location', 'prep'] }, 'WRITER-GAPS');
    assert.strictEqual(db.get('restaurants/tb_sur/identity/active'), false, 'nothing activated');
    const db2 = world({ ...SUR, active: 'broken' });
    assert.deepStrictEqual(await S.setBranchActive(db2, { rid: 'tb_sur', active: true, expectedVersion: 2, now: NOW, readers: portalReaders(db2, 'tb_brand') }),
      { ok: false, error: 'not_ready', unmet: ['identity_invalid'], identity_gaps: ['integrity'] }, 'WRITER-RAW-ACTIVE: a malformed active is refused, never activated');
    const db3 = world();
    assert.deepStrictEqual(await S.setBranchActive(db3, { rid: 'tb_sur', active: true, expectedVersion: 2, now: NOW, readers: portalReaders(db3, 'tb_brand') }), { ok: true, rid: 'tb_sur', state: 'active' }, 'a ready staged branch activates (team reader: the owner counts)');
    assert.strictEqual(db3.get('brands/tb_brand/locations/tb_sur'), 'member');
    ok('setBranchActive (real writer): identity_gaps propagate with unmet; a malformed active is identity_invalid + integrity; a ready branch activates with the portal team reader');
  }

  // ── T6: activateBrand reports gaps per rid; unmet holds only the six codes ──
  {
    const db = world({ ...SUR, zone: { type: 'circle', radius_km: 9 } }, 'off');
    const r = await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_sur'], now: NOW, readers: portalReaders(db, 'tb_brand') });
    assert.deepStrictEqual(r, { ok: false, error: 'not_ready', unmet: { tb_sur: ['identity_invalid'] }, identity_gaps: { tb_sur: ['zone'] } }, 'BRAND-GAPS');
    const codes = require('./branch-ops').READINESS_CODES;
    for (const u of Object.values(r.unmet)) for (const c of u) assert.ok(codes.includes(c), `UNMET-ONLY-CODES ${c}`);
    ok('activateBrand: per-rid unmet holds only the six codes, identity_gaps per rid');
  }

  FINISHED = true;
  console.log(`\no1b-store: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
