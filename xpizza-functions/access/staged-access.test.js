'use strict';
// ORCHESTRATION O1b T1 (PLAN-orch-o1b r3 §3 T1, Codex r1 #2) — the STAGED location state in the authorization layer, and the
// brand-scope capability `brand.locations` (resolveBrandAccess), over a synthetic NEW brand `tb2` whose only branch is staged
// (zero member branches) next to the existing member / retired brand `tb`.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { createFakeDb } = require('../merchant/_fake-db');
const M = require('./membership');

const g = { granted_at: 1, granted_by: 'x' };
const fixture = () => ({
  brands: {
    tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_norte: 'retired' }, activation: { state: 'on', since: 1 } },
    tb2: { name: 'TB Dos', active: true, locations: { tb2_sur: 'staged' }, activation: { state: 'off', since: 1 }, projection_gen: 1 },
  },
  restaurants: {
    tb_centro: { identity: { brand_id: 'tb', location_name: 'Centro' } },
    tb_norte: { identity: { brand_id: 'tb', location_name: 'Norte' } },
    tb2_sur: { identity: { brand_id: 'tb2', location_name: 'Sur' } },
  },
  brand_members: {
    tb: { owners: { ownerTB: g }, managers: { tb_centro: { mgrCen: g } } },
    tb2: { owners: { ownerB2: g }, managers: { tb2_sur: { mgrSur: g } } },
  },
  dispatchers: { disp01: true },
  member_of: {
    ownerTB: { brands: { tb: 'owner' } },
    ownerB2: { brands: { tb2: 'owner' } },
    mgrSur: { locations: { tb2_sur: 'manager' } },
    mgrCen: { locations: { tb_centro: 'manager' } },
  },
});
const ctx = (uid, token = {}) => ({ uid, token });

const STAGED_OWNER = ['availability.set', 'device.pair', 'device.list', 'device.revoke', 'location.hours', 'location.prep', 'location.contact', 'location.profile', 'team.invite', 'team.revoke'];
const STAGED_MANAGER = ['availability.set', 'device.pair', 'device.list', 'device.revoke', 'location.hours', 'location.prep', 'location.contact'];
const sorted = (xs) => [...xs].sort();

test('T1 resolveLocation: a staged rid resolves to its brand with state staged', async () => {
  const db = createFakeDb(fixture());
  const loc = await M.resolveLocation(db, 'tb2_sur');
  assert.strictEqual(loc.brandId, 'tb2'); assert.strictEqual(loc.state, 'staged', 'STAGED-RESOLVES');
});

test('T1 capsFor(staged): owner / manager sets exactly; never pause, stats or catalog', () => {
  assert.deepStrictEqual(sorted(M.capsFor({ owner: true }, 'staged')), sorted(STAGED_OWNER), 'STAGED-OWNER-CAPS');
  assert.deepStrictEqual(sorted(M.capsFor({ manager: true }, 'staged')), sorted(STAGED_MANAGER), 'STAGED-MANAGER-CAPS');
  assert.deepStrictEqual(sorted(M.capsFor({ manager: true, manager_menu: true }, 'staged')), sorted(STAGED_MANAGER), 'the menu permission adds nothing on staged');
  for (const facts of [{ owner: true }, { manager: true }, { manager: true, manager_menu: true }]) {
    const caps = M.capsFor(facts, 'staged');
    assert.ok(!caps.includes('location.pause'), 'STAGED-NO-PAUSE');
    assert.ok(!caps.includes('stats.read') && !caps.some((c) => c.startsWith('catalog.')), 'staged: no stats, no catalog');
  }
});

