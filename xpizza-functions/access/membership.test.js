'use strict';
// PLAN-portal-membership r3 §3/§4/§10 — the resolver and "my locations", over a legacy singleton (x_pizza) and a SYNTHETIC
// third brand `tb` with two locations (one member, one retired) plus a rogue identity that names `tb` but is not listed.
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const M = require('./membership');

const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const base = () => ({
  brands: {
    x_pizza: legacy('x_pizza'),
    tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_norte: 'retired' }, activation: { state: 'on', since: 1 } },
  },
  restaurants: {
    x_pizza: { identity: { name: 'X. Pizza' }, kitchen_staff: { kit1: true } },
    tb_centro: { identity: { brand_id: 'tb', location_name: 'Centro' }, kitchen_staff: { kit2: true } },
    tb_norte: { identity: { brand_id: 'tb', location_name: 'Norte' } },
    tb_rogue: { identity: { brand_id: 'tb', location_name: 'Rogue' } },
    zz_lost: { identity: { name: 'lost' } },
  },
  brand_members: {
    x_pizza: { owners: { ownerX: { granted_at: 1, granted_by: 'cli:op' } } },
    tb: { owners: { ownerTB: { granted_at: 1, granted_by: 'cli:op' } },
          managers: { tb_centro: { mgrC: { granted_at: 1, granted_by: 'ownerTB' }, dispMgr: { granted_at: 1, granted_by: 'ownerTB' } },
                      tb_norte: { mgrN: { granted_at: 1, granted_by: 'ownerTB' } } } },
  },
  dispatchers: { dispMgr: true, disp1: true },
  member_of: {
    ownerX: { brands: { x_pizza: 'owner' } },
    ownerTB: { brands: { tb: 'owner' }, locations: { tb_centro: 'manager' } },
    mgrC: { locations: { tb_centro: 'manager' } },
    mgrN: { locations: { tb_norte: 'manager' } },
    staleOwn: { brands: { tb: 'owner' } },                         // index says owner; no forward grant
    junky: { brands: { 'Bad-Id': 'owner', tb: 'admin' }, locations: { tb_centro: true } },
  },
});
const ctx = (uid, token = {}) => ({ uid, token });

test('capability table: the owner decisions live in ONE place; columns compose by fact + state', () => {
  assert.ok(M.CAP_NAMES.includes('stats.read') && M.CAP_NAMES.includes('catalog.fiscal_ack'));
  assert.deepStrictEqual(M.capsFor({ owner: true }, 'retired'), ['stats.read'], 'retired owner: history read only');
  assert.deepStrictEqual(M.capsFor({ manager: true }, 'retired'), [], 'a manager of a retired location has nothing');
  assert.ok(!M.capsFor({ manager: true }, 'member').includes('catalog.publish'), 'O7: managers do not publish');
  assert.ok(M.capsFor({ manager: true }, 'member').includes('device.pair'));
  assert.deepStrictEqual(M.capsFor({ dispatcher: true }, 'unknown'), ['catalog.edit', 'catalog.publish'], 'dispatcher = today, brand-independent');
  assert.deepStrictEqual(M.capsFor({ staff: true }, 'unknown'), ['catalog.edit', 'catalog.publish'], 'staff = today, brand-independent');
  // role-only results (legacy stubs) resolve through the same table
  assert.strictEqual(M.can({ ok: true, role: 'owner' }, 'catalog.fiscal_ack'), true);
  assert.strictEqual(M.can({ ok: true, role: 'staff' }, 'catalog.fiscal_ack'), false);
  assert.strictEqual(M.can({ ok: false, role: 'owner' }, 'catalog.edit'), false);
  assert.strictEqual(M.can({ ok: true, caps: ['stats.read'], role: 'owner' }, 'catalog.edit'), false, 'explicit caps win over the role');
});

test('resolveAccess: verified context — customer AND handheld refused before ANY read', async () => {
  const db = createFakeDb(base());
  db.failReads.add('');   // any read would throw → a refusal proves no read happened
  assert.strictEqual((await M.resolveAccess({ db }, ctx('ownerX', { customer: true }), 'x_pizza')).code, 'forbidden');
  assert.strictEqual((await M.resolveAccess({ db }, ctx('hh_x_pizza_1', { handheld: true, rid: 'x_pizza' }), 'x_pizza')).code, 'forbidden');
  assert.strictEqual((await M.resolveAccess({ db }, null, 'x_pizza')).code, 'unauthenticated');
  assert.strictEqual((await M.resolveAccess({ db }, ctx(''), 'x_pizza')).code, 'unauthenticated');
  assert.strictEqual((await M.resolveAccess({ db }, ctx('a/b'), 'x_pizza')).code, 'forbidden', 'a path-unsafe uid never reaches a path');
});

