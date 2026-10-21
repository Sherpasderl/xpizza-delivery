'use strict';
// PORTAL-UI slice 2 (PLAN-portal-ui-slice2-equipos r1.1 §3, §5) — E6 getBranchDevices / E7 revokeBranchDevice / E1's linked
// count over the shared fake RTDB, through the REAL writers: membership via roster (bootstrap_owner / grant_manager), devices via
// the REAL H1 pairDevice core, last_seen via the REAL heartbeat core, the pause via the REAL writePause (inside E7), read back
// by the REAL order-control reader. Auth is a recording stand-in here; the emulator suite runs the same paths on the REAL Auth
// emulator. Synthetic third brand only. Run: node portal/ops-devices.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const R = require('../access/roster');
const I = require('../access/invites');
const D = require('../merchant/merchant-devices');
const { resolveBrand } = require('../merchant/merchant-brand');
const C = require('./ops-core');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
let clock = 1_800_000_000_000;
const now = () => clock;
function fakeAuth({ failOnce } = {}) {
  const calls = [];
  return {
    calls,
    async createUser({ uid }) { calls.push(['createUser', uid]); return { uid }; },
    async createCustomToken(uid) { return `tok:${uid}`; },
    async updateUser(uid, p) { calls.push(['updateUser', uid, p]); if (failOnce === 'updateUser') { failOnce = null; throw new Error('auth down'); } },
    async revokeRefreshTokens(uid) { calls.push(['revokeRefreshTokens', uid]); },
  };
}
const seed = () => ({
  brands: { tb: { name: 'Tercera Marca', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
  restaurants: {
    tb_centro: { identity: { brand_id: 'tb', name: 'Centro', active: true, prep_default_min: 20, version: 1 }, order_surface: 'handheld' },
    tb_sur: { identity: { brand_id: 'tb', name: 'Sur', active: true, prep_default_min: 25, version: 1 } },   // kds (absent)
  },
});
const adminOf = (fake) => ({ ref: (p) => { const r = fake.ref(p); return { ...r, get: () => r.once() }; } });
const quiet = { warn() {}, log() {}, error() {} };
const reqOf = (uid, extra) => ({ get: (h) => (h === 'authorization' ? `Bearer ${uid}` : undefined), ...extra });
const verifyIdToken = async (t) => ({ uid: t });

async function world() {
  const fake = createFakeDb(seed());
  const auth = fakeAuth();
  const CLI = { kind: 'cli', operator: 'op' };
  assert.deepStrictEqual(await R.mutateRoster({ db: fake, now }, 'tb', CLI, { type: 'bootstrap_owner', uid: 'ownerT1' }), { ok: true, outcome: 'applied' });
  // the manager arrives through the REAL invite → accept flow (the only writer of a display profile)
  let t = 0;
  const id = { db: fake, now, randomToken: () => `tok${String(++t).padStart(4, '0')}AAAAAAAAAAAAAAAAAAAAAAA` };
  const inv = await I.createInvite(id, { uid: 'ownerT1', token: {} }, { name: 'Lucía Paz', brandId: 'tb', rids: ['tb_sur'], email: 'lucia@m.hn' });
  assert.ok(inv.ok, JSON.stringify(inv));
  assert.deepStrictEqual(await I.acceptInvite(id, { uid: 'mgrSur01', token: { email: 'lucia@m.hn', email_verified: true } }, inv.inviteId), { ok: true, outcome: 'granted' });
  fake.put('platform_config/handheld_pairing_enabled', true);
  let n = 0;
  const pair = async (who, rid) => D.pairDevice({ db: fake, adminAuth: auth, resolveBrand, HttpsError, now, randomId: () => `d${++n}` }, { uid: who, token: {} }, { rid, label: 'Equipo de la sucursal' });
  const beat = async (uid, rid) => D.heartbeat({ db: fake, resolveBrand, HttpsError, now }, { uid, token: { handheld: true, rid } }, { rid });
  const deps = (a = auth) => ({ db: adminOf(fake), verifyIdToken, adminAuth: a, HttpsError, now, timestamp: () => clock, newOpId: () => `oc_t${++n}`, log: quiet });
  const e6 = (uid, query) => C.getBranchDevicesCore(deps(), reqOf(uid, { method: 'GET', query }));
  const e7 = (uid, body, a) => C.revokeBranchDeviceCore(deps(a), reqOf(uid, { method: 'POST', body }));
  return { fake, auth, pair, beat, e6, e7, deps };
}

test('E6: owner sees both branches; linked rows only, primitives only, «n» by pairing order, sorted by last contact', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  clock += 1000;
  const b = await w.pair('mgrSur01', 'tb_sur');
  clock += 1000;
  const c = await w.pair('ownerT1', 'tb_centro');
  await w.beat(c.uid, 'tb_centro');                       // c seen, a never
  w.fake.put(`restaurants/tb_centro/handhelds/${a.uid}/stray_secret`, 'tok-should-never-leak');
  w.fake.put('restaurants/tb_centro/handhelds/human_row', { revoked: false });   // not a handheld row
  const out = await w.e6('ownerT1', { brandId: 'tb' });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.pairing_enabled, true);
  assert.strictEqual(out.body.fetched_at, clock);
  const centro = out.body.branches.find((x) => x.rid === 'tb_centro');
  assert.deepStrictEqual([centro.prep_ok, centro.order_surface], [true, 'handheld']);
  assert.deepStrictEqual(centro.devices.map((d) => [d.uid, d.n]), [[c.uid, 2], [a.uid, 1]], 'last-seen first; never-seen last; n by pairing order');
  for (const d of centro.devices) assert.deepStrictEqual(Object.keys(d).sort(), ['last_seen', 'n', 'paired_at', 'paired_by_name', 'paired_by_owner', 'uid']);
  assert.deepStrictEqual([centro.devices[0].paired_by_owner, centro.devices[0].paired_by_name], [true, null], 'paired by the owner');
  const sur = out.body.branches.find((x) => x.rid === 'tb_sur');
  assert.deepStrictEqual([sur.order_surface, sur.devices[0].paired_by_name, sur.devices[0].paired_by_owner], ['kds', 'Lucía Paz', false]);
  const json = JSON.stringify(out.body);
  for (const bad of ['tok-should-never-leak', 'Equipo de la sucursal', 'mgrSur01', 'ownerT1', 'lucia@m.hn', 'pair_gen', 'revoked', 'human_row']) assert.ok(!json.includes(bad), `never sent: ${bad}`);
  void b;
});

