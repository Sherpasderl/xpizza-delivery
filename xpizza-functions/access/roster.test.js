'use strict';
// PLAN-portal-membership r3 §5 / §10 — the ONE writer (mutateRoster) and invite links, over the in-memory RTDB stand-in.
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('./roster');
const I = require('./invites');
const { myLocations } = require('./membership');

const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const base = () => ({
  brands: { x_pizza: legacy('x_pizza'),
            tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_norte: 'retired' }, activation: { state: 'on', since: 1 } } },
  restaurants: { x_pizza: { identity: { name: 'X' } }, tb_centro: { identity: { brand_id: 'tb' } }, tb_norte: { identity: { brand_id: 'tb' } } },
  brand_members: { tb: { owners: { ownerA: { granted_at: 1, granted_by: 'cli:op' } } } },
});
const CLI = { kind: 'cli', operator: 'op' };
const owner = (uid) => ({ kind: 'owner', uid });
let clock = 1000;
const deps = (db) => ({ db, now: () => clock });
let tok = 0;
const randomToken = () => `tok${String(++tok).padStart(4, '0')}AAAAAAAAAAAAAAAAAAAAAAA`;

test('bootstrap_owner: CLI only, only into a ZERO-owner roster, idempotent; never a callable op', async () => {
  const db = createFakeDb(base());
  assert.ok(!R.CALLABLE_OPS.includes('bootstrap_owner'), 'the callables\' op allowlist excludes bootstrap');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'x_pizza', CLI, { type: 'bootstrap_owner', uid: 'ownerX1' }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(db.get('brand_members/x_pizza/owners/ownerX1'), { granted_at: 1000, granted_by: 'cli:op' });
  assert.strictEqual(db.get('member_of/ownerX1/brands/x_pizza'), 'owner', 'discovery index written after commit');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'x_pizza', CLI, { type: 'bootstrap_owner', uid: 'ownerX1' }), { ok: true, outcome: 'noop' }, 'idempotent re-run');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'x_pizza', CLI, { type: 'bootstrap_owner', uid: 'otherX9' }), { ok: false, code: 'roster_not_empty' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'bootstrap_owner', uid: 'zzzzzz1' }), { ok: false, code: 'forbidden' }, 'an owner actor can never bootstrap');
});

test('actor authority re-validated inside the transaction; owners grant co-owners and managers', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('nobody1'), { type: 'grant_owner', uid: 'ownerB' }), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_owner', uid: 'ownerB' }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgr001', rid: 'tb_centro' }), { ok: true, outcome: 'applied' });
  assert.strictEqual(db.get('member_of/mgr001/locations/tb_centro'), 'manager');
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgr001', rid: 'tb_centro' }), { ok: true, outcome: 'noop' });
  assert.deepStrictEqual((await myLocations({ db }, { uid: 'mgr001', token: {} })).map((l) => l.rid), ['tb_centro'], 'the real reader sees the real writer\'s grant');
});

test('scope: manager grant needs a CURRENT member location; manager revoke works after retirement', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgr002', rid: 'tb_norte' }), { ok: false, code: 'location_not_member' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgr002', rid: 'x_pizza' }), { ok: false, code: 'location_not_member' }, 'another brand\'s location');
  db.put('brand_members/tb/managers/tb_norte/mgr003', { granted_at: 1, granted_by: 'ownerA' });   // granted before retirement
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgr003', rid: 'tb_norte' }), { ok: true, outcome: 'applied' });
  assert.strictEqual(db.get('brand_members/tb/managers'), null);
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'nope', CLI, { type: 'grant_owner', uid: 'ownerB' }), { ok: false, code: 'brand_invalid' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', CLI, { type: 'grant_owner', uid: 'bad/uid' }), { ok: false, code: 'bad_uid' });
});

test('≥ 1 owner: the last owner cannot be revoked; two CONCURRENT last-owner revokes → exactly one succeeds', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', CLI, { type: 'revoke_owner', uid: 'ownerA' }), { ok: false, code: 'last_owner' });
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_owner', uid: 'ownerB' });
  // A revokes B while B revokes A: B's revoke commits between A's read and A's commit
  db.hooks.onTxn = async () => { assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerB'), { type: 'revoke_owner', uid: 'ownerA' }), { ok: true, outcome: 'applied' }); };
  const a = await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_owner', uid: 'ownerB' });
  assert.deepStrictEqual(a, { ok: false, code: 'forbidden' }, 'A is no longer an owner when its transaction re-runs');
  assert.deepStrictEqual(Object.keys(db.get('brand_members/tb/owners')), ['ownerB'], 'exactly one owner remains');
});

test('member_of failure after commit is swallowed (reconcile repairs it); the grant stands', async () => {
  const db = createFakeDb(base());
  const realRef = db.ref;
  db.ref = (p) => { const r = realRef(p); if (!p) return { ...r, update: async () => { throw new Error('index down'); } }; return r; };
  const logs = [];
  const r = await R.mutateRoster({ db, now: () => clock, log: (k) => logs.push(k) }, 'tb', owner('ownerA'), { type: 'grant_owner', uid: 'ownerC' });
  assert.deepStrictEqual(r, { ok: true, outcome: 'applied' });
  assert.ok(db.get('brand_members/tb/owners/ownerC'));
  assert.deepStrictEqual(logs, ['member_of_update_failed']);
});