test('resolveAccess: facts are independent; caps follow the location state', async () => {
  const db = createFakeDb(base());
  const ox = await M.resolveAccess({ db }, ctx('ownerX'), 'x_pizza');
  assert.deepStrictEqual([ox.ok, ox.brandId, ox.state, ox.tier, ox.facts], [true, 'x_pizza', 'member', 'owner', { owner: true, manager: false, dispatcher: false, staff: false }]);
  assert.ok(ox.caps.includes('catalog.fiscal_ack') && ox.caps.includes('team.invite'));
  const otn = await M.resolveAccess({ db }, ctx('ownerTB'), 'tb_norte');
  assert.deepStrictEqual([otn.state, otn.caps], ['retired', ['stats.read']], 'owner of a retired location: read-only history');
  const mn = await M.resolveAccess({ db }, ctx('mgrN'), 'tb_norte');
  assert.deepStrictEqual([mn.facts.manager, mn.caps], [true, []], 'manager of a retired location: no capability (still revocable)');
  const mc = await M.resolveAccess({ db }, ctx('mgrC'), 'tb_centro');
  assert.ok(mc.caps.includes('device.pair') && mc.caps.includes('stats.read') && !mc.caps.includes('catalog.edit'));
  // dispatcher + manager: the UNION, not a single winner
  const dm = await M.resolveAccess({ db }, ctx('dispMgr'), 'tb_centro');
  assert.deepStrictEqual(dm.facts, { owner: false, manager: true, dispatcher: true, staff: false });
  assert.ok(dm.caps.includes('device.pair') && dm.caps.includes('catalog.edit'), 'manager caps AND dispatcher caps');
  assert.strictEqual(dm.tier, 'manager', 'tier is presentation only');
  // the owner of brand X is nobody at brand TB
  assert.deepStrictEqual((await M.resolveAccess({ db }, ctx('ownerX'), 'tb_centro')).caps, []);
  // kitchen staff: today's catalog column, brand-independent
  assert.deepStrictEqual((await M.resolveAccess({ db }, ctx('kit1'), 'x_pizza')).caps, ['catalog.edit', 'catalog.publish']);
});

test('resolveAccess: unknown brand → no merchant facts; a rogue identity naming a brand that does not list it is unknown', async () => {
  const db = createFakeDb(base());
  const r = await M.resolveAccess({ db }, ctx('ownerTB'), 'tb_rogue');
  assert.deepStrictEqual([r.state, r.brandId, r.facts.owner, r.caps], ['unknown', 'unknown', false, []]);
  const z = await M.resolveAccess({ db }, ctx('disp1'), 'zz_lost');
  assert.deepStrictEqual([z.state, z.caps], ['unknown', ['catalog.edit', 'catalog.publish']], 'a dispatcher keeps today\'s reach');
  const bad = await M.resolveAccess({ db }, ctx('ownerX'), '12345');
  assert.deepStrictEqual([bad.state, bad.caps], ['unknown', []], 'an all-digit id is never a member location');
});

test('resolveAccess: a read that THROWS is unavailable — never a lower role', async () => {
  for (const p of ['restaurants/x_pizza/identity/brand_id', 'brands/x_pizza', 'brand_members/x_pizza', 'dispatchers', 'restaurants/x_pizza/kitchen_staff']) {
    const db = createFakeDb(base());
    db.failReads.add(p);
    assert.strictEqual((await M.resolveAccess({ db }, ctx('ownerX'), 'x_pizza')).code, 'unavailable', p);
  }
});

