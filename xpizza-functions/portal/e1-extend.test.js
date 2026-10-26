'use strict';
// ORCHESTRATION O1b T8 (PLAN-orch-o1b r3 §2 E1+) — getMyBranches gains the slice-1b read model ADDITIVELY.
//   (1) GOLDEN: every 1a field is byte-identical to acf32fc8's ops-core over the same world (the added keys stripped);
//   (2) the added fields per role (owner / manager); drafts owner-only; legacy flagged, never given readiness;
//   (3) E1's readiness equals E8's not_ready for the same identity (the SAME facts + planner);
//   (4) a failed fact read omits that row's readiness (still 200), never a guess;
//   (5) a brand the caller owns with NO visible branch (its only branch is a draft) is listed with its drafts.
// Run: node portal/e1-extend.test.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { createFakeDb } = require('../merchant/_fake-db');
const C = require('./ops-core');
const L = require('./branch-lifecycle-core');
const P = require('../branches/branch-ops');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('e1-extend: FAILED — exited without completing'); process.exitCode = 1; } });

const NOW = 1_800_000_000_000;
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const g = { granted_at: 1, granted_by: 'x' };
const ident = (brand, name, over = {}) => ({ name: 'Third', brand_id: brand, location_name: name, phone: '+50431234567', hours: H7, prep_default_min: 20, hub_lat: 15.6, hub_lng: -88.0,
  address_line: 'Calle 1', zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false, active: true, active_changed_at: 1, version: 3, ...over });
const DRAFT = { brand_id: 'tb_brand', location_name: 'Plaza', phone: '+50471234567', hours: H7, prep_default_min: 25, created_at: 1, created_by: 'ownerTB', op_id: 'opP', inc: 'c1' };
const seed = () => ({
  platform_config: { membership_writes_enabled: true },
  brands: {
    tb_brand: { name: 'Third', active: true, locations: { tb_sur: 'member', tb_este: 'staged' }, activation: { state: 'on', since: 1 }, projection_gen: 2 },
    x_leg: { name: 'Leg', active: true, locations: { x_leg: 'member' }, activation: { state: 'legacy', since: 1 } },
    tb_nueva: { name: 'Nueva', active: true, locations: { tb_nueva_centro: 'staged' }, activation: { state: 'off', since: 1 }, projection_gen: 1 },
  },
  restaurants: {
    tb_sur: { identity: ident('tb_brand', 'Sur'), handhelds: { h1: { kind: 'handheld', last_seen: NOW - 5 } } },
    tb_este: { identity: ident('tb_brand', 'Este', { active: false, version: 1, prep_default_min: 2, address_line: undefined }), handhelds: { h2: { kind: 'handheld', last_seen: NOW - 5 } } },
    x_leg: { identity: ident('x_leg', 'Leg', { phone: '+50422223333', active: false }) },
    tb_brand_plaza: { draft: DRAFT },
    tb_nueva_centro: { draft: { ...DRAFT, brand_id: 'tb_nueva', location_name: 'Centro', op_id: 'create_tb_nueva' } },
  },
  branch_op_ids: { tb_brand: { opP: { payload_hash: 'h', inc: 'c1', rid: 'tb_brand_plaza' } }, tb_nueva: { create_tb_nueva: { payload_hash: 'h', inc: 'c1', rid: 'tb_nueva_centro' } } },
  brand_members: {
    tb_brand: { owners: { ownerTB: g }, managers: { tb_sur: { mgrSur: g }, tb_este: { mgrEst: g } } },
    x_leg: { owners: { ownerTB: g } },
    tb_nueva: { owners: { ownerTB: g } },
  },
  member_of: { ownerTB: { brands: { tb_brand: 'owner', x_leg: 'owner', tb_nueva: 'owner' } }, mgrSur: { locations: { tb_sur: 'manager' } } },
  menus: { tb_brand: { published: true } },
});
// the Admin handle as 1a's ops-core test builds it: the merchant fake + ref().get()
const adminOf = (fake) => ({ ref: (p) => { const r = fake.ref(p); return { ...r, get: () => r.once() }; } });
const world = () => { const fake = createFakeDb(seed()); const db = adminOf(fake); db.fake = fake; return db; };
const deps = (db) => ({ db, verifyIdToken: async (tok) => ({ uid: tok }), now: () => NOW, log: { warn() {}, log() {} } });
const get = (uid) => ({ method: 'GET', body: {}, get: (h) => (h === 'authorization' ? `Bearer ${uid}` : undefined) });
const ROW_ADDED = ['lifecycle', 'profile', 'location', 'legacy', 'version', 'readiness'];
const BRAND_ADDED = ['caps', 'activation', 'drafts'];
const strip = (body) => ({ ...body, brands: body.brands.map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !BRAND_ADDED.includes(k)))),
  branches: body.branches.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !ROW_ADDED.includes(k)))) });