test('E6: a manager sees only their branch (A-not-B); a stranger / customer / handheld is refused; pairing gate mirrored', async () => {
  const w = await world();
  await w.pair('ownerT1', 'tb_centro');
  const m = await w.e6('mgrSur01', { brandId: 'tb' });
  assert.deepStrictEqual(m.body.branches.map((x) => x.rid), ['tb_sur']);
  assert.strictEqual((await w.e6('mgrSur01', { restaurantId: 'tb_centro' })).status, 403, 'not their branch');
  assert.strictEqual((await w.e6('nobody01', { brandId: 'tb' })).status, 403);
  assert.strictEqual((await w.e6('ownerT1', {})).status, 400);
  w.fake.put('platform_config/handheld_pairing_enabled', 'true');
  assert.strictEqual((await w.e6('ownerT1', { restaurantId: 'tb_centro' })).body.pairing_enabled, false, "the string 'true' is not on");
});

test('E6: a per-branch read failure is that branch\'s error (never an empty list); all failing → 503; access outage → 503', async () => {
  const w = await world();
  w.fake.failReads.add('restaurants/tb_sur/handhelds');
  const out = await w.e6('ownerT1', { brandId: 'tb' });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.branches.find((x) => x.rid === 'tb_sur'), { rid: 'tb_sur', error: 'devices_unavailable' });
  w.fake.failReads.add('restaurants/tb_centro/handhelds');
  assert.strictEqual((await w.e6('ownerT1', { brandId: 'tb' })).status, 503);
  w.fake.failReads.clear();
  w.fake.failReads.add('dispatchers/');
  assert.strictEqual((await w.e6('ownerT1', { brandId: 'tb' })).status, 503);
});

