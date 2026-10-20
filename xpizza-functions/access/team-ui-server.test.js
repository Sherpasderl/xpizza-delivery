'use strict';
// PLAN-portal-team-invites T-a — the server gaps the «Equipo de trabajo» screen needs:
//   G1 the invite carries a NAME; the member's {name, email} profile lands in the SAME roster transaction as the grant and leaves
//      with the last branch; teamList returns the owner (from the caller's token), named managers and the PENDING invites;
//   G2 update_manager / memberUpdate: the owner's «Editar» (branches + permiso) in ONE transaction.
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('./roster');
const I = require('./invites');
const T = require('./team-core');
const H = require('./team-http-core');

const base = () => ({
  brands: { tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_sur: 'member', tb_norte: 'retired' }, activation: { state: 'on', since: 1 } } },
  restaurants: { tb_centro: { identity: { brand_id: 'tb' } }, tb_sur: { identity: { brand_id: 'tb' } }, tb_norte: { identity: { brand_id: 'tb' } } },
  brand_members: { tb: { owners: { ownerA: { granted_at: 1, granted_by: 'cli:op' } } } },
  dispatchers: { disp01: true },
  platform_config: { membership_writes_enabled: true },
});
let clock = 1000;
let n = 0;
const deps = (db) => ({ db, now: () => clock, randomToken: () => `uiTok${String(++n).padStart(4, '0')}BBBBBBBBBBBBBBBBBB` });
const own = { uid: 'ownerA', token: { email: 'duena@tb.hn', name: 'Marcela Pineda' } };
const acc = (uid) => ({ uid, token: { email: `${uid.toLowerCase()}@m.hn`, email_verified: true } });
const mail = (uid) => `${uid.toLowerCase()}@m.hn`;
const invite = (db, uid, extra = {}) => T.teamInvite(deps(db), own, { name: 'Ana Gerente', brandId: 'tb', rids: ['tb_centro'], email: mail(uid), ...extra });

test('G1 name: required, cleaned (control / zero-width / bidi removed, whitespace collapsed), 1–80 chars', async () => {
  assert.strictEqual(I.normName('  Ana   Pérez '), 'Ana Pérez');
  assert.strictEqual(I.normName('Ana​‮ Pérez\u0007'), 'Ana Pérez', 'zero-width / bidi / control removed');
  for (const bad of [undefined, null, 7, '', '   ', '​', 'x'.repeat(81)]) assert.strictEqual(I.normName(bad), null, JSON.stringify(bad));
  assert.strictEqual(I.normName('x'.repeat(80)), 'x'.repeat(80));
  const db = createFakeDb(base());
  assert.deepStrictEqual(await invite(db, 'mgrN01', { name: '  ' }), { ok: false, code: 'bad_name' });
  assert.strictEqual(db.get('member_invites'), null, 'nothing written on a bad name');
  const ok = await invite(db, 'mgrN01', { name: ' Ana  <b>Gerente</b> ' });
  assert.strictEqual(ok.name, 'Ana <b>Gerente</b>', 'stored verbatim (text), the portal renders it with textContent');
  assert.strictEqual(db.get(`member_invites/${ok.inviteId}/name`), 'Ana <b>Gerente</b>');
  assert.deepStrictEqual(await H.handle('memberInvite', { ...deps(db), verifyIdToken: async () => own.token && { uid: 'ownerA', ...own.token } },
    { method: 'POST', body: { brandId: 'tb', rids: ['tb_centro'], email: mail('mgrN02') }, get: () => 'Bearer x' }), { status: 400, body: { error: 'bad_name' } }, 'HTTP: 400');
});

