'use strict';
// PLAN-portal-membership r3 §5 / §10 + OWNER DECISIONS (2026-10-19) — the ONE writer (mutateRoster), invite links and the team
// cores, over the in-memory RTDB stand-in. ONE owner per brand (CLI bootstrap / transfer only); the owner invites «Gerente de
// sucursal» users (one or more branches) and toggles their «Puede editar el menú y los precios».
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('./roster');
const I = require('./invites');
const { myLocations, resolveAccess } = require('./membership');

const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const base = () => ({
  brands: { x_pizza: legacy('x_pizza'),
            tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_sur: 'member', tb_norte: 'retired' }, activation: { state: 'on', since: 1 } } },
  restaurants: { x_pizza: { identity: { name: 'X' } }, tb_centro: { identity: { brand_id: 'tb' } }, tb_sur: { identity: { brand_id: 'tb' } }, tb_norte: { identity: { brand_id: 'tb' } } },
  brand_members: { tb: { owners: { ownerA: { granted_at: 1, granted_by: 'cli:op' } } } },
});
const CLI = { kind: 'cli', operator: 'op' };
const owner = (uid) => ({ kind: 'owner', uid });
let clock = 1000;
const deps = (db) => ({ db, now: () => clock });
let tok = 0;
const randomToken = () => `tok${String(++tok).padStart(4, '0')}AAAAAAAAAAAAAAAAAAAAAAA`;
const acc = (uid, extra = {}) => ({ uid, token: { email: `${uid.toLowerCase()}@m.hn`, email_verified: true, ...extra } });   // email-link sign-in
const mail = (uid) => `${uid.toLowerCase()}@m.hn`;
const grantMgr = (db, uid, rids, extra = {}) => R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid, rids, ...extra });

test('ONE owner per brand: bootstrap (CLI, empty roster, idempotent) and transfer (CLI) are the only owner ops — never callable', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(R.CALLABLE_OPS, ['grant_manager', 'revoke_manager', 'set_manager_perms'], 'no owner op is callable');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'x_pizza', CLI, { type: 'bootstrap_owner', uid: 'ownerX1' }), { ok: true, outcome: 'applied' });
  assert.strictEqual(db.get('member_of/ownerX1/brands/x_pizza'), 'owner');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'x_pizza', CLI, { type: 'bootstrap_owner', uid: 'ownerX1' }), { ok: true, outcome: 'noop' }, 'idempotent');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'x_pizza', CLI, { type: 'bootstrap_owner', uid: 'otherX9' }), { ok: false, code: 'roster_not_empty' });
  // an OWNER actor can never run an owner op (no co-owners, no self-transfer)
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'transfer_owner', uid: 'ownerZ9' }), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'bootstrap_owner', uid: 'ownerZ9' }), { ok: false, code: 'forbidden' });
  // the platform transfer: the old owner is REPLACED (exactly one), index follows
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', CLI, { type: 'transfer_owner', uid: 'ownerB' }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(Object.keys(db.get('brand_members/tb/owners')), ['ownerB']);
  assert.deepStrictEqual([db.get('member_of/ownerB/brands/tb'), db.get('member_of/ownerA/brands/tb')], ['owner', null]);
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgr001', rids: ['tb_centro'] }), { ok: false, code: 'forbidden' }, 'the former owner has no authority');
});

test('managers: the owner grants one or more branches (several managers per branch allowed); revoke one branch or all', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('nobody1'), { type: 'grant_manager', uid: 'mgr001', rids: ['tb_centro'] }), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await grantMgr(db, 'mgr001', ['tb_centro', 'tb_sur']), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(await grantMgr(db, 'mgr002', ['tb_centro']), { ok: true, outcome: 'applied' }, 'a second manager on the same branch');
  assert.deepStrictEqual(Object.keys(db.get('brand_members/tb/managers/tb_centro')).sort(), ['mgr001', 'mgr002']);
  assert.deepStrictEqual(db.get('member_of/mgr001/locations'), { tb_centro: 'manager', tb_sur: 'manager' });
  assert.deepStrictEqual((await myLocations({ db }, { uid: 'mgr001', token: {} })).map((l) => l.rid), ['tb_centro', 'tb_sur'], 'the real reader sees the real writer');
  assert.deepStrictEqual(await grantMgr(db, 'mgr003', ['tb_norte']), { ok: false, code: 'location_not_member' }, 'a retired branch');
  assert.deepStrictEqual(await grantMgr(db, 'mgr003', ['x_pizza']), { ok: false, code: 'location_not_member' }, 'another brand\'s branch');
  assert.deepStrictEqual(await grantMgr(db, 'mgr003', ['tb_centro', 'tb_centro']), { ok: false, code: 'bad_rids' });
  assert.deepStrictEqual(await grantMgr(db, 'mgr003', []), { ok: false, code: 'bad_rids' });
  // revoke ONE branch, then ALL
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgr001', rid: 'tb_sur' }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(db.get('member_of/mgr001/locations'), { tb_centro: 'manager' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgr001' }), { ok: true, outcome: 'applied' });
  assert.strictEqual(db.get('brand_members/tb/managers/tb_centro/mgr001'), null);
  // a revoke works after retirement (cleanup)
  db.put('brand_members/tb/managers/tb_norte/mgr009', { granted_at: 1, granted_by: 'ownerA', can_edit_menu: false });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgr009', rid: 'tb_norte' }), { ok: true, outcome: 'applied' });
});

