'use strict';
// Unit tests for the S1b driver-account admin ops (injected deps). Run: node lib/driver-admin-ops.test.js
const assert = require('node:assert/strict');
const ops = require('./driver-admin-ops');

class HttpsError extends Error { constructor(code, msg, details) { super(msg); this.code = code; this.details = details; } }
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const normEmail = ops.normEmail;

// ---- in-memory RTDB mock ----
function makeDb(initial) {
  let root = clone(initial) || {};
  let seq = 0;
  const get = (p) => { let n = root; for (const k of p.split('/').filter(Boolean)) { if (n == null) return undefined; n = n[k]; } return n; };
  const set = (p, v) => {
    const parts = p.split('/').filter(Boolean);
    if (!parts.length) { root = v == null ? {} : v; return; }
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) { if (n[parts[i]] == null || typeof n[parts[i]] !== 'object') n[parts[i]] = {}; n = n[parts[i]]; }
    const last = parts[parts.length - 1];
    if (v === undefined || v === null) delete n[last]; else n[last] = v;
  };
  function snap(val, key) {
    return {
      val: () => (val === undefined ? null : val), exists: () => val !== undefined && val !== null, key,
      child: (sub) => { let n = val; for (const k of sub.split('/').filter(Boolean)) { n = n == null ? undefined : n[k]; } return snap(n, sub.split('/').filter(Boolean).pop()); },
      forEach: (cb) => { if (val && typeof val === 'object') for (const k of Object.keys(val)) cb(snap(val[k], k)); },
    };
  }
  const ref = (p) => ({
    once: async () => snap(clone(get(p)), p.split('/').filter(Boolean).pop()),
    set: async (v) => set(p, clone(v)),
    push: (v) => { const key = `-K${String(seq++).padStart(4, '0')}`; if (v !== undefined) set(`${p}/${key}`, clone(v)); const pr = Promise.resolve({ key }); pr.key = key; return pr; },
    async transaction(fn) {
      const cur = get(p); const next = fn(cur === undefined ? null : clone(cur));
      if (next === undefined) return { committed: false, snapshot: snap(clone(get(p))) };
      set(p, clone(next)); return { committed: true, snapshot: snap(clone(get(p))) };
    },
    update: async (obj) => { for (const [k, v] of Object.entries(obj)) set(k, v == null ? undefined : clone(v)); },
  });
  return { ref, _root: () => root, _get: get };
}

function makeAuth(users, clock) {
  users = users || {};
  const err = (code) => { const e = new Error(code); e.code = code; return e; };
  return {
    _users: users,
    getUser: async (uid) => { if (!users[uid]) throw err('auth/user-not-found'); return clone(users[uid]); },
    getUserByEmail: async (email) => { const hit = Object.entries(users).find(([, v]) => normEmail(v.email) === normEmail(email)); if (!hit) throw err('auth/user-not-found'); return Object.assign({ uid: hit[0] }, clone(hit[1])); },
    createUser: async ({ uid, email, disabled }) => {
      if (users[uid]) throw err('auth/uid-already-exists');
      if (Object.values(users).some((v) => normEmail(v.email) === normEmail(email))) throw err('auth/email-already-exists');
      users[uid] = { uid, email, disabled: !!disabled, tokensValidAfterTime: undefined }; return clone(users[uid]);
    },
    updateUser: async (uid, patch) => { Object.assign(users[uid], patch); return clone(users[uid]); },
    revokeRefreshTokens: async (uid) => { users[uid].tokensValidAfterTime = new Date(clock()).toUTCString(); },
    generatePasswordResetLink: async (email) => `https://sherpa.app/set?email=${encodeURIComponent(email)}&code=SECRET`,
  };
}

const NOW = 2_000_000_000_000; // ms
let clockNow = NOW;
const depsFor = (db, auth) => ({ db, auth, HttpsError, now: clockNow });

const DISPATCHERS = { 'disp1': true };
const seedBase = () => ({ dispatchers: clone(DISPATCHERS), config: { driver_admin_enabled: true } });