test('E1: «Equipos» counts LINKED rows only (revoked / non-handheld never counted)', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  await w.pair('ownerT1', 'tb_centro');
  await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid });
  w.fake.put('restaurants/tb_centro/handhelds/human_row', { revoked: false });
  const out = await C.getMyBranchesCore({ db: adminOf(w.fake), verifyIdToken, now, log: quiet }, reqOf('ownerT1', { method: 'GET' }));
  assert.strictEqual(out.body.branches.find((b) => b.rid === 'tb_centro').devices, 1);
});

test('E7: revoke via the unmodified core; repeat is idempotent; manager → other branch 403 and nothing written; 404 / 400', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  const b = await w.pair('ownerT1', 'tb_centro');
  const s = await w.pair('mgrSur01', 'tb_sur');
  const before = JSON.stringify(w.fake.get('restaurants/tb_centro/handhelds'));
  assert.strictEqual((await w.e7('mgrSur01', { rid: 'tb_centro', uid: a.uid })).status, 403);
  assert.strictEqual(JSON.stringify(w.fake.get('restaurants/tb_centro/handhelds')), before, 'nothing written');
  assert.strictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: 'hh_nope' })).status, 404);
  assert.strictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: 'a/b' })).status, 400);
  assert.strictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid, pause: true })).status, 400, 'unknown field');
  const r1 = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid });
  assert.deepStrictEqual(r1.body, { ok: true, uid: a.uid, paused: false }, 'another device remains → no pause');
  const row = w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`);
  assert.deepStrictEqual([row.revoked, row.revoked_by, row.revoked_at], [true, 'ownerT1', clock]);
  assert.ok(w.auth.calls.some((c) => c[0] === 'updateUser' && c[1] === a.uid && c[2].disabled === true) && w.auth.calls.some((c) => c[0] === 'revokeRefreshTokens' && c[1] === a.uid));
  assert.strictEqual((await w.e7('mgrSur01', { rid: 'tb_sur', uid: s.uid })).body.ok, true, 'a manager revokes on their own branch');
  clock += 5000;
  const r2 = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`), row, 'repeat: metadata unchanged');
  void b;
});

test('E7 partial failure: registry revoked, Auth fails → error; the retry completes Auth with the ORIGINAL metadata', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  await w.pair('ownerT1', 'tb_centro');
  const flaky = fakeAuth({ failOnce: 'updateUser' });
  const r1 = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, flaky);
  assert.strictEqual(r1.status, 500);
  const row1 = w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`);
  assert.strictEqual(row1.revoked, true, 'the registry write already happened');
  clock += 60000;
  const r2 = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, flaky);
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`), row1, 'revoked_at / revoked_by unchanged');
  assert.ok(flaky.calls.filter((c) => c[0] === 'updateUser').length === 2 && flaky.calls.some((c) => c[0] === 'revokeRefreshTokens'));
});

test('E7 owner ruling (b): the LAST device of a handheld branch → revoked AND paused via the real writer («Otro», no expiry)', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  const b = await w.pair('ownerT1', 'tb_centro');
  assert.deepStrictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid })).body.paused, false, 'one remains');
  assert.strictEqual(w.fake.get('order_control/tb_centro'), null, 'non-vacuity: not paused yet');
  const r = await w.e7('ownerT1', { rid: 'tb_centro', uid: b.uid });
  assert.deepStrictEqual(r.body, { ok: true, uid: b.uid, paused: true });
  const cur = w.fake.get('order_control/tb_centro/current');
  assert.deepStrictEqual([cur.paused, cur.reason, cur.by], [true, 'Otro', 'portal:ownerT1']);
  assert.ok(!cur.until, 'until resumed');
  const OCS = require('../order-control-state');
  assert.strictEqual(OCS.effectiveState(w.fake.get('order_control/tb_centro/current'), clock).state, 'paused', 'the REAL intake state reads it as paused');
  // a repeat revoke of the (already revoked) device never re-pauses a branch the owner reopened
  w.fake.put('order_control/tb_centro/current/paused', false);
  const again = await w.e7('ownerT1', { rid: 'tb_centro', uid: b.uid });
  assert.deepStrictEqual(again.body, { ok: true, uid: b.uid, paused: false });
  assert.strictEqual(w.fake.get('order_control/tb_centro/current/paused'), false);
});