(async () => {
  // ── (1) golden: the 1a fields are byte-identical to acf32fc8's ops-core over the same world ──
  {
    const src = execFileSync('git', ['show', 'acf32fc8:xpizza-functions/portal/ops-core.js'], { cwd: __dirname, encoding: 'utf8' });
    const m = new Module(path.join(__dirname, 'ops-core.base.js'), module); m.filename = path.join(__dirname, 'ops-core.base.js'); m.paths = Module._nodeModulePaths(__dirname);
    m._compile(src, m.filename);
    for (const uid of ['ownerTB', 'mgrSur']) {
      const now = await C.getMyBranchesCore(deps(world()), get(uid));
      const base = await m.exports.getMyBranchesCore(deps(world()), get(uid));
      assert.strictEqual(now.status, 200); assert.strictEqual(base.status, 200);
      assert.ok(now.body.branches.length >= 1 && now.body.branches.every((r) => !r.degraded && 'identity_version' in r), `E1-GOLDEN non-vacuity ${uid}: real operational rows`);
      // the base lists only brands with a visible row; O1b may ADD an owned brand with none (case 5) — compare the shared ones
      const baseIds = base.body.brands.map((b) => b.brand_id);
      const s = strip(now.body); s.brands = s.brands.filter((b) => baseIds.includes(b.brand_id));
      assert.deepStrictEqual(s, base.body, `E1-GOLDEN ${uid}: every 1a field byte-identical`);
    }
    ok('golden: owner and manager replies carry every 1a field byte-identical to acf32fc8 (the O1b additions stripped)');
  }

  // ── (2) the added fields per role ──
  {
    const r = (await C.getMyBranchesCore(deps(world()), get('ownerTB'))).body;
    const row = (rid) => r.branches.find((b) => b.rid === rid);
    assert.deepStrictEqual([row('tb_sur').lifecycle, row('tb_sur').version, row('tb_sur').profile, row('tb_sur').location],
      ['active', 3, { location_name: 'Sur', phone: '+50431234567', hours: H7, prep_default_min: 20 }, { address_line: 'Calle 1', address_reference: null, hub: { lat: 15.6, lng: -88.0 }, zone_radius_km: 5 }], 'E1-ROW active member');
    assert.ok(!('readiness' in row('tb_sur')), 'an active branch carries no readiness');
    assert.deepStrictEqual([row('tb_este').lifecycle, row('tb_este').readiness], ['staged', { unmet: ['identity_invalid'], identity_gaps: ['prep'] }], 'E1-READINESS staged with a gap; a missing address is no gap');
    assert.deepStrictEqual([row('x_leg').lifecycle, row('x_leg').legacy, 'readiness' in row('x_leg')], ['inactive', true, false], 'E1-LEGACY flagged, never given readiness');
    const tb = r.brands.find((b) => b.brand_id === 'tb_brand');
    assert.deepStrictEqual([tb.caps, tb.activation], [['brand.locations'], 'on']);
    assert.deepStrictEqual(tb.drafts, [{ rid: 'tb_brand_plaza', brand_id: 'tb_brand', lifecycle: 'draft', profile: { location_name: 'Plaza', phone: '+50471234567', hours: H7, prep_default_min: 25 }, location: null, pending_location: true, version: 'd.opP.c1.0' }], 'E1-DRAFTS owner');
    const m = (await C.getMyBranchesCore(deps(world()), get('mgrSur'))).body;
    assert.deepStrictEqual(m.brands.map((b) => [b.brand_id, b.caps, 'drafts' in b]), [['tb_brand', [], false]], 'E1-MANAGER no brand caps, no drafts');
    assert.ok(!('readiness' in m.branches[0]), 'a manager row carries no readiness');
    ok('added fields: lifecycle / profile / location / version per row; owner readiness for staged / inactive (gaps, no address gap); legacy flagged; brand caps / activation / drafts owner-only');
  }

  // ── (3) E1 readiness == E8 not_ready for the same identity ──
  {
    const db = world();
    const e1 = (await C.getMyBranchesCore(deps(db), get('ownerTB'))).body.branches.find((b) => b.rid === 'tb_este').readiness;
    const e8 = await L.setBranchActiveCore({ ...deps(db), clock: () => NOW }, { method: 'POST', body: { rid: 'tb_este', expectedVersion: 1, active: true }, get: (h) => (h === 'authorization' ? 'Bearer ownerTB' : undefined) });
    assert.deepStrictEqual(e8.body, { error: 'not_ready', ...e1 }, 'E1-E8-PARITY');
    ok('E1 readiness equals the real E8 not_ready reply for the same identity (same facts, same planner)');
  }

  // ── (4) a failed fact read omits that row's readiness, still 200 ──
  {
    const db = world(); db.fake.failReads.add('menus');
    const r = await C.getMyBranchesCore(deps(db), get('ownerTB'));
    assert.strictEqual(r.status, 200);
    assert.ok(!('readiness' in r.body.branches.find((b) => b.rid === 'tb_este')), 'E1-READINESS-DEGRADED no guess');
    ok('a failed readiness fact read: 200, that row without readiness (never a guessed checklist)');
  }

  // ── (5) a brand whose only branch is a draft ──
  {
    const r = (await C.getMyBranchesCore(deps(world()), get('ownerTB'))).body;
    const nueva = r.brands.find((b) => b.brand_id === 'tb_nueva');
    assert.ok(nueva, 'E1-DRAFT-ONLY-BRAND listed');
    assert.deepStrictEqual([nueva.name, nueva.caps, nueva.activation, nueva.drafts.map((d) => d.rid)], ['Nueva', ['brand.locations'], 'off', ['tb_nueva_centro']]);
    assert.ok(!r.branches.some((b) => b.rid === 'tb_nueva_centro'), 'the draft is not a branch row');
    ok('an owned brand whose only branch is a draft is listed (caps, activation, its draft)');
  }

  FINISHED = true;
  console.log(`\ne1-extend: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