test('T1 member / retired / unknown capsFor are byte-identical to acf32fc8 (golden over every facts combination)', () => {
  const src = execFileSync('git', ['show', 'acf32fc8:xpizza-functions/access/membership.js'], { cwd: __dirname, encoding: 'utf8' });
  const m = new Module(path.join(__dirname, 'membership.base.js'), module);
  m.filename = path.join(__dirname, 'membership.base.js'); m.paths = Module._nodeModulePaths(__dirname);
  m._compile(src, m.filename);
  const BASE = m.exports;
  const keys = ['owner', 'manager', 'manager_menu', 'dispatcher', 'staff'];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const facts = Object.fromEntries(keys.map((k, i) => [k, !!(mask & (1 << i))]));
    for (const st of ['member', 'retired', 'unknown']) assert.deepStrictEqual(M.capsFor(facts, st), BASE.capsFor(facts, st), `golden ${st} ${JSON.stringify(facts)}`);
  }
  assert.deepStrictEqual(M.CAP_NAMES, BASE.CAP_NAMES, 'the location capability table is unchanged');
});

test('T1 resolveAccess + myLocations list a staged branch for its owner and its manager', async () => {
  const db = createFakeDb(fixture());
  const own = await M.resolveAccess({ db }, ctx('ownerB2'), 'tb2_sur');
  assert.strictEqual(own.state, 'staged'); assert.deepStrictEqual(sorted(own.caps), sorted(STAGED_OWNER));
  const mgr = await M.resolveAccess({ db }, ctx('mgrSur'), 'tb2_sur');
  assert.deepStrictEqual(sorted(mgr.caps), sorted(STAGED_MANAGER));
  assert.ok(!M.can(mgr, 'location.pause'), 'location.pause refused on staged');
  assert.deepStrictEqual((await M.myLocations({ db }, ctx('ownerB2'))).map((l) => [l.rid, l.role, l.state]), [['tb2_sur', 'owner', 'staged']], 'STAGED-LISTED owner');
  assert.deepStrictEqual((await M.myLocations({ db }, ctx('mgrSur'))).map((l) => [l.rid, l.role, l.state]), [['tb2_sur', 'manager', 'staged']], 'STAGED-LISTED manager');
  // a retired branch's manager still gets nothing (unchanged)
  const db2 = createFakeDb({ ...fixture(), brand_members: { ...fixture().brand_members, tb: { owners: { ownerTB: g }, managers: { tb_norte: { mgrNor: g } } } }, member_of: { mgrNor: { locations: { tb_norte: 'manager' } } } });
  assert.deepStrictEqual(await M.myLocations({ db: db2 }, ctx('mgrNor')), [], 'a retired location\'s manager is still not listed');
});

test('T1 brand.locations never enters location-derived caps or the role fallback', () => {
  assert.ok(!M.CAP_NAMES.includes('brand.locations'), 'BRAND-CAP-SEPARATE: not in the location table');
  assert.deepStrictEqual(Object.keys(M.BRAND_CAPABILITIES), ['brand.locations']);
  const keys = ['owner', 'manager', 'manager_menu', 'dispatcher', 'staff'];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const facts = Object.fromEntries(keys.map((k, i) => [k, !!(mask & (1 << i))]));
    for (const st of ['member', 'retired', 'staged', 'unknown']) assert.ok(!M.capsFor(facts, st).includes('brand.locations'), 'BRAND-CAP-NOT-DERIVED');
  }
  for (const role of ['owner', 'manager', 'dispatcher', 'staff']) assert.strictEqual(M.can({ ok: true, role }, 'brand.locations'), false, `BRAND-CAP-NO-ROLE-FALLBACK ${role}`);
});