test('E7: a kds branch\'s last device → revoked, NOT paused, order_control untouched', async () => {
  const w = await world();
  const s = await w.pair('mgrSur01', 'tb_sur');
  const r = await w.e7('ownerT1', { rid: 'tb_sur', uid: s.uid });
  assert.deepStrictEqual(r.body, { ok: true, uid: s.uid, paused: false });
  assert.strictEqual(w.fake.get('order_control/tb_sur'), null);
});

test('E7: the pause fails after a successful revoke → honest reply (no rollback); E3 with the same spec then pauses', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  // the outage starts AFTER the unlink transaction (at the Auth step), so the pause — not the revoke — is what fails
  const outage = { ...w.auth, async revokeRefreshTokens(uid) { await w.auth.revokeRefreshTokens(uid); w.fake.failReads.add('order_control/tb_centro'); } };
  const r = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, outage);
  assert.deepStrictEqual(r.body, { ok: true, uid: a.uid, paused: false, pause_error: 'unavailable' });
  assert.strictEqual(w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}/revoked`), true, 'never rolled back');
  w.fake.failReads.clear();
  const e3 = await C.setBranchPauseCore(w.deps(), reqOf('ownerT1', { method: 'POST', body: { rid: 'tb_centro', op: 'pause', reason: 'Otro', dur_min: null } }));
  assert.strictEqual(e3.status, 200);
  assert.strictEqual(w.fake.get('order_control/tb_centro/current/paused'), true);
});

// ── codex build r1 P1: the pause is DECIDED in the unlink transaction (pause_owed) and settled on this call or a retry ──
const pauseEvents = (w, rid) => Object.values(w.fake.get(`order_control/${rid}/events`) || {}).filter((e) => e.to && e.to.paused === true);
const e3 = (w, body) => C.setBranchPauseCore(w.deps(), reqOf('ownerT1', { method: 'POST', body }));

test('E7 retry (exact repro): Auth fails after the unlink → 500 with the pause OWED → the retry pauses, exactly once', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  const flaky = fakeAuth({ failOnce: 'updateUser' });
  const r1 = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, flaky);
  assert.strictEqual(r1.status, 500);
  const row = w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`);
  assert.deepStrictEqual([row.revoked, row.revoked_by, row.pause_owed, row.pause_owed_v], [true, 'ownerT1', true, 0], 'unlinked + the pause owed, in ONE transaction');
  assert.strictEqual(w.fake.get('order_control/tb_centro'), null, 'non-vacuity: no pause yet');
  const r2 = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, flaky);
  assert.deepStrictEqual(r2.body, { ok: true, uid: a.uid, paused: true }, 'the retry runs the owed pause');
  assert.strictEqual(pauseEvents(w, 'tb_centro').length, 1);
  assert.strictEqual(w.fake.get('order_control/tb_centro/current/reason'), 'Otro');
  const settled = w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`);
  const { pause_owed: _o, pause_owed_v: _v, ...base } = row;
  assert.deepStrictEqual(settled, base, 'the debt is cleared once paid; revoked_at / revoked_by and every other field unchanged');
  const r3 = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, flaky);
  assert.deepStrictEqual(r3.body, { ok: true, uid: a.uid, paused: false }, 'a further repeat owes nothing');
  assert.strictEqual(pauseEvents(w, 'tb_centro').length, 1, 'still exactly one pause');
});

test('E7 retry: the owner reopened the branch in between → the retry never pauses it; the debt is voided', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  assert.strictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, fakeAuth({ failOnce: 'updateUser' }))).status, 500);
  assert.strictEqual((await e3(w, { rid: 'tb_centro', op: 'pause', reason: 'Otro', dur_min: null })).status, 200);
  assert.strictEqual((await e3(w, { rid: 'tb_centro', op: 'resume' })).status, 200, 'reopened by hand');
  const before = pauseEvents(w, 'tb_centro').length;
  const r = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid });
  assert.deepStrictEqual(r.body, { ok: true, uid: a.uid, paused: false });
  assert.strictEqual(w.fake.get('order_control/tb_centro/current/paused'), false, 'stays open');
  assert.strictEqual(pauseEvents(w, 'tb_centro').length, before, 'no new pause');
  assert.ok(!('pause_owed' in w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`)), 'voided');
});

