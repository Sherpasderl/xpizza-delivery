'use strict';
// codex build r1 P1-1 — the team ENDPOINTS through their core (access/team-http-core.js): auth order, the can() gate through
// the ONE resolver, the write flag, status mapping, and a full owner → invitee round trip.
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const H = require('./team-http-core');

const base = () => ({
  brands: { tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
  restaurants: { tb_centro: { identity: { brand_id: 'tb' } }, tb_sur: { identity: { brand_id: 'tb' } } },
  brand_members: { tb: { owners: { ownerA: { granted_at: 1, granted_by: 'cli:op' } } } },
  dispatchers: { disp01: true },
});
const TOKENS = {
  owner: { uid: 'ownerA' }, disp: { uid: 'disp01' }, cust: { uid: 'cust001', customer: true }, dev: { uid: 'hh_tb_centro_x', handheld: true, rid: 'tb_centro' },
  invitee: { uid: 'mgrH001', email: 'mgr.h@m.hn', email_verified: true }, stranger: { uid: 'strng01', email: 'other@m.hn', email_verified: true },
};
let n = 0;
const deps = (db) => ({ db, verifyIdToken: async (t) => { if (!TOKENS[t]) throw new Error('bad'); return TOKENS[t]; }, now: () => 1000, randomToken: () => `httpTok${String(++n).padStart(4, '0')}CCCCCCCCCCCCCCC` });
const req = (who, body, method = 'POST') => ({ method, body, get: (h) => (h.toLowerCase() === 'authorization' && who ? `Bearer ${who}` : undefined) });

test('auth order: method → bearer → verified token → customer / handheld refused; unknown endpoint 404', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(await H.handle('memberInvite', deps(db), req('owner', {}, 'GET')), { status: 405, body: { error: 'method_not_allowed' } });
  assert.strictEqual((await H.handle('memberInvite', deps(db), req(null, {}))).status, 401);
  assert.strictEqual((await H.handle('memberInvite', deps(db), req('forged', {}))).status, 401);
  assert.deepStrictEqual(await H.handle('memberInvite', deps(db), req('cust', { brandId: 'tb' })), { status: 403, body: { error: 'forbidden' } });
  assert.deepStrictEqual(await H.handle('memberInvite', deps(db), req('dev', { brandId: 'tb' })), { status: 403, body: { error: 'forbidden' } });
  assert.strictEqual((await H.handle('nope', deps(db), req('owner', {}))).status, 404);
  assert.deepStrictEqual(Object.keys(H.ROUTES).sort(), ['memberAcceptInvite', 'memberCancelInvite', 'memberInvite', 'memberList', 'memberReissueInvite', 'memberRevoke', 'memberSetMenuPermission']);
});

test('can() gate through the resolver: only the brand\'s owner reaches the team ops (a dispatcher does not); writes DARK while the flag is off', async () => {
  const db = createFakeDb(base());
  const body = { brandId: 'tb', rids: ['tb_centro'], email: 'mgr.h@m.hn' };
  assert.deepStrictEqual(await H.handle('memberInvite', deps(db), req('disp', body)), { status: 403, body: { error: 'forbidden' } });
  assert.deepStrictEqual(await H.handle('memberList', deps(db), req('disp', { brandId: 'tb' })), { status: 403, body: { error: 'forbidden' } });
  assert.deepStrictEqual(await H.handle('memberInvite', deps(db), req('owner', body)), { status: 503, body: { error: 'writes_disabled' } }, 'the freeze');
  assert.deepStrictEqual(await H.handle('memberInvite', deps(db), req('owner', { ...body, brandId: 'Bad-Id' })), { status: 400, body: { error: 'bad_brand' } });
  db.failReads.add('brand_members');
  assert.deepStrictEqual(await H.handle('memberList', deps(db), req('owner', { brandId: 'tb' })), { status: 503, body: { error: 'unavailable' } }, 'an outage is 503, never a lower answer');
});

test('round trip: invite → (stranger refused) → accept → list → toggle → reissue/cancel by invite → revoke', async () => {
  const db = createFakeDb(base());
  db.put('platform_config/membership_writes_enabled', true);
  const inv = await H.handle('memberInvite', deps(db), req('owner', { brandId: 'tb', rids: ['tb_centro', 'tb_sur'], email: 'mgr.h@m.hn' }));
  assert.strictEqual(inv.status, 200); assert.ok(inv.body.inviteId);
  assert.deepStrictEqual(await H.handle('memberAcceptInvite', deps(db), req('stranger', { inviteId: inv.body.inviteId })), { status: 403, body: { error: 'email_mismatch' } });
  assert.deepStrictEqual(await H.handle('memberAcceptInvite', deps(db), req('invitee', { inviteId: inv.body.inviteId })), { status: 200, body: { ok: true, outcome: 'granted' } });
  assert.deepStrictEqual(await H.handle('memberAcceptInvite', deps(db), req('invitee', { inviteId: inv.body.inviteId })), { status: 200, body: { ok: true, outcome: 'consumed' } });
  assert.deepStrictEqual((await H.handle('memberList', deps(db), req('owner', { brandId: 'tb' }))).body, { ok: true, owner: 'ownerA', managers: { mgrH001: { rids: ['tb_centro', 'tb_sur'], can_edit_menu: false } } });
  assert.strictEqual((await H.handle('memberSetMenuPermission', deps(db), req('owner', { brandId: 'tb', uid: 'mgrH001', can_edit_menu: true }))).status, 200);
  // a second invite, reissued then cancelled — the brand comes from the invite record
  const i2 = await H.handle('memberInvite', deps(db), req('owner', { brandId: 'tb', rids: ['tb_sur'], email: 'x2@m.hn' }));
  const r2 = await H.handle('memberReissueInvite', deps(db), req('owner', { inviteId: i2.body.inviteId }));
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(await H.handle('memberReissueInvite', deps(db), req('disp', { inviteId: r2.body.inviteId })), { status: 403, body: { error: 'forbidden' } });
  assert.deepStrictEqual(await H.handle('memberCancelInvite', deps(db), req('owner', { inviteId: r2.body.inviteId })), { status: 200, body: { ok: true } });
  assert.deepStrictEqual(await H.handle('memberCancelInvite', deps(db), req('owner', { inviteId: 'short' })), { status: 400, body: { error: 'bad_invite' } });
  assert.deepStrictEqual(await H.handle('memberRevoke', deps(db), req('owner', { brandId: 'tb', uid: 'mgrH001' })), { status: 200, body: { ok: true, outcome: 'applied' } });
  assert.strictEqual(db.get('brand_members/tb/managers'), null);
});