test('myLocations: member_of discovers, forward grants authorize; stale/malformed dropped and reported; dedup; sorted', async () => {
  const db = createFakeDb(base());
  const stale = [];
  const onStale = (s) => stale.push(s);
  assert.deepStrictEqual((await M.myLocations({ db, onStale }, ctx('ownerX'))).map((l) => [l.rid, l.role, l.state]), [['x_pizza', 'owner', 'member']]);
  const tb = await M.myLocations({ db, onStale }, ctx('ownerTB'));
  assert.deepStrictEqual(tb.map((l) => [l.rid, l.brand_id, l.role, l.state]), [['tb_centro', 'tb', 'owner', 'member'], ['tb_norte', 'tb', 'owner', 'retired']],
    'owner sees member + retired (history); owner+manager of tb_centro listed once, as owner; the rogue identity is not listed');
  assert.deepStrictEqual((await M.myLocations({ db, onStale }, ctx('mgrC'))).map((l) => l.rid), ['tb_centro']);
  assert.deepStrictEqual(await M.myLocations({ db, onStale }, ctx('mgrN')), [], 'a manager of a retired location lists nothing');
  stale.length = 0;
  assert.deepStrictEqual(await M.myLocations({ db, onStale }, ctx('staleOwn')), [], 'a stale index entry NEVER authorizes');
  assert.deepStrictEqual(stale.map((s) => s.kind), ['stale_owner']);
  stale.length = 0;
  assert.deepStrictEqual(await M.myLocations({ db, onStale }, ctx('junky')), []);
  assert.deepStrictEqual(stale.map((s) => s.kind).sort(), ['malformed_brand_entry', 'malformed_brand_entry', 'malformed_location_entry']);
  assert.deepStrictEqual(await M.myLocations({ db }, ctx('nobody1')), [], 'no index → empty');
});

test('myLocations: refusals and outages THROW (never an empty list)', async () => {
  const db = createFakeDb(base());
  await assert.rejects(M.myLocations({ db }, ctx('ownerX', { handheld: true })), (e) => e.code === 'forbidden');
  await assert.rejects(M.myLocations({ db }, ctx('ownerX', { customer: true })), (e) => e.code === 'forbidden');
  db.failReads.add('member_of');
  await assert.rejects(M.myLocations({ db }, ctx('ownerX')));
  const db2 = createFakeDb(base());
  db2.failReads.add('brand_members/tb');
  await assert.rejects(M.myLocations({ db: db2 }, ctx('ownerTB')));
});

test('cores gate on CAPABILITIES with today\'s error bodies: a manager-only caller (O1) is refused by every catalog core; stats admits it', async () => {
  const { editCatalogCore } = require('../catalog/edit-catalog-handler');
  const { publishEditedCore } = require('../catalog/publish-edited-handler');
  const { resetDraftToLiveCore } = require('../catalog/reset-draft');
  const { getEditableCatalogCore } = require('../catalog/portal-reads');
  const { getSalesStatsCore } = require('../stats/stats-api');
  const manager = async () => ({ ok: true, uid: 'mgrC', role: 'manager', caps: M.capsFor({ manager: true }, 'member') });
  const boom = () => { throw new Error('a core read past its capability gate'); };
  const e = await editCatalogCore({ db: { collection: boom }, authorize: manager, readActiveBuilt: boom }, { restaurantId: 'tb_centro', source: {} }, {});
  assert.deepStrictEqual([e.status, e.body.error], [403, 'not_authorized'], 'editCatalog: catalog.edit');
  const p = await publishEditedCore({ db: { collection: boom }, authorize: manager, readActiveBuilt: boom, readDraft: boom }, { restaurantId: 'tb_centro', token: 't' }, {});
  assert.deepStrictEqual([p.status, p.body.error], [403, 'not_authorized'], 'publishEdited: catalog.publish (O7)');
  const r = await resetDraftToLiveCore({ db: { collection: boom }, authorize: manager, readActiveVersionId: boom, previewVersion: boom }, { restaurantId: 'tb_centro' }, {});
  assert.deepStrictEqual([r.status, r.body.error], [403, 'not_owner'], 'resetDraftToLive: catalog.reset_draft — today\'s body');
  const g = await getEditableCatalogCore({ db: {}, fsdb: { collection: boom }, authorize: manager, readActiveVersionId: boom }, { method: 'GET', query: { restaurantId: 'tb_centro' } });
  assert.deepStrictEqual([g.status, g.body.error], [403, 'not_owner'], 'getEditableCatalog: catalog.read_editor — today\'s body');
  // stats: the manager's capability passes the gate (it then fails later on the stubbed keyer — never as not_owner)
  const s = await getSalesStatsCore({ authorize: manager, getKeyer: () => { throw new Error('no keyer'); } }, { method: 'GET', query: { restaurantId: 'tb_centro' } });
  assert.notStrictEqual(s.body && s.body.error, 'not_owner', 'getSalesStats: stats.read admits a manager of the location (O1)');
  const disp = async () => ({ ok: true, uid: 'd', role: 'dispatcher' });   // a legacy role-only stub → today's column
  const sd = await getSalesStatsCore({ authorize: disp, getKeyer: boom }, { method: 'GET', query: { restaurantId: 'tb_centro' } });
  assert.deepStrictEqual([sd.status, sd.body.error], [403, 'not_owner'], 'a dispatcher is still refused stats as today');
});