test('invite marker is checked INSIDE every grant: overlapping recoveries + a revoke between them → no re-grant', async () => {
  const db = createFakeDb(base());
  const op = { type: 'grant_manager', uid: 'mgr010', rid: 'tb_centro', inviteId: 'inviteAAAAAAAAAAAAAAAAAAAA' };
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), op), { ok: true, outcome: 'applied' }, 'recovery 1 applies');
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgr010', rid: 'tb_centro' });
  // recovery 2 read "absent" before recovery 1 committed; its transaction runs now
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', owner('ownerA'), op), { ok: true, outcome: 'already_applied' });
  assert.strictEqual(db.get('brand_members/tb/managers'), null, 'the member stays revoked');
  assert.ok(db.get('brand_members/tb/invite_applied/inviteAAAAAAAAAAAAAAAAAAAA'), 'the marker is kept after the revoke');
});

test('invites: create (owner only, scope), accept → granted; replay → consumed; a used link refuses another uid', async () => {
  const db = createFakeDb(base());
  const d = { ...deps(db), randomToken };
  assert.deepStrictEqual(await I.createInvite(d, { uid: 'nobody1', token: {} }, { kind: 'manager', brandId: 'tb', rid: 'tb_centro' }), { ok: false, code: 'forbidden' });
  assert.strictEqual((await I.createInvite(d, { uid: 'ownerA', token: {} }, { kind: 'manager', brandId: 'tb', rid: 'tb_norte' })).code, 'location_not_member');
  assert.strictEqual((await I.createInvite(d, { uid: 'ownerA', token: {} }, { kind: 'owner', brandId: 'tb', rid: 'tb_centro' })).code, 'bad_rid');
  const c = await I.createInvite(d, { uid: 'ownerA', token: {} }, { kind: 'manager', brandId: 'tb', rid: 'tb_centro' });
  assert.ok(c.ok && c.expires_at === clock + I.TTL_MS);
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'newMgr1', token: { customer: true } }, c.inviteId), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'newMgr1', token: {} }, c.inviteId), { ok: true, outcome: 'granted' });
  assert.ok(db.get('brand_members/tb/managers/tb_centro/newMgr1'));
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'newMgr1', token: {} }, c.inviteId), { ok: true, outcome: 'consumed' });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'otherU1', token: {} }, c.inviteId), { ok: false, code: 'already_used' });
});

test('invites: crash → revoke → retry never re-grants; in-flight retry → pending; expired; inviter lost authority → cancelled', async () => {
  const db = createFakeDb(base());
  const d = { ...deps(db), randomToken };
  const c = await I.createInvite(d, { uid: 'ownerA', token: {} }, { kind: 'manager', brandId: 'tb', rid: 'tb_centro' });
  // crash: step 1 + the roster grant committed, step 3 never ran
  db.put(`member_invites/${c.inviteId}/state`, 'consuming');
  db.put(`member_invites/${c.inviteId}/consuming`, { by: 'mgrX01', at: clock });
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_manager', uid: 'mgrX01', rid: 'tb_centro', inviteId: c.inviteId });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'mgrX01', token: {} }, c.inviteId), { ok: false, code: 'pending' }, 'inside the in-flight window');
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_manager', uid: 'mgrX01', rid: 'tb_centro' });   // the owner revokes
  clock += I.INFLIGHT_MS + 1;
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'mgrX01', token: {} }, c.inviteId), { ok: true, outcome: 'consumed' });
  assert.strictEqual(db.get('brand_members/tb/managers'), null, '🔴 the revoked member is NOT re-granted');
  assert.strictEqual(db.get(`member_invites/${c.inviteId}/state`), 'consumed');
  // expired
  const e = await I.createInvite(d, { uid: 'ownerA', token: {} }, { kind: 'manager', brandId: 'tb', rid: 'tb_centro' });
  clock += I.TTL_MS + 1;
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'late001', token: {} }, e.inviteId), { ok: false, code: 'expired' });
  assert.strictEqual(db.get(`member_invites/${e.inviteId}/state`), 'expired');
  // inviter lost authority between invite and acceptance
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'grant_owner', uid: 'ownerB' });
  const g = await I.createInvite(d, { uid: 'ownerB', token: {} }, { kind: 'owner', brandId: 'tb' });
  await R.mutateRoster(deps(db), 'tb', owner('ownerA'), { type: 'revoke_owner', uid: 'ownerB' });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'wouldBe1', token: {} }, g.inviteId), { ok: false, code: 'inviter_not_authorized' });
  assert.strictEqual(db.get(`member_invites/${g.inviteId}/state`), 'cancelled', 'an outstanding invite cannot restore access after its issuer lost authority');
  assert.strictEqual(db.get('brand_members/tb/owners/wouldBe1'), null);
});

test('invites: cancel (owner of the brand only); a cancelled link refuses', async () => {
  const db = createFakeDb(base());
  const d = { ...deps(db), randomToken };
  const c = await I.createInvite(d, { uid: 'ownerA', token: {} }, { kind: 'owner', brandId: 'tb' });
  assert.deepStrictEqual(await I.cancelInvite(d, { uid: 'nobody1', token: {} }, c.inviteId), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await I.cancelInvite(d, { uid: 'ownerA', token: {} }, c.inviteId), { ok: true });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'someone1', token: {} }, c.inviteId), { ok: false, code: 'cancelled' });
  assert.deepStrictEqual(await I.acceptInvite(d, { uid: 'someone1', token: {} }, 'tooShort'), { ok: false, code: 'bad_invite' });
});