test('«Puede editar el menú y los precios»: a toggle on the manager\'s grant, set by the owner, read by the resolver', async () => {
  const db = createFakeDb(base());
  await grantMgr(db, 'mgr010', ['tb_centro', 'tb_sur']);
  const before = await resolveAccess({ db }, { uid: 'mgr010', token: {} }, 'tb_centro');
  assert.ok(!before.caps.includes('catalog.edit') && before.caps.includes('availability.set'), 'off by default');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'set_manager_perms', uid: 'mgr010', can_edit_menu: true }), { ok: true, outcome: 'applied' });
  assert.strictEqual(db.get('brand_members/tb/managers/tb_sur/mgr010/can_edit_menu'), true, 'all of the manager\'s branches');
  const after = await resolveAccess({ db }, { uid: 'mgr010', token: {} }, 'tb_centro');
  for (const c of ['catalog.read_editor', 'catalog.edit', 'catalog.add_product', 'catalog.reset_draft', 'catalog.publish']) assert.ok(after.caps.includes(c), c);
  assert.ok(!after.caps.includes('catalog.fiscal_ack'), '🔴 the fiscal acknowledgement stays OWNER-only');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'set_manager_perms', uid: 'mgr010', can_edit_menu: true }), { ok: true, outcome: 'noop' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'set_manager_perms', uid: 'nobody9', can_edit_menu: true }), { ok: false, code: 'not_a_manager' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'set_manager_perms', uid: 'mgr010', can_edit_menu: 'yes' }), { ok: false, code: 'bad_perms' });
  // the grant carries the toggle from the start too
  await grantMgr(db, 'mgr011', ['tb_sur'], { can_edit_menu: true });
  assert.ok((await resolveAccess({ db }, { uid: 'mgr011', token: {} }, 'tb_sur')).caps.includes('catalog.edit'));
});

test('actor authority re-validated INSIDE the transaction: a transfer lands between the read and the commit → the old owner is refused', async () => {
  const db = createFakeDb(base());
  db.hooks.onTxn = async () => { await R.mutateRoster(deps(db), 'tb', CLI, { type: 'transfer_owner', uid: 'ownerB' }); };
  assert.deepStrictEqual(await grantMgr(db, 'mgr020', ['tb_centro']), { ok: false, code: 'forbidden' });
  assert.strictEqual(db.get('brand_members/tb/managers'), null);
});

test('member_of failure after commit is swallowed (reconcile repairs it); the grant stands', async () => {
  const db = createFakeDb(base());
  const realRef = db.ref;
  db.ref = (p) => { const r = realRef(p); if (!p) return { ...r, update: async () => { throw new Error('index down'); } }; return r; };
  const logs = [];
  const r = await R.mutateRoster({ db, now: () => clock, log: (k) => logs.push(k) }, 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgr030', rids: ['tb_centro'] });
  assert.deepStrictEqual(r, { ok: true, outcome: 'applied' });
  assert.ok(db.get('brand_members/tb/managers/tb_centro/mgr030'));
  assert.deepStrictEqual(logs, ['member_of_update_failed']);
});

test('invite marker is checked INSIDE every grant: overlapping recoveries + a revoke between them → no re-grant', async () => {
  const db = createFakeDb(base());
  const op = { type: 'grant_manager', uid: 'mgr040', rids: ['tb_centro'], inviteId: 'inviteAAAAAAAAAAAAAAAAAAAA' };
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), op), { ok: true, outcome: 'applied' }, 'recovery 1 applies');
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgr040' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), op), { ok: true, outcome: 'already_applied' }, 'recovery 2 (read "absent" earlier) runs now');
  assert.strictEqual(db.get('brand_members/tb/managers'), null, 'the manager stays revoked');
  assert.ok(db.get('brand_members/tb/invite_applied/inviteAAAAAAAAAAAAAAAAAAAA'), 'the marker is kept after the revoke');
});