test('E7 retry: a device paired in between → no pause (the branch has a device again); a pre-read outage → 503, nothing written', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  assert.strictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, fakeAuth({ failOnce: 'updateUser' }))).status, 500);
  await w.pair('ownerT1', 'tb_centro');
  assert.deepStrictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid })).body, { ok: true, uid: a.uid, paused: false });
  assert.strictEqual(w.fake.get('order_control/tb_centro'), null);
  const w2 = await world();
  const b = await w2.pair('ownerT1', 'tb_centro');
  w2.fake.failReads.add('order_control/tb_centro');
  const out = await w2.e7('ownerT1', { rid: 'tb_centro', uid: b.uid });
  assert.deepStrictEqual([out.status, out.body], [503, { error: 'unavailable', retryable: true }]);
  assert.strictEqual(w2.fake.get(`restaurants/tb_centro/handhelds/${b.uid}/revoked`), false, 'nothing written');
  assert.deepStrictEqual(w2.auth.calls.filter((c) => c[0] !== 'createUser'), [], 'Auth untouched');
});

test('E7: the last two devices revoked together → exactly ONE is owed the pause, exactly one pause', async () => {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  const b = await w.pair('ownerT1', 'tb_centro');
  const [ra, rb] = await Promise.all([w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }), w.e7('ownerT1', { rid: 'tb_centro', uid: b.uid })]);
  assert.deepStrictEqual([ra.body.paused, rb.body.paused].sort(), [false, true]);
  assert.strictEqual(pauseEvents(w, 'tb_centro').length, 1);
});

// ── codex build r2: the owed version is enforced AT COMMIT — a reopen racing the retry's pause aborts it ──
async function owedRetryWorld() {
  const w = await world();
  const a = await w.pair('ownerT1', 'tb_centro');
  assert.strictEqual((await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid }, fakeAuth({ failOnce: 'updateUser' }))).status, 500);
  const reopen = async () => {   // the owner pauses and reopens by hand through the REAL E3 writer
    assert.strictEqual((await e3(w, { rid: 'tb_centro', op: 'pause', reason: 'Otro', dur_min: null })).status, 200);
    assert.strictEqual((await e3(w, { rid: 'tb_centro', op: 'resume' })).status, 200);
  };
  return { w, a, reopen };
}