test('G1 profile: written IN the grant transaction from the invite, kept on a partial revoke, gone with the last branch; never forgeable', async () => {
  const db = createFakeDb(base());
  const inv = await invite(db, 'mgrP01', { rids: ['tb_centro', 'tb_sur'] });
  // the grant op the acceptance builds carries the profile, and applyOp lands grant + profile in ONE next state (one transaction)
  const res = R.applyOp(db.get('brand_members/tb'), { kind: 'owner', uid: 'ownerA' },
    { type: 'grant_manager', uid: 'mgrP01', rids: ['tb_centro'], inviteId: inv.inviteId, emailKey: I.emailKey(mail('mgrP01')), profile: { name: 'Ana Gerente', email: mail('mgrP01') } }, 5);
  assert.ok(res.next.managers.tb_centro.mgrP01 && res.next.profiles && res.next.profiles.mgrP01, 'the grant and the profile are ONE state');
  assert.deepStrictEqual(await T.teamAcceptInvite(deps(db), acc('mgrP01'), { inviteId: inv.inviteId }), { ok: true, outcome: 'granted', password_set: false });
  assert.deepStrictEqual(db.get('brand_members/tb/profiles/mgrP01'), { name: 'Ana Gerente', email: mail('mgrP01') });
  await T.teamRevoke(deps(db), own, { brandId: 'tb', uid: 'mgrP01', rid: 'tb_sur' });
  assert.ok(db.get('brand_members/tb/profiles/mgrP01'), 'still a manager of tb_centro → profile kept');
  await T.teamRevoke(deps(db), own, { brandId: 'tb', uid: 'mgrP01' });
  assert.strictEqual(db.get('brand_members/tb/profiles'), null, 'the last branch gone → the profile goes');
  // an owner cannot write a profile by a direct grant (only an accepted invite carries one)
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', { kind: 'owner', uid: 'ownerA' },
    { type: 'grant_manager', uid: 'mgrP02', rids: ['tb_centro'], profile: { name: 'Forjado', email: 'x@y.hn' } }), { ok: false, code: 'bad_profile' });
  assert.deepStrictEqual(await R.mutateRoster(deps(db), 'tb', { kind: 'owner', uid: 'ownerA' },
    { type: 'revoke_manager', uid: 'mgrP02', profile: { name: 'x', email: 'x@y.hn' } }), { ok: false, code: 'bad_profile' });
});

test('G1 teamList: the owner from the caller token, named managers, and ONLY current, open, unexpired invites', async () => {
  const db = createFakeDb(base());
  const d = deps(db);
  const a = await invite(db, 'mgrL01', { name: 'Zoe Activa', rids: ['tb_centro', 'tb_sur'], can_edit_menu: true });
  await T.teamAcceptInvite(d, acc('mgrL01'), { inviteId: a.inviteId });
  clock = 2000; const p1 = await invite(db, 'mgrL02', { name: 'Pedro Pendiente', rids: ['tb_sur'] });
  clock = 3000; const s1 = await invite(db, 'mgrL03', { name: 'Sara Vieja' });
  clock = 3100; const s2 = await T.teamReissueInvite(d, own, { inviteId: s1.inviteId });   // supersedes s1
  clock = 3200; const c1 = await invite(db, 'mgrL04', { name: 'Cancelada' });
  await T.teamCancelInvite(d, own, { inviteId: c1.inviteId });
  clock = 3300; const e1 = await invite(db, 'mgrL05', { name: 'Vencida' });
  clock = 3300 + I.TTL_MS + 1;   // e1 (and everything before it) is now expired …
  const late = await invite(db, 'mgrL06', { name: 'Recién' });
  const L = await T.teamList(d, own, { brandId: 'tb' });
  assert.deepStrictEqual(L.owner, { uid: 'ownerA', name: 'Marcela Pineda', email: 'duena@tb.hn' });
  assert.deepStrictEqual(L.managers, [{ uid: 'mgrL01', name: 'Zoe Activa', email: mail('mgrL01'), rids: ['tb_centro', 'tb_sur'], can_edit_menu: true }]);
  assert.deepStrictEqual(L.pending.map((p) => p.inviteId), [late.inviteId], '… so only the fresh one is pending: expired, superseded, cancelled, consumed never listed');
  assert.deepStrictEqual(L.pending[0], { inviteId: late.inviteId, name: 'Recién', email: mail('mgrL06'), rids: ['tb_centro'], can_edit_menu: false, created_at: clock, expires_at: clock + I.TTL_MS });
  clock = 2500;   // before the expiry: p1 and s2 pending (newest first); s1 superseded; c1 cancelled
  const L2 = await T.teamList(d, own, { brandId: 'tb' });
  assert.ok(L2.pending.some((p) => p.inviteId === p1.inviteId) && !L2.pending.some((p) => [s1.inviteId, c1.inviteId, a.inviteId].includes(p.inviteId)));
  assert.ok(L2.pending.some((p) => p.inviteId === s2.inviteId) && L2.pending.some((p) => p.inviteId === e1.inviteId));
  assert.deepStrictEqual(L2.pending.map((p) => p.created_at), [...L2.pending.map((p) => p.created_at)].sort((x, y) => y - x), 'newest first');
  db.failReads.add('member_invites');
  assert.deepStrictEqual(await T.teamList(d, own, { brandId: 'tb' }), { ok: false, code: 'unavailable' }, 'never a partial list');
  clock = 1000;
});