test('invites: owner-only, «Gerente de sucursal» with branches + toggle, bound to the invitee\'s VERIFIED email; accept → granted; replay → consumed', async () => {
  const db = createFakeDb(base());
  const d = { ...deps(db), randomToken };
  assert.deepStrictEqual(await I.createInvite(d, { uid: 'nobody1', token: {} }, { brandId: 'tb', rids: ['tb_centro'], email: mail('x') }), { ok: false, code: 'forbidden' });
  assert.strictEqual((await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_norte'], email: mail('x') })).code, 'location_not_member');
  assert.strictEqual((await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: [], email: mail('x') })).code, 'bad_rids');
  const c = await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_sur', 'tb_centro'], email: mail('newMgr1'), can_edit_menu: true });
  assert.ok(c.ok && c.expires_at === clock + I.TTL_MS);
  assert.deepStrictEqual(db.get(`member_invites/${c.inviteId}/rids`), ['tb_centro', 'tb_sur']);
  assert.deepStrictEqual(await I.acceptInvite(d, acc('newMgr1', { customer: true }), c.inviteId), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await I.acceptInvite(d, acc('newMgr1'), c.inviteId), { ok: true, outcome: 'granted' });
  assert.strictEqual(db.get('brand_members/tb/managers/tb_sur/newMgr1/can_edit_menu'), true, 'the toggle rides on the invite');
  assert.deepStrictEqual(await I.acceptInvite(d, acc('newMgr1'), c.inviteId), { ok: true, outcome: 'consumed' });
  assert.deepStrictEqual(await I.acceptInvite(d, acc('otherU1'), c.inviteId), { ok: false, code: 'email_mismatch' }, 'another account never reaches the invite');
  // RECIPIENT BINDING (email invites): another verified mailbox, or an unverified token, cannot accept — the invite stays open
  const b2 = await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_centro'], email: ' Real.Mgr@M.hn ' });
  assert.strictEqual(db.get(`member_invites/${b2.inviteId}/email`), 'real.mgr@m.hn', 'normalized');
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'thief001', token: { email: 'thief@m.hn', email_verified: true } }, b2.inviteId), { ok: false, code: 'email_mismatch' });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'thief001', token: { email: 'real.mgr@m.hn', email_verified: false } }, b2.inviteId), { ok: false, code: 'email_unverified' });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'thief001', token: { email: 'real.mgr@m.hn' } }, b2.inviteId), { ok: false, code: 'email_unverified' });
  assert.strictEqual(db.get(`member_invites/${b2.inviteId}/state`), 'open', 'still open for its real recipient');
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'realMgr1', token: { email: 'REAL.mgr@m.hn', email_verified: true } }, b2.inviteId), { ok: true, outcome: 'granted' });
  assert.strictEqual((await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_centro'], email: 'not-an-email' })).code, 'bad_email');
});

test('invites: crash → revoke → retry never re-grants; in-flight retry → pending; expired; inviter lost authority (transfer) → cancelled', async () => {
  const db = createFakeDb(base());
  const d = { ...deps(db), randomToken };
  const c = await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_centro'], email: mail('mgrX01') });
  db.put(`member_invites/${c.inviteId}/state`, 'consuming');
  db.put(`member_invites/${c.inviteId}/consuming`, { by: 'mgrX01', at: clock });
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgrX01', rids: ['tb_centro'], inviteId: c.inviteId });
  assert.deepStrictEqual(await I.acceptInvite(d, acc('mgrX01'), c.inviteId), { ok: false, code: 'pending' }, 'inside the in-flight window');
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgrX01' });
  clock += I.INFLIGHT_MS + 1;
  assert.deepStrictEqual(await I.acceptInvite(d, acc('mgrX01'), c.inviteId), { ok: true, outcome: 'consumed' });
  assert.strictEqual(db.get('brand_members/tb/managers'), null, '🔴 the revoked manager is NOT re-granted');
  const e = await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_centro'], email: mail('late001') });
  clock += I.TTL_MS + 1;
  assert.deepStrictEqual(await I.acceptInvite(d, acc('late001'), e.inviteId), { ok: false, code: 'expired' });
  const g = await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_centro'], email: mail('wouldBe1') });
  await R.mutateRoster(deps(db), 'tb', CLI, { type: 'transfer_owner', uid: 'ownerB' });   // the platform transfers the brand
  assert.deepStrictEqual(await I.acceptInvite(d, acc('wouldBe1'), g.inviteId), { ok: false, code: 'inviter_not_authorized' });
  assert.strictEqual(db.get(`member_invites/${g.inviteId}/state`), 'cancelled', 'an outstanding invite dies with its issuer\'s authority');
  assert.strictEqual(db.get('brand_members/tb/managers/tb_centro/wouldBe1'), null);
});