test('T1 resolveBrandAccess: only the brand\'s owner (forward grant) — works with zero member branches', async () => {
  const db = createFakeDb(fixture());
  const a = await M.resolveBrandAccess({ db }, ctx('ownerB2'), 'tb2');
  assert.deepStrictEqual(a, { ok: true, uid: 'ownerB2', brandId: 'tb2', caps: ['brand.locations'], activation: 'off' }, 'BRAND-OWNER-OK');
  assert.ok(M.can(a, 'brand.locations'));
  for (const [uid, token, label] of [['mgrSur', {}, 'a manager'], ['disp01', {}, 'a dispatcher'], ['ownerTB', {}, 'an owner of another brand'],
    ['ownerB2', { customer: true }, 'a customer token'], ['ownerB2', { handheld: true }, 'a handheld token']]) {
    const r = await M.resolveBrandAccess({ db }, ctx(uid, token), 'tb2');
    assert.strictEqual(r.ok, false, `BRAND-REFUSED ${label}`); assert.ok(!M.can(r, 'brand.locations'));
  }
  assert.deepStrictEqual(await M.resolveBrandAccess({ db }, ctx('ownerB2'), 'Bad-Id'), { ok: false, code: 'bad_brand' });
  assert.deepStrictEqual(await M.resolveBrandAccess({ db }, ctx('ownerB2'), 'tb9'), { ok: false, code: 'forbidden' }, 'no brand record');
  const bad = createFakeDb({ ...fixture(), brands: { ...fixture().brands, tb2: { name: 'x' } } });
  assert.deepStrictEqual(await M.resolveBrandAccess({ db: bad }, ctx('ownerB2'), 'tb2'), { ok: false, code: 'forbidden' }, 'an invalid brand record');
  const down = createFakeDb(fixture()); down.failReads.add('brand_members');
  assert.deepStrictEqual(await M.resolveBrandAccess({ db: down }, ctx('ownerB2'), 'tb2'), { ok: false, code: 'unavailable' }, 'a read failure is an outage, never a refusal');
});

test('T1 team gates accept a staged branch (reciprocal brand checks kept)', async () => {
  const { createInvite } = require('./invites');
  const R = require('./roster');
  const db = createFakeDb(fixture());
  const deps = { db, now: () => 1000, randomToken: () => 'inv_tb2_000000000000000000000001' };
  const inv = await createInvite(deps, ctx('ownerB2'), { brandId: 'tb2', rids: ['tb2_sur'], email: 'm@example.com', name: 'Ana' });
  assert.strictEqual(inv.ok, true, `STAGED-INVITE ${JSON.stringify(inv)}`);
  assert.deepStrictEqual(await createInvite(deps, ctx('ownerB2'), { brandId: 'tb2', rids: ['tb_centro'], email: 'n@example.com', name: 'Bo' }), { ok: false, code: 'location_not_member' }, 'another brand\'s branch: still refused');
  assert.strictEqual((await R.validateTarget(db, 'tb2', { type: 'grant_manager', uid: 'newMgr1', rids: ['tb2_sur'] })).ok, true, 'STAGED-GRANT');
  const upd = await R.validateTarget(db, 'tb2', { type: 'update_manager', uid: 'mgrOther1', rids: ['tb2_sur'], can_edit_menu: false });
  assert.deepStrictEqual(upd, { ok: true, validatedAdds: ['tb2_sur'] }, 'STAGED-ADDED-LOCATION');
  assert.deepStrictEqual(await R.validateTarget(db, 'tb2', { type: 'grant_manager', uid: 'newMgr1', rids: ['tb_centro'] }), { ok: false, code: 'location_not_member' }, 'cross-brand grant refused');
});

test('T1 canAtBrand: team.invite at a brand whose only branch is staged', async () => {
  const H = require('./team-http-core');
  const db = createFakeDb(fixture());
  assert.deepStrictEqual(await H.canAtBrand(db, ctx('ownerB2'), 'tb2', 'team.invite'), { ok: true }, 'STAGED-CANATBRAND');
  assert.strictEqual((await H.canAtBrand(db, ctx('mgrSur'), 'tb2', 'team.invite')).ok, false, 'a manager never invites');
});

test('T1 the pairing list (merchant myLocations) includes a staged branch for its owner and manager', async () => {
  const D = require('../merchant/merchant-devices');
  const HttpsError = class extends Error { constructor(code, msg) { super(msg); this.code = code; } };
  const db = createFakeDb(fixture());
  const deps = { db, HttpsError };
  const own = await D.myLocations(deps, { uid: 'ownerB2', token: {} }, {});
  assert.deepStrictEqual(own.map((l) => l.rid), ['tb2_sur'], 'STAGED-PAIRABLE owner');
  const mgr = await D.myLocations(deps, { uid: 'mgrSur', token: {} }, {});
  assert.deepStrictEqual(mgr.map((l) => l.rid), ['tb2_sur'], 'STAGED-PAIRABLE manager');
});