let passed = 0;
const t = async (name, fn) => { clockNow = NOW; await fn(); passed++; console.log(`  ok ${passed} ${name}`); };
const rejects = (p, code, re) => assert.rejects(p, (e) => e.code === code && (!re || re.test(e.message || '')));

(async () => {
  // ---- kill switch ----
  await t('kill switch off → every op refuses (failed-precondition)', async () => {
    const db = makeDb({ dispatchers: DISPATCHERS, config: { driver_admin_enabled: false }, driver_accounts: { d: { enabled: true, onboarding_state: 'active', version: 1 } } });
    await rejects(ops.assertAdminEnabled(db.ref ? db : db, HttpsError), 'failed-precondition', /deshabilitada/).catch(async () => {});
    await rejects(ops.assertAdminEnabled(db, HttpsError), 'failed-precondition', /deshabilitada/);
  });
  await t('kill switch on → assertAdminEnabled passes', async () => {
    const db = makeDb(seedBase()); await ops.assertAdminEnabled(db, HttpsError);
  });

  // ---- dispatcher gate ----
  await t('dispatcher gate: customer token refused', async () => {
    const db = makeDb(seedBase()); const auth = makeAuth({ disp1: { email: 'd@x', disabled: false } }, () => clockNow);
    await rejects(ops.assertDispatcherCaller('disp1', { customer: true }, depsFor(db, auth)), 'permission-denied', /despacho/);
  });
  await t('dispatcher gate: non-dispatcher refused', async () => {
    const db = makeDb(seedBase()); const auth = makeAuth({ x: { email: 'x@x', disabled: false } }, () => clockNow);
    await rejects(ops.assertDispatcherCaller('x', { auth_time: 1 }, depsFor(db, auth)), 'permission-denied', /despacho/);
  });
  await t('dispatcher gate: dispatcher passes', async () => {
    const db = makeDb(seedBase()); const auth = makeAuth({ disp1: { email: 'd@x', disabled: false } }, () => clockNow);
    await ops.assertDispatcherCaller('disp1', { auth_time: 1 }, depsFor(db, auth));
  });

  // ---- invite (new) ----
  await t('inviteDriver NEW: persists record BEFORE createUser, converges Auth enabled, returns one-time link', async () => {
    const db = makeDb(seedBase()); const auth = makeAuth({ disp1: { email: 'd@x' } }, () => clockNow);
    const r = await ops.inviteDriver({ name: 'Marta', phone: '+504 9', email: 'Marta@Correo.HN', actorUid: 'disp1' }, depsFor(db, auth));
    assert.equal(r.ok, true); assert.match(r.link, /sherpa\.app\/set/);
    const rec = db._get(`driver_accounts/${r.uid}`);
    assert.equal(rec.onboarding_state, 'pending'); assert.equal(rec.enabled, false); assert.equal(rec.email, 'marta@correo.hn');
    assert.equal(rec.name, 'Marta'); assert.equal(rec.invited_by, 'disp1'); assert.equal(rec.version, 0);
    assert.equal(auth._users[r.uid].disabled, false); // converged: pending (not deactivated) ⇒ Auth enabled
  });
  await t('inviteDriver: link is NEVER persisted to the record or the op log', async () => {
    const db = makeDb(seedBase()); const auth = makeAuth({ disp1: { email: 'd@x' } }, () => clockNow);
    const r = await ops.inviteDriver({ name: 'M', phone: 'p', email: 'm@c.hn', actorUid: 'disp1' }, depsFor(db, auth));
    assert.ok(!JSON.stringify(db._root()).includes('SECRET'), 'reset link must not be stored anywhere');
    assert.ok(r.link.includes('SECRET'));
  });
  await t('inviteDriver: duplicate email (non-provisioned) → already-exists, zero new account', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { u9: { enabled: true, onboarding_state: 'active', email: 'taken@c.hn', version: 1 } } }));
    const auth = makeAuth({ disp1: { email: 'd@x' }, u9: { email: 'taken@c.hn', disabled: false } }, () => clockNow);
    const before = Object.keys(db._get('driver_accounts')).length;
    await rejects(ops.inviteDriver({ name: 'X', phone: 'p', email: 'taken@c.hn', actorUid: 'disp1' }, depsFor(db, auth)), 'already-exists');
    assert.equal(Object.keys(db._get('driver_accounts')).length, before);
  });
  await t('inviteDriver: duplicate email mapping to a PENDING provisioned record → re-invites it', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { up: { enabled: false, onboarding_state: 'pending', email: 'p@c.hn', invited_by: 'disp1', version: 0 } } }));
    const auth = makeAuth({ disp1: { email: 'd@x' }, up: { email: 'p@c.hn', disabled: true } }, () => clockNow);
    const r = await ops.inviteDriver({ name: 'X', phone: 'p', email: 'p@c.hn', actorUid: 'disp1' }, depsFor(db, auth));
    assert.equal(r.uid, 'up'); assert.match(r.link, /sherpa/);
  });

  // ---- invite re-invite by uid ----
  await t('inviteDriver re-invite by uid: only pending/profile_submitted; active refused', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { ua: { enabled: true, onboarding_state: 'active', email: 'a@c.hn', invited_by: 'disp1', version: 1 } } }));
    const auth = makeAuth({ disp1: { email: 'd@x' }, ua: { email: 'a@c.hn' } }, () => clockNow);
    await rejects(ops.inviteDriver({ uid: 'ua', actorUid: 'disp1' }, depsFor(db, auth)), 'failed-precondition', /reinvitar/);
  });

  // ---- submit ----
  await t('submitDriverProfile: pending → profile_submitted with escaped-safe profile fields', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { me: { enabled: false, onboarding_state: 'pending', email: 'me@c.hn', invited_by: 'disp1', version: 0 } } }));
    const r = await ops.submitDriverProfile({ uid: 'me', name: 'Gabriel', phone: '+504', vehicle: 'Moto', plate: 'ABC 1234' }, depsFor(db, makeAuth({}, () => clockNow)));
    assert.equal(r.ok, true);
    const rec = db._get('driver_accounts/me');
    assert.equal(rec.onboarding_state, 'profile_submitted'); assert.equal(rec.profile.plate, 'ABC 1234'); assert.equal(typeof rec.profile.submitted_at, 'number');
  });
  await t('submitDriverProfile: not pending → refused', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { me: { enabled: true, onboarding_state: 'active', version: 1 } } }));
    await rejects(ops.submitDriverProfile({ uid: 'me', name: 'G', phone: 'p', vehicle: 'v', plate: 'x' }, depsFor(db, makeAuth({}, () => clockNow))), 'failed-precondition');
  });
  await t('submitDriverProfile: bad field → invalid-argument', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { me: { enabled: false, onboarding_state: 'pending', version: 0 } } }));
    await rejects(ops.submitDriverProfile({ uid: 'me', name: '', phone: 'p', vehicle: 'v', plate: 'x' }, depsFor(db, makeAuth({}, () => clockNow))), 'invalid-argument');
  });

  // ---- approve ----
  await t('approveDriver: profile_submitted → active + enabled, Auth enabled', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { ps: { enabled: false, onboarding_state: 'profile_submitted', email: 'ps@c.hn', invited_by: 'disp1', version: 1 } } }));
    const auth = makeAuth({ ps: { email: 'ps@c.hn', disabled: true } }, () => clockNow);
    await ops.approveDriver({ uid: 'ps', actorUid: 'disp1' }, depsFor(db, auth));
    const rec = db._get('driver_accounts/ps');
    assert.equal(rec.onboarding_state, 'active'); assert.equal(rec.enabled, true); assert.equal(rec.approved_by, 'disp1');
    assert.equal(auth._users.ps.disabled, false);
  });
  await t('approveDriver: not profile_submitted → refused', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { ps: { enabled: false, onboarding_state: 'pending', version: 0 } } }));
    await rejects(ops.approveDriver({ uid: 'ps', actorUid: 'disp1' }, depsFor(db, makeAuth({}, () => clockNow))), 'failed-precondition');
  });

  // ---- suspend ----
  await t('setDriverSuspended: active → enabled:false + suspended_at; Auth unchanged (kept enabled)', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { a: { enabled: true, onboarding_state: 'active', email: 'a@c.hn', approved_at: 1, version: 2 } } }));
    const auth = makeAuth({ a: { email: 'a@c.hn', disabled: false } }, () => clockNow);
    await ops.setDriverSuspended({ uid: 'a', actorUid: 'disp1' }, depsFor(db, auth));
    const rec = db._get('driver_accounts/a');
    assert.equal(rec.enabled, false); assert.equal(typeof rec.suspended_at, 'number'); assert.equal(auth._users.a.disabled, false);
  });
  await t('setDriverSuspended: dual-role (also dispatcher) → refused', async () => {
    const db = makeDb(Object.assign(seedBase(), { dispatchers: { disp1: true, dual: true }, driver_accounts: { dual: { enabled: true, onboarding_state: 'active', version: 1 } } }));
    await rejects(ops.setDriverSuspended({ uid: 'dual', actorUid: 'disp1' }, depsFor(db, makeAuth({}, () => clockNow))), 'failed-precondition', /despacho o cocina/);
  });
  await t('setDriverSuspended: dual-role (kitchen_staff in a restaurant) → refused', async () => {
    const db = makeDb(Object.assign(seedBase(), { restaurants: { r1: { kitchen_staff: { ks: true } } }, driver_accounts: { ks: { enabled: true, onboarding_state: 'active', version: 1 } } }));
    await rejects(ops.setDriverSuspended({ uid: 'ks', actorUid: 'disp1' }, depsFor(db, makeAuth({}, () => clockNow))), 'failed-precondition', /cocina/);
  });

  // ---- deactivate preconditions ----
  const suspendedSeed = () => Object.assign(seedBase(), { driver_accounts: { d: { enabled: false, deactivated: false, onboarding_state: 'active', email: 'd@c.hn', approved_at: 1, suspended_at: 5, version: 3 } } });
  await t('setDriverDeactivated: open shift blocks it', async () => {
    const db = makeDb(Object.assign(suspendedSeed(), { drivers: { d: { active: true } } }));
    await rejects(ops.setDriverDeactivated({ uid: 'd', actorUid: 'disp1', cashAttested: true }, depsFor(db, makeAuth({ d: { email: 'd@c.hn' } }, () => clockNow))), 'failed-precondition', /todavía/);
  });
  await t('setDriverDeactivated: owned nonterminal task (either leg) blocks it', async () => {
    const db = makeDb(Object.assign(suspendedSeed(), { drivers: { d: {} }, tasks: { t1: { assigned_driver_id: 'd', status: 'en_route', order_id: 'o1' } } }));
    await rejects(ops.setDriverDeactivated({ uid: 'd', actorUid: 'disp1', cashAttested: true }, depsFor(db, makeAuth({ d: { email: 'd@c.hn' } }, () => clockNow))), 'failed-precondition', /todavía/);
  });
  await t('setDriverDeactivated: cash not attested blocks it', async () => {
    const db = makeDb(Object.assign(suspendedSeed(), { drivers: { d: {} }, tasks: {} }));
    await rejects(ops.setDriverDeactivated({ uid: 'd', actorUid: 'disp1', cashAttested: false }, depsFor(db, makeAuth({ d: { email: 'd@c.hn' } }, () => clockNow))), 'failed-precondition', /todavía/);
  });
  await t('setDriverDeactivated: not suspended (active) → refused "Primero suspendé"', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { d: { enabled: true, onboarding_state: 'active', email: 'd@c.hn', approved_at: 1, version: 2 } }, drivers: { d: {} }, tasks: {} }));
    await rejects(ops.setDriverDeactivated({ uid: 'd', actorUid: 'disp1', cashAttested: true }, depsFor(db, makeAuth({ d: { email: 'd@c.hn' } }, () => clockNow))), 'failed-precondition', /suspend/);
  });
  await t('setDriverDeactivated: all clear → deactivated:true + revoke_after + Auth disabled + revoked', async () => {
    const db = makeDb(Object.assign(suspendedSeed(), { drivers: { d: {} }, tasks: {} }));
    const auth = makeAuth({ d: { email: 'd@c.hn', disabled: false } }, () => clockNow);
    await ops.setDriverDeactivated({ uid: 'd', actorUid: 'disp1', cashAttested: true }, depsFor(db, auth));
    const rec = db._get('driver_accounts/d');
    assert.equal(rec.deactivated, true); assert.equal(rec.revoke_after, NOW); assert.equal(rec.last_op.cash_confirmed, true);
    assert.equal(auth._users.d.disabled, true); assert.ok(auth._users.d.tokensValidAfterTime, 'revoked');
  });
  await t('setDriverDeactivated: dual-role refused before any read', async () => {
    const db = makeDb(Object.assign(suspendedSeed(), { dispatchers: { disp1: true, d: true } }));
    await rejects(ops.setDriverDeactivated({ uid: 'd', actorUid: 'disp1', cashAttested: true }, depsFor(db, makeAuth({ d: { email: 'd@c.hn' } }, () => clockNow))), 'failed-precondition', /doble rol/);
  });

  // ---- reactivate ----
  await t('reactivate: deactivated → active, Auth enabled, revoke_after PRESERVED', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { d: { enabled: false, deactivated: true, onboarding_state: 'active', email: 'd@c.hn', approved_at: 1, revoke_after: NOW, version: 4 } } }));
    const auth = makeAuth({ d: { email: 'd@c.hn', disabled: true } }, () => clockNow);
    await ops.reactivate({ uid: 'd', actorUid: 'disp1' }, depsFor(db, auth));
    const rec = db._get('driver_accounts/d');
    assert.equal(rec.deactivated, false); assert.equal(rec.enabled, true); assert.equal(rec.revoke_after, NOW, 'revoke_after preserved (monotonic)');
    assert.equal(auth._users.d.disabled, false);
  });
  await t('reactivate: suspended → active (enabled true, suspended_at cleared)', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { d: { enabled: false, deactivated: false, onboarding_state: 'active', email: 'd@c.hn', approved_at: 1, suspended_at: 9, version: 3 } } }));
    const auth = makeAuth({ d: { email: 'd@c.hn', disabled: false } }, () => clockNow);
    await ops.reactivate({ uid: 'd', actorUid: 'disp1' }, depsFor(db, auth));
    const rec = db._get('driver_accounts/d');
    assert.equal(rec.enabled, true); assert.ok(rec.suspended_at == null, 'suspended_at cleared');
  });
  await t('reactivate: pending → refused', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { d: { enabled: false, onboarding_state: 'pending', version: 0 } } }));
    await rejects(ops.reactivate({ uid: 'd', actorUid: 'disp1' }, depsFor(db, makeAuth({}, () => clockNow))), 'failed-precondition');
  });

  // ---- never-delete ----
  await t('never-delete: suspend→deactivate→reactivate leaves the record present throughout', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { d: { enabled: true, onboarding_state: 'active', email: 'd@c.hn', approved_at: 1, version: 1 } }, drivers: { d: {} }, tasks: {} }));
    const auth = makeAuth({ d: { email: 'd@c.hn', disabled: false } }, () => clockNow);
    await ops.setDriverSuspended({ uid: 'd', actorUid: 'disp1' }, depsFor(db, auth)); assert.ok(db._get('driver_accounts/d'));
    await ops.setDriverDeactivated({ uid: 'd', actorUid: 'disp1', cashAttested: true }, depsFor(db, auth)); assert.ok(db._get('driver_accounts/d'));
    await ops.reactivate({ uid: 'd', actorUid: 'disp1' }, depsFor(db, auth)); assert.ok(db._get('driver_accounts/d'));
  });

  // ---- N1: grandfathered lifecycle against the ACTUAL backfill shape (no email/approved_at/version/deactivated) ----
  await t('N1: grandfathered backfill shape → suspend→deactivate→reactivate all succeed; never void; Auth reconciled by uid', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { g: { enabled: true, onboarding_state: 'active', grandfathered: true, updated_at: 1 } }, drivers: { g: {} }, tasks: {} }));
    const auth = makeAuth({ g: { email: 'legacy@c.hn', disabled: false } }, () => clockNow); // real Auth user, record has NO email
    await ops.setDriverSuspended({ uid: 'g', actorUid: 'disp1' }, depsFor(db, auth));
    assert.notEqual(db._get('driver_accounts/g').onboarding_state, 'void');
    assert.equal(db._get('driver_accounts/g').version, 1); // absent version initialized 0→1
    await ops.setDriverDeactivated({ uid: 'g', actorUid: 'disp1', cashAttested: true }, depsFor(db, auth));
    assert.notEqual(db._get('driver_accounts/g').onboarding_state, 'void');
    assert.equal(auth._users.g.disabled, true);
    await ops.reactivate({ uid: 'g', actorUid: 'disp1' }, depsFor(db, auth));
    assert.notEqual(db._get('driver_accounts/g').onboarding_state, 'void');
    assert.equal(auth._users.g.disabled, false);
  });

  // ---- syncAuthToAccount identity/collision (finding 7, r5) ----
  await t('sync: grandfathered (no email) with MISSING Auth user → no-op, never void, never createUser', async () => {
    const db = makeDb({ driver_accounts: { g: { enabled: true, onboarding_state: 'active', grandfathered: true, version: 1 } } });
    const auth = makeAuth({}, () => clockNow);
    await ops.syncAuthToAccount('g', depsFor(db, auth));
    assert.notEqual(db._get('driver_accounts/g').onboarding_state, 'void');
    assert.ok(!auth._users.g, 'never provisioned');
  });
  await t('sync: provisioned, existing Auth user with DIFFERENT email → void (before any enable)', async () => {
    const db = makeDb({ driver_accounts: { p: { enabled: true, onboarding_state: 'active', email: 'want@c.hn', version: 2 } } });
    const auth = makeAuth({ p: { email: 'other@c.hn', disabled: true } }, () => clockNow);
    await ops.syncAuthToAccount('p', depsFor(db, auth));
    assert.equal(db._get('driver_accounts/p').onboarding_state, 'void');
    assert.equal(auth._users.p.disabled, true, 'never enabled a mismatched identity');
  });
  await t('sync: provisioned, missing Auth user → createUser at same uid+email (resume)', async () => {
    const db = makeDb({ driver_accounts: { p: { enabled: false, onboarding_state: 'pending', email: 'p@c.hn', version: 0 } } });
    const auth = makeAuth({}, () => clockNow);
    await ops.syncAuthToAccount('p', depsFor(db, auth));
    assert.ok(auth._users.p, 'resumed provisioning'); assert.equal(auth._users.p.email, 'p@c.hn');
  });
  await t('sync: email taken by ANOTHER uid, our uid absent → void (createUser collision, re-read still missing)', async () => {
    const db = makeDb({ driver_accounts: { p: { enabled: false, onboarding_state: 'pending', email: 'dup@c.hn', version: 0 } } });
    const auth = makeAuth({ other: { email: 'dup@c.hn', disabled: false } }, () => clockNow);
    await ops.syncAuthToAccount('p', depsFor(db, auth));
    assert.equal(db._get('driver_accounts/p').onboarding_state, 'void');
  });
  await t('sync: concurrent creator produced SAME uid+email → recovery (converge, not void)', async () => {
    const db = makeDb({ driver_accounts: { p: { enabled: false, onboarding_state: 'pending', email: 'p@c.hn', version: 0 } } });
    const auth = makeAuth({ p: { email: 'p@c.hn', disabled: true } }, () => clockNow);
    await ops.syncAuthToAccount('p', depsFor(db, auth));
    assert.notEqual(db._get('driver_accounts/p').onboarding_state, 'void');
    assert.equal(auth._users.p.disabled, false); // pending (not deactivated) ⇒ enabled
  });

  // ---- N2: revocation survives reactivation (record-driven) ----
  await t('N2: deactivate→(crash: no sync)→reactivate→sweep → revoke_after persists and session is revoked', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { d: { enabled: false, deactivated: false, onboarding_state: 'active', email: 'd@c.hn', approved_at: 1, suspended_at: 1, version: 2 } }, drivers: { d: {} }, tasks: {} }));
    const auth = makeAuth({ d: { email: 'd@c.hn', disabled: false, tokensValidAfterTime: undefined } }, () => clockNow);
    // deactivate commits the record; simulate crash BEFORE sync by not letting sync run (stub it out via direct casTransition)
    await ops.casTransition('d', depsFor(db, auth), (r) => ({ deactivated: true, revoke_after: NOW, last_op: ops.lastOp('deactivate', 'disp1', NOW, { cash_confirmed: true }) }));
    // reactivate (dispatcher) — clears deactivated, must NOT clear revoke_after
    await ops.reactivate({ uid: 'd', actorUid: 'disp1' }, depsFor(db, auth));
    assert.equal(db._get('driver_accounts/d').revoke_after, NOW, 'revoke_after survived reactivation');
    // now the sweep runs → revokes the old session (tokensValidAfterTime < revoke_after)
    await ops.sweepAuthSync({ db, auth, now: clockNow });
    assert.ok(auth._users.d.tokensValidAfterTime, 'old session revoked by sweep via revoke_after');
  });

  // ---- N3: sweep covers all accounts, converges after delay ----
  await t('N3: sweep converges a reactivated account whose Auth-enable failed earlier (no time window)', async () => {
    const db = makeDb({ driver_accounts: { d: { enabled: true, deactivated: false, onboarding_state: 'active', email: 'd@c.hn', approved_at: 1, version: 5, updated_at: 1 } } });
    const auth = makeAuth({ d: { email: 'd@c.hn', disabled: true } }, () => clockNow); // Auth still disabled from before
    const out = await ops.sweepAuthSync({ db, auth, now: clockNow });
    assert.equal(out.total, 1); assert.equal(auth._users.d.disabled, false, 'converged to enabled');
  });
  await t('N3: sweep skips void records quietly and continues past a throwing account', async () => {
    const db = makeDb({ driver_accounts: { v: { onboarding_state: 'void', version: 1 }, ok: { enabled: true, onboarding_state: 'active', email: 'ok@c.hn', version: 1 } } });
    const auth = makeAuth({ ok: { email: 'ok@c.hn', disabled: true } }, () => clockNow);
    const out = await ops.sweepAuthSync({ db, auth, now: clockNow });
    assert.equal(out.synced, 2); assert.equal(auth._users.ok.disabled, false);
  });

  // ---- version CAS: every transition bumps version (anchors the version-bump mutant) ----
  await t('version: a transition increments version by exactly 1', async () => {
    const db = makeDb(Object.assign(seedBase(), { driver_accounts: { ps: { enabled: false, onboarding_state: 'profile_submitted', email: 'ps@c.hn', invited_by: 'disp1', version: 5 } } }));
    await ops.approveDriver({ uid: 'ps', actorUid: 'disp1' }, depsFor(db, makeAuth({ ps: { email: 'ps@c.hn', disabled: true } }, () => clockNow)));
    assert.equal(db._get('driver_accounts/ps').version, 6, 'version bumped 5→6');
  });

  // ---- sync skips a VOID record even when provisioned (anchors the void-skip mutant) ----
  await t('sync: a VOID record (even with email + disabled Auth user) is skipped — never enabled', async () => {
    const db = makeDb({ driver_accounts: { v: { onboarding_state: 'void', email: 'v@c.hn', deactivated: false, version: 1 } } });
    const auth = makeAuth({ v: { email: 'v@c.hn', disabled: true } }, () => clockNow);
    await ops.syncAuthToAccount('v', depsFor(db, auth));
    assert.equal(auth._users.v.disabled, true, 'void account must NOT be enabled by the reconciler');
  });

  console.log(`\ndriver-admin-ops: ${passed} tests passed`);
})().catch((e) => { console.error('driver-admin-ops FAILED:', e && e.stack || e); process.exit(1); });