test('invites: cancel (the brand\'s owner only); a cancelled link refuses', async () => {
  const db = createFakeDb(base());
  const d = { ...deps(db), randomToken };
  const c = await I.createInvite(d, { uid: 'ownerA', token: {} }, { brandId: 'tb', rids: ['tb_centro'], email: mail('someone1') });
  assert.deepStrictEqual(await I.cancelInvite(d, { uid: 'nobody1', token: {} }, c.inviteId), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await I.cancelInvite(d, { uid: 'ownerA', token: {} }, c.inviteId), { ok: true });
  assert.deepStrictEqual(await I.acceptInvite(d, acc('someone1'), c.inviteId), { ok: false, code: 'cancelled' });
  assert.deepStrictEqual(await I.acceptInvite(d, acc('someone1'), 'tooShort'), { ok: false, code: 'bad_invite' });
});

test('team-core: every write refuses while membership_writes_enabled is OFF (the freeze); owner-only; list shows branches + toggle', async () => {
  const T = require('./team-core');
  const db = createFakeDb(base());
  const d = { ...deps(db), randomToken };
  const own = { uid: 'ownerA', token: {} };
  for (const [name, fn, body] of [['invite', T.teamInvite, { brandId: 'tb', rids: ['tb_centro'] }],
    ['cancel', T.teamCancelInvite, { inviteId: 'inviteAAAAAAAAAAAAAAAAAAAA' }], ['accept', T.teamAcceptInvite, { inviteId: 'inviteAAAAAAAAAAAAAAAAAAAA' }],
    ['revoke', T.teamRevoke, { brandId: 'tb', uid: 'mgr001' }], ['perms', T.teamSetMenuPermission, { brandId: 'tb', uid: 'mgr001', can_edit_menu: true }]]) {
    assert.deepStrictEqual(await fn(d, own, body), { ok: false, code: 'writes_disabled' }, `${name} refused while the flag is off`);
  }
  db.put('platform_config/membership_writes_enabled', 'true');   // not the boolean true → still off
  assert.strictEqual((await T.teamInvite(d, own, { brandId: 'tb', rids: ['tb_centro'], email: mail('mgrT001') })).code, 'writes_disabled');
  db.put('platform_config/membership_writes_enabled', true);
  const inv = await T.teamInvite(d, own, { brandId: 'tb', rids: ['tb_centro', 'tb_sur'], email: mail('mgrT001') });
  assert.ok(inv.ok);
  assert.deepStrictEqual(await T.teamAcceptInvite(d, acc('mgrT001'), { inviteId: inv.inviteId }), { ok: true, outcome: 'granted' });
  assert.deepStrictEqual(await T.teamSetMenuPermission(d, own, { brandId: 'tb', uid: 'mgrT001', can_edit_menu: true }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(await T.teamList(d, own, { brandId: 'tb' }), { ok: true, owner: 'ownerA', managers: { mgrT001: { rids: ['tb_centro', 'tb_sur'], can_edit_menu: true } } });
  assert.deepStrictEqual(await T.teamSetMenuPermission(d, { uid: 'mgrT001', token: {} }, { brandId: 'tb', uid: 'mgrT001', can_edit_menu: false }), { ok: false, code: 'forbidden' }, 'a manager cannot change roles');
  assert.deepStrictEqual(await T.teamRevoke(d, own, { brandId: 'tb', uid: 'mgrT001', rid: 'tb_sur' }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(await T.teamList(d, { uid: 'mgrT001', token: {} }, { brandId: 'tb' }), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await T.teamList(d, { uid: 'ownerA', token: { handheld: true } }, { brandId: 'tb' }), { ok: false, code: 'forbidden' });
});