test('G2 update_manager / memberUpdate: the full branch set + permiso in ONE transaction; only an existing manager; member branches only', async () => {
  const db = createFakeDb(base());
  const d = deps(db);
  const inv = await invite(db, 'mgrU01', { rids: ['tb_centro'] });
  await T.teamAcceptInvite(d, acc('mgrU01'), { inviteId: inv.inviteId });
  assert.deepStrictEqual(await T.teamUpdateManager(d, own, { brandId: 'tb', uid: 'mgrU01', rids: ['tb_sur'], can_edit_menu: true }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(db.get('brand_members/tb/managers'), { tb_sur: { mgrU01: { granted_at: 1000, granted_by: 'ownerA' } } }, 'centro removed + sur added together');
  assert.deepStrictEqual(db.get('brand_members/tb/manager_perms/mgrU01'), { can_edit_menu: true });
  assert.deepStrictEqual(db.get('member_of/mgrU01/locations'), { tb_sur: 'manager' }, 'the discovery index follows');
  assert.ok(db.get('brand_members/tb/profiles/mgrU01'), 'the profile is unchanged');
  assert.deepStrictEqual(await T.teamUpdateManager(d, own, { brandId: 'tb', uid: 'mgrU01', rids: ['tb_sur'], can_edit_menu: true }), { ok: true, outcome: 'noop' });
  for (const [body, code] of [
    [{ uid: 'mgrU01', rids: [], can_edit_menu: true }, 'bad_rids'],
    [{ uid: 'mgrU01', rids: ['tb_sur', 'tb_sur'], can_edit_menu: true }, 'bad_rids'],
    [{ uid: 'mgrU01', rids: ['tb_norte'], can_edit_menu: true }, 'location_not_member'],
    [{ uid: 'mgrU01', rids: ['tb_sur'], can_edit_menu: 'yes' }, 'bad_perms'],
    [{ uid: 'nobody01', rids: ['tb_sur'], can_edit_menu: false }, 'not_a_manager'],
  ]) assert.deepStrictEqual(await T.teamUpdateManager(d, own, { brandId: 'tb', ...body }), { ok: false, code }, code);
  assert.deepStrictEqual(await T.teamUpdateManager(d, { uid: 'mgrU01', token: {} }, { brandId: 'tb', uid: 'mgrU01', rids: ['tb_centro', 'tb_sur'], can_edit_menu: true }), { ok: false, code: 'forbidden' }, 'a manager cannot widen themself');
  // HTTP: the owner only (a dispatcher is refused at the can() gate), and DARK while the flag is off
  const http = (who, body) => H.handle('memberUpdate', { ...d, verifyIdToken: async () => ({ uid: who }) }, { method: 'POST', body: { brandId: 'tb', ...body }, get: () => 'Bearer x' });
  assert.deepStrictEqual(await http('disp01', { uid: 'mgrU01', rids: ['tb_centro'], can_edit_menu: false }), { status: 403, body: { error: 'forbidden' } });
  assert.deepStrictEqual(await http('ownerA', { uid: 'mgrU01', rids: ['tb_centro'], can_edit_menu: false }), { status: 200, body: { ok: true, outcome: 'applied' } });
  db.put('platform_config/membership_writes_enabled', false);
  assert.deepStrictEqual(await http('ownerA', { uid: 'mgrU01', rids: ['tb_sur'], can_edit_menu: false }), { status: 503, body: { error: 'writes_disabled' } });
});

test('G1/G2 invariants (codex plan r1 P2-7): read matrix; authority + target re-checked in the transaction; markers / owner / index preserved; no replay resurrection', async () => {
  const db = createFakeDb({ ...base(),
    brands: { ...base().brands, ob: { name: 'OB', active: true, locations: { ob_1: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: { ...base().restaurants, ob_1: { identity: { brand_id: 'ob' } } },
    brand_members: { ...base().brand_members, ob: { owners: { ownerB: { granted_at: 1 } } } } });
  const d = deps(db);
  const inv = await invite(db, 'mgrI01', { rids: ['tb_centro'] });
  await T.teamAcceptInvite(d, acc('mgrI01'), { inviteId: inv.inviteId });
  // teamList: owner only — manager / dispatcher / the OTHER brand's owner / customer / handheld refused
  for (const ctx of [{ uid: 'mgrI01', token: {} }, { uid: 'disp01', token: {} }, { uid: 'ownerB', token: {} }, { uid: 'ownerA', token: { customer: true } }, { uid: 'ownerA', token: { handheld: true } }]) {
    assert.strictEqual((await T.teamList(d, ctx, { brandId: 'tb' })).ok, false, JSON.stringify(ctx));
  }
  // authority re-checked INSIDE the transaction: applyOp refuses a non-owner actor and a vanished target on the state it is given
  const cur = db.get('brand_members/tb');
  assert.deepStrictEqual(R.applyOp(cur, { kind: 'owner', uid: 'ownerB' }, { type: 'update_manager', uid: 'mgrI01', rids: ['tb_sur'], can_edit_menu: true }, 9), { code: 'forbidden' });
  const revoked = JSON.parse(JSON.stringify(cur)); delete revoked.managers;
  assert.deepStrictEqual(R.applyOp(revoked, { kind: 'owner', uid: 'ownerA' }, { type: 'update_manager', uid: 'mgrI01', rids: ['tb_sur'], can_edit_menu: true }, 9), { code: 'not_a_manager' }, 'a concurrent revoke wins');
  // cross-brand branch refused; exactly one owner kept; the application marker and the profile untouched by an update
  assert.deepStrictEqual(await T.teamUpdateManager(d, own, { brandId: 'tb', uid: 'mgrI01', rids: ['ob_1'], can_edit_menu: true }), { ok: false, code: 'location_not_member' });
  const marker = db.get(`brand_members/tb/invite_applied/${inv.inviteId}`);
  const profile = db.get('brand_members/tb/profiles/mgrI01');
  assert.deepStrictEqual(await T.teamUpdateManager(d, own, { brandId: 'tb', uid: 'mgrI01', rids: ['tb_centro', 'tb_sur'], can_edit_menu: false }), { ok: true, outcome: 'applied' });
  assert.deepStrictEqual(Object.keys(db.get('brand_members/tb/owners')), ['ownerA']);
  assert.deepStrictEqual(db.get(`brand_members/tb/invite_applied/${inv.inviteId}`), marker);
  assert.deepStrictEqual(db.get('brand_members/tb/profiles/mgrI01'), profile);
  assert.deepStrictEqual(db.get('member_of/mgrI01/locations'), { tb_centro: 'manager', tb_sur: 'manager' });
  // revoke → a replayed acceptance of the SAME invite never recreates the access or the profile (the marker decides)
  await T.teamRevoke(d, own, { brandId: 'tb', uid: 'mgrI01' });
  db.put(`member_invites/${inv.inviteId}/state`, 'consuming'); db.put(`member_invites/${inv.inviteId}/consuming`, { by: 'mgrI01', at: clock - I.INFLIGHT_MS - 1 });   // past the in-flight window → recovery
  assert.deepStrictEqual(await T.teamAcceptInvite(d, acc('mgrI01'), { inviteId: inv.inviteId }), { ok: true, outcome: 'consumed', password_set: false });
  assert.strictEqual(db.get('brand_members/tb/managers'), null);
  assert.strictEqual(db.get('brand_members/tb/profiles'), null);
});

test('password_set (codex plan r2 P1-2): acceptance reports it; memberPasswordSet records ONLY the caller, verified; the cutover backfill sets it for owners', async () => {
  const db = createFakeDb(base());
  const d = deps(db);
  const inv = await invite(db, 'mgrW01');
  const a1 = await T.teamAcceptInvite(d, acc('mgrW01'), { inviteId: inv.inviteId });
  assert.deepStrictEqual(a1, { ok: true, outcome: 'granted', password_set: false }, 'a NEW email-link account → A2 is shown');
  assert.deepStrictEqual(await T.teamPasswordSet(d, { uid: 'mgrW01', token: { email: 'mgrw01@m.hn' } }, {}), { ok: false, code: 'forbidden' }, 'an unverified token is refused');
  assert.deepStrictEqual(await T.teamPasswordSet(d, { uid: 'mgrW01', token: { handheld: true, email_verified: true } }, {}), { ok: false, code: 'forbidden' });
  assert.deepStrictEqual(await T.teamPasswordSet(d, acc('mgrW01'), { uid: 'someoneElse' }), { ok: true, password_set: true }, 'parameters are ignored: always the caller');
  assert.deepStrictEqual(db.get('portal_accounts/mgrW01'), { password_set: true, at: 1000 });
  assert.strictEqual(db.get('portal_accounts/someoneElse'), null);
  assert.deepStrictEqual(await T.teamAcceptInvite(d, acc('mgrW01'), { inviteId: inv.inviteId }), { ok: true, outcome: 'consumed', password_set: true }, 'a later visit skips A2');
  clock = 2000; await T.teamPasswordSet(d, acc('mgrW01'), {});
  assert.deepStrictEqual(db.get('portal_accounts/mgrW01'), { password_set: true, at: 1000 }, 'idempotent');
  clock = 1000;
  db.put('platform_config/membership_writes_enabled', false);
  assert.deepStrictEqual(await T.teamPasswordSet(d, acc('mgrW01'), {}), { ok: false, code: 'writes_disabled' });
  // the cutover backfill: the census owner is recorded as having a password (they sign in with one today)
  const C = require('./membership-admin-core');
  const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
  const prod = createFakeDb({ restaurants: { lb: { identity: { name: 'L' }, owners: { ownerL1: true } } }, owner_restaurants: { ownerL1: { lb: true } }, brands: { lb: legacy('lb') } });
  const users = { ownerL1: { emailVerified: true } };
  assert.strictEqual(await C.runMembershipAdmin({ db: prod, op: 'backfill', apply: true, operator: 'op', now: () => 7, log: () => {}, getUser: async (u) => users[u] }), 0);
  assert.deepStrictEqual(prod.get('portal_accounts/ownerL1'), { password_set: true, at: 7 }, 'a VERIFIED owner account is recorded');
  // codex plan r3: an UNVERIFIED owner gets NO flag (the email link would remove its password) → acceptance reports false → A2 shown
  const prod2 = createFakeDb({ restaurants: { lb: { identity: { name: 'L' }, owners: { ownerL2: true } } }, owner_restaurants: { ownerL2: { lb: true } }, brands: { lb: legacy('lb') } });
  assert.strictEqual(await C.runMembershipAdmin({ db: prod2, op: 'backfill', apply: true, operator: 'op', now: () => 7, log: () => {}, getUser: async () => ({ emailVerified: false }) }), 0);
  assert.strictEqual(prod2.get('portal_accounts'), null, 'unverified → no password_set');
  assert.ok(prod2.get('brand_members/lb/owners/ownerL2'), 'the ownership itself is still backfilled');
  const prod3 = createFakeDb({ restaurants: { lb: { identity: { name: 'L' }, owners: { ownerL3: true } } }, owner_restaurants: { ownerL3: { lb: true } }, brands: { lb: legacy('lb') } });
  assert.strictEqual(await C.runMembershipAdmin({ db: prod3, op: 'backfill', apply: true, operator: 'op', now: () => 7, log: () => {}, getUser: async () => { throw new Error('auth down'); } }), 0);
  assert.strictEqual(prod3.get('portal_accounts'), null, 'an Auth lookup failure → no flag (fail safe)');
  assert.strictEqual(await require('./portal-account').passwordSet(prod2, 'ownerL2'), false, 'so acceptance reports password_set:false and A2 is shown');
});

test('codex build r1: «Editar» validates only ADDED branches — a menu-only change keeps a RETIRED retained grant; an added retired branch is refused', async () => {
  const db = createFakeDb(base());
  const d = deps(db);
  const inv = await invite(db, 'mgrK01', { rids: ['tb_centro', 'tb_sur'] });
  await T.teamAcceptInvite(d, acc('mgrK01'), { inviteId: inv.inviteId });
  db.put('brands/tb/locations/tb_sur', 'retired');   // tb_sur retires while the grant is held
  assert.deepStrictEqual(await T.teamUpdateManager(d, own, { brandId: 'tb', uid: 'mgrK01', rids: ['tb_centro', 'tb_sur'], can_edit_menu: true }), { ok: true, outcome: 'applied' }, 'menu-only change with a retained retired grant');
  assert.deepStrictEqual(db.get('brand_members/tb/manager_perms/mgrK01'), { can_edit_menu: true });
  assert.ok(db.get('brand_members/tb/managers/tb_sur/mgrK01'), 'the retained retired grant is untouched');
  assert.deepStrictEqual(await T.teamUpdateManager(d, own, { brandId: 'tb', uid: 'mgrK01', rids: ['tb_centro', 'tb_norte'], can_edit_menu: true }), { ok: false, code: 'location_not_member' }, 'ADDING a retired branch is refused');
  // transaction-time: a branch that was not validated as an add (the roster moved after the pre-check) is refused inside applyOp
  const cur = db.get('brand_members/tb');
  assert.deepStrictEqual(R.applyOp(cur, { kind: 'owner', uid: 'ownerA' }, { type: 'update_manager', uid: 'mgrK01', rids: ['tb_centro', 'tb_norte'], can_edit_menu: true, _validatedAdds: [] }, 9), { code: 'location_not_member' });
});

test('codex build r1 P1: catalogRequestPublish is DARK behind the shared write flag — false / missing / malformed / read failure → 503, nothing called', async () => {
  for (const [label, seed, fail] of [['false', false], ['missing', undefined], ['malformed', 'true'], ['read failure', true, true]]) {
    const db = createFakeDb({ ...base(), platform_config: seed === undefined ? {} : { membership_writes_enabled: seed } });
    if (fail) db.failReads.add('platform_config');
    let touched = false;
    const r = await H.handle('catalogRequestPublish', { db, verifyIdToken: async () => ({ uid: 'mgrX01' }), get fs() { touched = true; return null; }, readActiveBuilt: async () => { touched = true; }, readDraft: async () => { touched = true; } },
      { method: 'POST', body: { restaurantId: 'tb_centro', token: 'x' }, get: () => 'Bearer x' });
    assert.deepStrictEqual(r, { status: 503, body: { error: 'writes_disabled' } }, `${label}: 503 writes_disabled — the core never ran`);
    assert.strictEqual(touched, false, `${label}: the core never ran`);
  }
});