test('E7 retry (codex r2): a reopen landing AFTER the check, BEFORE the pause reads → no pause, debt cleared', async () => {
  const { w, a, reopen } = await owedRetryWorld();
  let armed = true;
  const raw = w.deps().db;
  const db = { ref: (p) => { const r = raw.ref(p); if (p !== 'order_control/tb_centro' || !armed) return r;
    return { ...r, once: async (...x) => { armed = false; await reopen(); return r.once(...x); } }; } };   // only the pause's full-node read
  const out = await C.revokeBranchDeviceCore({ ...w.deps(), db }, reqOf('ownerT1', { method: 'POST', body: { rid: 'tb_centro', uid: a.uid } }));
  assert.ok(!armed, 'non-vacuity: the reopen landed inside the window');
  assert.deepStrictEqual(out.body, { ok: true, uid: a.uid, paused: false });
  assert.strictEqual(w.fake.get('order_control/tb_centro/current/paused'), false, 'stays open');
  assert.strictEqual(pauseEvents(w, 'tb_centro').length, 1, 'only the owner\'s own manual pause');
  assert.ok(!('pause_owed' in w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`)), 'debt cleared');
});

test('E7 retry (codex r2): a reopen landing between the pause\'s read and its COMMIT → the transaction aborts; no pause, debt cleared', async () => {
  const { w, a, reopen } = await owedRetryWorld();
  let fired = false;
  const hook = async (path) => { if (path !== 'order_control/tb_centro') { w.fake.hooks.onTxn = hook; return; } fired = true; await reopen(); };
  w.fake.hooks.onTxn = hook;
  const out = await w.e7('ownerT1', { rid: 'tb_centro', uid: a.uid });
  assert.ok(fired, 'non-vacuity: the reopen landed inside the commit window');
  assert.deepStrictEqual(out.body, { ok: true, uid: a.uid, paused: false });
  assert.strictEqual(w.fake.get('order_control/tb_centro/current/paused'), false);
  assert.strictEqual(pauseEvents(w, 'tb_centro').length, 1);
  assert.ok(!('pause_owed' in w.fake.get(`restaurants/tb_centro/handhelds/${a.uid}`)));
});

// ── advisor r3 condition: pauseAtVersion (expectVersion matching) and the REAL writePause make byte-identical
// order_control writes and replies for the same inputs — the composition can never drift from the writer it mirrors ──
test('GUARD: pauseAtVersion ≡ writePause (byte-identical order_control node + reply) across states and ops', async () => {
  const { writePause } = require('../merchant/merchant-control');
  const OCC = require('../tools/order-control-core');
  const T = 1_800_000_500_000;
  const states = {
    absent: undefined,
    open_v2: { current: { paused: false, since: T - 9e5, by: 'portal:u', principal: 'u', reason: 'reanudar', version: 2, op_id: 'oc_a' }, events: { oc_a: { from: { paused: true }, to: { paused: false }, at: T - 9e5, by: 'portal:u', principal: 'u', reason: 'reanudar', version: 2 } } },
    paused_v5: { current: { paused: true, since: T - 6e5, by: 'cli', principal: 'op', reason: 'Otro', version: 5, op_id: 'oc_b' }, busy: { add_min: 10, until: T + 6e5, since: T - 1e5, by: 'h' }, events: {} },
    timed_v1: { current: { paused: true, until: T + 3e5, since: T - 6e4, by: 'h', principal: 'h', reason: 'Mucha demanda', version: 1, op_id: 'oc_c' } },
  };
  const ops = [
    { op: 'pause', forMs: null, reason: 'Otro', actor: 'portal:ownerT1', principal: 'ownerT1' },
    { op: 'pause', forMs: 30 * 60000, reason: 'Mucha demanda', actor: 'portal:ownerT1', principal: 'ownerT1' },
    { op: 'resume', forMs: null, reason: 'reanudar', actor: 'portal:ownerT1', principal: 'ownerT1' },
  ];
  let compared = 0; let wrote = 0;
  for (const [name, node] of Object.entries(states)) {
    for (const spec of ops) {
      const run = async (fn) => {
        const fake = createFakeDb(node === undefined ? {} : { order_control: { r_x: JSON.parse(JSON.stringify(node)) } });
        const deps = { db: fake, now: () => T, timestamp: () => T, newOpId: () => 'oc_same' };
        const reply = await fn(deps);
        return { reply, stored: JSON.stringify(fake.get('order_control/r_x')) };
      };
      const v = OCC.versionOf(node);
      const a = await run((d) => writePause(d, 'r_x', spec));
      const b = await run((d) => C.pauseAtVersion(d, 'r_x', v, spec));
      assert.deepStrictEqual(b.reply, a.reply, `${name} / ${spec.op}${spec.forMs ? ' timed' : ''}: same reply`);
      assert.strictEqual(b.stored, a.stored, `${name} / ${spec.op}${spec.forMs ? ' timed' : ''}: byte-identical order_control`);
      compared += 1; if (a.reply.op_id) wrote += 1;
    }
  }
  assert.strictEqual(compared, 12);
  assert.ok(wrote >= 8, `non-vacuity: most cases WRITE (${wrote}), not only noops`);
});
