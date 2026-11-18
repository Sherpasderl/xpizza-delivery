'use strict';
// SECURITY BACKLOG (advisor 2026-11-01, design approved) — account deletion, ONE tombstone source of truth + session revocation:
//   (ii) `deleted_uids/{uid}` is THE tombstone every server check reads (customerOf, createOrder / charge attribution, claim-order,
//        rewards earn / reserve, the guest gate) — so BOTH deletion paths write it: user-initiated deleteAccount (as before) AND
//        the inactivity sweep (NEW); the sweep's residual step backfills it for accounts tombstoned in user_private before the fix.
//   (i)  deleteAccountCore revokes the account's refresh tokens — best-effort, deadline-bounded, FAIL-OPEN: the deletion always
//        completes; a failure or timeout is logged AND alerted (dispatcher_alerts/account_revoke_failed_{uid}), never dropped.
// The REAL deletion core (signup-endpoints.deleteAccountCore / pruneResidual, signup-core, account-lib) over an in-memory RTDB
// whose transaction + multi-path update + query semantics match production. Run: node deletion-tombstone.test.js
const assert = require('assert');
const SE = require('./signup-endpoints');
const ACCOUNT = require('./account-lib');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// a hanging await empties the event loop and Node exits rc 0 WITHOUT finishing — that is a FAILURE, never a silent pass
let FINISHED = false;
// failure output goes through process.stderr.write: a cell's quietly() may still hold console.error redirected when a `within` deadline
// rejects (the hung promise never reaches its finally), which swallowed the 🔴 message (train-gate sweep, sec-20 ERRORED)
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 deletion-tombstone: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const within = (p, ms, label) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: not done within ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeDb() {
  const tree = {};
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  // as RTDB: a removal that empties a parent removes the parent too (no empty nodes exist)
  const prune = (ks) => { for (let i = ks.length - 1; i > 0; i--) { const par = ks.slice(0, i).reduce((o, k) => (o == null ? undefined : o[k]), tree); if (par && typeof par === 'object' && !Object.keys(par).length) { const gp = ks.slice(0, i - 1).reduce((o, k) => o[k], tree); delete gp[ks[i - 1]]; } else break; } };
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) { delete o[ks[ks.length - 1]]; prune(ks); } else o[ks[ks.length - 1]] = clone(v); };
  const snap = (v) => { const c = clone(v); return { exists: () => c != null, val: () => (c == null ? null : clone(c)) }; };
  const query = (p, child) => {
    const filt = { eq: undefined, start: undefined, end: undefined, limit: undefined };
    const q = {
      equalTo: (v) => { filt.eq = v; return q; }, startAt: (v) => { filt.start = v; return q; }, endAt: (v) => { filt.end = v; return q; }, limitToFirst: (k) => { filt.limit = k; return q; },
      once: async () => {
        const all = get(p) || {}; const out = {}; let k = 0;
        for (const [id, row] of Object.entries(all)) {
          const v = row && row[child];
          if (filt.eq !== undefined && v !== filt.eq) continue;
          if (filt.start !== undefined && !(v != null && v >= filt.start)) continue;
          if (filt.end !== undefined && !(v != null && v <= filt.end)) continue;
          if (filt.limit !== undefined && k >= filt.limit) break;
          out[id] = row; k += 1;
        }
        return snap(Object.keys(out).length ? out : null);
      },
    };
    return q;
  };
  const FAIL = { update: false, txnAt: null };   // inject: the next multi-path update throws (nothing applied) / a txn on a path prefix throws
  const HOOK = { after: null, fn: null };        // run fn ONCE right after the next txn on a path prefix (an interleaving)
  const TOUCH = { at: null, fn: null };          // run fn ONCE right after the next read OR txn of EXACTLY this path (the gap after a snapshot)
  const touched = async (p) => { if (TOUCH.at !== null && String(p) === TOUCH.at) { const f = TOUCH.fn; TOUCH.at = null; TOUCH.fn = null; await f(); } };
  const ref = (p = '') => ({
    get: async () => { const s = snap(get(p)); await touched(p); return s; }, once: async () => { const s = snap(get(p)); await touched(p); return s; },
    set: async (v) => set(p, v), remove: async () => set(p, null),
    update: async (m) => { if (FAIL.update) { FAIL.update = false; throw new Error('injected update failure'); } for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v); },
    orderByChild: (c) => query(p, c),
    transaction: async (fn) => {
      if (FAIL.txnAt && String(p).startsWith(FAIL.txnAt)) { FAIL.txnAt = null; throw new Error('injected transaction failure'); }
      const next = fn(clone(get(p)) ?? null);
      const out = next === undefined ? { committed: false, snapshot: snap(get(p)) } : (set(p, next), { committed: true, snapshot: snap(get(p)) });
      if (HOOK.after && String(p).startsWith(HOOK.after)) { const f = HOOK.fn; HOOK.after = null; HOOK.fn = null; await f(); }
      await touched(p);
      return out;
    },
  });
  return { tree, get, set, ref, FAIL, HOOK, TOUCH };
}
const UID = 'u_' + 'a'.repeat(24), PH = 'ph_a';
const seedAccount = (db, { lastActive = 5 } = {}) => {
  db.set(`user_profiles/${UID}`, { phone: '50499990000', phone_hash: PH, created_at: 1, last_login: 1 });
  db.set(`user_orders/${UID}`, { o1: true }); db.set(`user_rewards/${UID}`, { x_pizza: { balance: 10 } });
  db.set(`phone_index/${PH}`, UID);
  db.set(`user_private/${UID}`, { email: 'a@x.hn', last_active: lastActive });
  db.set('auth_links/google/g1', { uid: UID, at: 1 });
  db.set('reward_welcome/ph_a_x_pizza', { at: 1 });
  db.set(`user_favorites/${UID}`, { x_pizza: { createdAt: 1 }, la_musa: { createdAt: 2 } });   // S-C
};
const recorder = () => { const calls = []; const fn = async (uid) => { calls.push(uid); }; fn.calls = calls; return fn; };
const quietly = async (f) => { const e = console.error, w = console.warn; const logs = []; console.error = (...a) => logs.push(a.join(' ')); console.warn = console.error; try { return { r: await f(), logs }; } finally { console.error = e; console.warn = w; } };

(async () => {
  // ── 1. user-initiated deletion (the forms differential): the SAME removals + deleted_uids as before, + one revoke ──
  {
    const db = fakeDb(); seedAccount(db);
    const revoke = recorder();
    assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 100, revoke }), true);
    assert.deepStrictEqual(db.get(`user_private/${UID}`), { deleted_at: 100 }, 'the BC2 tombstone');
    assert.strictEqual(db.get(`deleted_uids/${UID}`), 100, 'deleted_uids (as today)');
    for (const p of [`user_profiles/${UID}`, `user_orders/${UID}`, `user_rewards/${UID}`, `phone_index/${PH}`, 'auth_links/google/g1']) assert.strictEqual(db.get(p), undefined, `🔴 ${p} removed`);
    assert.deepStrictEqual(db.get(`user_favorites/${UID}`), { _deleted: 100 }, '🔴 every favorite removed — the node is EXACTLY the deletion fence (PLAN-3a-capp-member-reads R3.1)');   // S-C: favorites purged by the REAL deleteAccountCore
    assert.ok(db.get('reward_welcome/ph_a_x_pizza'), 'reward_welcome survives (as today)');
    assert.deepStrictEqual(revoke.calls, [UID], 'the refresh tokens revoked ONCE, for THIS uid');
  }
  ok('user-initiated deletion: today\'s removals + deleted_uids unchanged (forms differential); the refresh tokens revoked once');

  // ── 2. the inactivity sweep now writes THE tombstone too (was: user_private only ⇒ deleted_uids-only checks missed it) ──
  {
    const db = fakeDb(); seedAccount(db, { lastActive: 5 });
    const revoke = recorder();
    assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 200, sweepCutoff: 50, revoke }), true);
    assert.deepStrictEqual(db.get(`user_private/${UID}`), { deleted_at: 200 });
    assert.strictEqual(db.get(`deleted_uids/${UID}`), 200, '🔴 the sweep writes deleted_uids — the one tombstone every server check reads');
    assert.strictEqual(db.get(`user_profiles/${UID}`), undefined);
    assert.deepStrictEqual(revoke.calls, [UID], 'a swept account\'s dormant sessions are revoked too');
  }
  ok('inactivity sweep: deleted_uids written (the one source of truth) + the BC2 tombstone + removals; sessions revoked');

  // ── 3. a sweep that loses to a fresher login: nothing written, nothing revoked ──
  {
    const db = fakeDb(); seedAccount(db, { lastActive: 90 });
    const before = JSON.stringify(db.tree);
    const revoke = recorder();
    assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 200, sweepCutoff: 50, revoke }), false);
    assert.strictEqual(JSON.stringify(db.tree), before, 'no tombstone, no removal, no deleted_uids');
    assert.deepStrictEqual(revoke.calls, [], 'a live account is never revoked');
  }
  ok('a sweep aborted by a fresher login writes nothing and revokes nothing');

  // ── 4. FAIL-OPEN, never silent: a throwing / hanging revoke — the deletion completes; logged AND alerted ──
  for (const [label, revoke] of [['throws', async () => { throw new Error('auth/internal-error'); }], ['hangs', () => new Promise(() => {})]]) {
    const db = fakeDb(); seedAccount(db);
    const t0 = Date.now();
    const { r, logs } = await quietly(() => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 300, revoke, revokeDeadlineMs: 50 }));
    assert.strictEqual(r, true, `${label}: the deletion still reports done`);
    assert.ok(Date.now() - t0 < 2000, `${label}: bounded by the deadline`);
    assert.strictEqual(db.get(`deleted_uids/${UID}`), 300, `${label}: the tombstone stands`);
    assert.strictEqual(db.get(`user_profiles/${UID}`), undefined, `${label}: removals done`);
    assert.ok(logs.some((l) => /revoke/i.test(l) && l.includes(UID)), `🔴 ${label}: the failure is LOGGED with the uid`);
    const a = db.get(`dispatcher_alerts/account_revoke_failed_${UID}`);
    assert.ok(a && a.type === 'account_revoke_failed' && a.uid === UID && a.created_at === 300, `🔴 ${label}: the failure is ALERTED (${JSON.stringify(a)})`);
    assert.strictEqual(a.reason, label === 'hangs' ? 'timeout' : 'revoke_failed', `${label}: an ALLOWLISTED reason code`);
  }
  {
    // the alert is create-only (a retry never rewrites the first alert); a SUCCESSFUL revoke writes no alert
    const db = fakeDb(); seedAccount(db);
    db.set(`dispatcher_alerts/account_revoke_failed_${UID}`, { type: 'account_revoke_failed', uid: UID, reason: 'first', created_at: 1 });
    await quietly(() => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 400, revoke: async () => { throw new Error('again'); }, revokeDeadlineMs: 50 }));
    assert.strictEqual(db.get(`dispatcher_alerts/account_revoke_failed_${UID}`).reason, 'first', 'create-only');
    const db2 = fakeDb(); seedAccount(db2);
    await SE.deleteAccountCore(db2, ACCOUNT, { uid: UID, phoneHash: PH, now: 400, revoke: recorder() });
    assert.strictEqual(db2.get('dispatcher_alerts'), undefined, 'no alert on success');
  }
  ok('fail-open, never silent: a throwing or hanging revoke (deadline-bounded) still completes the deletion; logged with the uid AND a create-only dispatcher alert; success ⇒ no alert');

  // ── 5. the backfill: accounts tombstoned in user_private BEFORE this fix get deleted_uids on the next sweep residual ──
  {
    const db = fakeDb();
    const A = 'u_' + 'b'.repeat(24), B = 'u_' + 'c'.repeat(24), C = 'u_' + 'd'.repeat(24);
    db.set(`user_private/${A}`, { deleted_at: 7 });                       // legacy sweep tombstone, no deleted_uids
    db.set(`user_private/${B}`, { deleted_at: 8 }); db.set(`deleted_uids/${B}`, 3);   // already there: never rewritten
    db.set(`user_private/${C}`, { email: 'c@x.hn', last_active: 9 });    // a LIVE account: untouched
    const R = 'u_' + 'f'.repeat(24);
    db.set(`user_private/${R}`, { deleted_at: 7 }); db.set(`user_profiles/${R}`, { phone: '5049', phone_hash: 'ph_r', created_at: 1, last_login: 900 });   // REVIVED (Codex P1-a repro)
    const r = await SE.pruneResidual(db, 1000);
    assert.strictEqual(db.get(`deleted_uids/${A}`), 7, '🔴 backfilled with ITS deleted_at');
    assert.strictEqual(db.get(`deleted_uids/${B}`), 3, 'an existing tombstone is never rewritten');
    assert.strictEqual(db.get(`deleted_uids/${C}`), undefined, 'a live account never gets a tombstone');
    assert.strictEqual(db.get(`deleted_uids/${R}`), undefined, '🔴 Codex P1-a: a REVIVED account (profile present, activity after deleted_at) is never backfilled');
    assert.strictEqual(r.tombstones, 1, 'the residual reports how many it backfilled');
    assert.strictEqual((await SE.pruneResidual(db, 1001)).tombstones, 0, 'idempotent');
  }
  ok('residual backfill: a user_private tombstone without deleted_uids gets one (its own deleted_at); existing kept; live untouched; idempotent');

  const S = require('./signup-core');
  const newUids = (...ids) => { const q = [...ids]; return () => q.shift(); };
  const F1 = 'u_' + '1'.repeat(24), F2 = 'u_' + '2'.repeat(24);

  // ── 6. Codex P1-c: BOTH tombstones + every removal in ONE atomic write — a failure leaves NOTHING half-done ──
  {
    const db = fakeDb(); seedAccount(db);
    const before = JSON.stringify(db.tree);
    db.FAIL.update = true;
    await assert.rejects(() => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 500, revoke: recorder() }), /injected update failure/);
    assert.strictEqual(JSON.stringify(db.tree), before, '🔴 a failed deletion leaves NO tombstone and NO removal (never user_private.deleted_at without deleted_uids)');
    assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 501, revoke: recorder() }), true, 'a retry completes');
    assert.deepStrictEqual([db.get(`user_private/${UID}`), db.get(`deleted_uids/${UID}`)], [{ deleted_at: 501 }, 501], 'both tombstones, same instant');
    // a retry after BOTH committed keeps the FIRST deletion instant
    db.set(`user_profiles/${UID}`, { phone: '5049', phone_hash: PH, created_at: 1, last_login: 1 });
    await SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 777, revoke: recorder() });
    assert.deepStrictEqual([db.get(`user_private/${UID}`), db.get(`deleted_uids/${UID}`)], [{ deleted_at: 501 }, 501], 'an existing deletion instant is kept');
  }
  ok('Codex P1-c: both tombstones and the removals are ONE multi-path write — an injected failure leaves the account untouched; a retry completes; the first deletion instant is kept');

  // ── 7. Codex P1-b: the sweep vs a fresh login linearize on user_profiles/{uid} (the login gate vs the sweep claim) ──
  {
    // (a) Codex's repro: the login lands AFTER the sweep selected the account, its last_active refresh FAILED — the gate's
    //     last_login is what the claim reads, so the sweep aborts: nothing deleted, nothing revoked
    const db = fakeDb(); seedAccount(db, { lastActive: 5 });
    const revoke = recorder();
    assert.strictEqual(await S.loginTouch(db, UID, 900), 'live', 'the gate: a live profile → last_login bumped');
    assert.strictEqual(db.get(`user_profiles/${UID}/last_login`), 900);
    assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 901, sweepCutoff: 50, revoke }), false, '🔴 Codex P1-b: a fresh login (gate) makes the sweep abort');
    assert.ok(db.get(`user_profiles/${UID}`) && !db.get(`deleted_uids/${UID}`) && !(db.get(`user_private/${UID}`) || {}).deleted_at, 'nothing deleted');
    assert.deepStrictEqual(revoke.calls, [], 'nothing revoked');
    // (b) the claim commits FIRST → the login sees the claim → this uid is dead for logins → a FRESH uid, phone_index repointed
    const db2 = fakeDb(); seedAccount(db2, { lastActive: 5 });
    assert.strictEqual(await S.sweepClaim(db2, UID, 50, 600), 'claimed');
    assert.strictEqual(db2.get(`user_profiles/${UID}/deleting_at`), 600);
    assert.strictEqual(await S.loginTouch(db2, UID, 601), 'claimed', 'the gate refuses a claimed profile');
    assert.strictEqual(await SE.loginUid(db2, { pHash: PH, uid: UID, now: 601, newUid: newUids(F1) }), F1, 'a claimed uid is never handed to a login');
    assert.strictEqual(db2.get(`phone_index/${PH}`), F1, 'phone_index CAS-repointed to the fresh uid');
    assert.strictEqual(await SE.deleteAccountCore(db2, ACCOUNT, { uid: UID, phoneHash: PH, now: 602, sweepCutoff: 50, revoke: recorder() }), true, 'the claimed sweep completes');
    assert.strictEqual(db2.get(`phone_index/${PH}`), F1, '🔴 the deletion never removes the REPOINTED phone_index (it only removes an entry still naming the deleted uid)');
    // (c) a claim that crashed before its write resumes on the next run
    const db3 = fakeDb(); seedAccount(db3); db3.set(`user_profiles/${UID}/deleting_at`, 10);
    assert.strictEqual(await SE.deleteAccountCore(db3, ACCOUNT, { uid: UID, phoneHash: PH, now: 700, sweepCutoff: 50, revoke: recorder() }), true, 'resumes a claimed profile');
    assert.strictEqual(db3.get(`deleted_uids/${UID}`), 700);
    // (d) a fresh last_login (not last_active) also stops the claim; a google-era last_active still pre-filters
    const db4 = fakeDb(); seedAccount(db4, { lastActive: 5 }); db4.set(`user_profiles/${UID}/last_login`, 60);
    assert.strictEqual(await S.sweepClaim(db4, UID, 50, 61), 'fresh');
    const db5 = fakeDb(); seedAccount(db5, { lastActive: 90 });
    assert.strictEqual(await SE.deleteAccountCore(db5, ACCOUNT, { uid: UID, phoneHash: PH, now: 91, sweepCutoff: 50, revoke: recorder() }), false, 'a recent last_active still spares the account');
    assert.strictEqual(db5.get(`user_profiles/${UID}/deleting_at`), undefined, 'and claims nothing');
    // (e) the gate is FAIL-CLOSED: an infra failure on its transaction propagates (the handler answers its generic retryable error; no mint)
    const db6 = fakeDb(); seedAccount(db6);
    db6.FAIL.txnAt = `user_profiles/${UID}`;
    await assert.rejects(() => SE.loginUid(db6, { pHash: PH, uid: UID, now: 1, newUid: newUids(F1) }), /injected transaction failure/);
  }
  ok('Codex P1-b: login gate + sweep claim on user_profiles/{uid}: a login after selection (failed last_active) aborts the sweep, nothing revoked; a committed claim sends the login to a fresh uid (CAS-repointed index, never removed by the deletion); a crashed claim resumes; the gate fails closed');

  // ── 8. Codex P1-a: a tombstoned uid with NO profile is never revived — a fresh uid; a REVIVED account keeps its uid + orders ──
  {
    for (const [label, tomb] of [['deleted_uids', (db) => db.set(`deleted_uids/${UID}`, 7)], ['user_private.deleted_at', (db) => db.set(`user_private/${UID}`, { deleted_at: 7 })]]) {
      const db = fakeDb(); tomb(db); db.set(`phone_index/${PH}`, UID);   // the legacy RETAINED phone_index (profile without phone_hash)
      assert.strictEqual(await SE.loginUid(db, { pHash: PH, uid: UID, now: 900, newUid: newUids(F1) }), F1, `🔴 ${label} + no profile ⇒ a FRESH uid (Codex P1-a repro: never the tombstoned uid)`);
      assert.strictEqual(db.get(`phone_index/${PH}`), F1);
    }
    // two concurrent logins converge on ONE fresh uid (the CAS repoint)
    {
      const db = fakeDb(); db.set(`deleted_uids/${UID}`, 7); db.set(`phone_index/${PH}`, UID);
      const [a, b] = await Promise.all([SE.loginUid(db, { pHash: PH, uid: UID, now: 1, newUid: newUids(F1) }), SE.loginUid(db, { pHash: PH, uid: UID, now: 1, newUid: newUids(F2) })]);
      assert.strictEqual(a, b, 'both logins land on the same fresh uid'); assert.strictEqual(db.get(`phone_index/${PH}`), a);
    }
    // a REVIVED account (profile present, no claim, activity after deleted_at) is LIVE: it keeps its uid and its orders
    {
      const db = fakeDb();
      db.set(`user_private/${UID}`, { deleted_at: 7 }); db.set(`deleted_uids/${UID}`, 7);
      db.set(`user_profiles/${UID}`, { phone: '5049', phone_hash: PH, created_at: 1, last_login: 900 }); db.set(`user_orders/${UID}`, { o_after: true });
      db.set(`phone_index/${PH}`, UID);
      assert.strictEqual(await SE.loginUid(db, { pHash: PH, uid: UID, now: 950, newUid: newUids(F1) }), UID, '🔴 ruling 2: a revived account KEEPS its uid');
      assert.deepStrictEqual([db.get(`phone_index/${PH}`), db.get(`user_orders/${UID}`)], [UID, { o_after: true }], 'and its post-revival orders');
      assert.strictEqual(db.get(`user_profiles/${UID}/last_login`), 950, 'the gate bumped last_login');
    }
    // an untombstoned uid with no profile (the brand-new uid L1 just set) is used as is — the caller creates the profile
    const db = fakeDb(); db.set(`phone_index/${PH}`, F2);
    assert.strictEqual(await SE.loginUid(db, { pHash: PH, uid: F2, now: 1, newUid: newUids(F1) }), F2);
  }
  ok('Codex P1-a: a tombstoned uid (either kind) with no profile ⇒ a fresh uid (concurrent logins converge); a REVIVED account keeps its uid + post-revival orders; a brand-new uid passes through');

  // ── 9. P2: the alert write is deadline-bounded; the persisted reason never carries e.message ──
  {
    const db = fakeDb(); seedAccount(db);
    const realRef = db.ref; db.ref = (p) => (String(p).startsWith('dispatcher_alerts/') ? { transaction: () => new Promise(() => {}) } : realRef(p));
    const t0 = Date.now();
    const { r, logs } = await within(quietly(() => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 800, revoke: async () => { throw new Error('x'); }, revokeDeadlineMs: 50 })), 3000, '🔴 a hanging alert write blocked the deletion');
    assert.strictEqual(r, true, '🔴 a HANGING alert write never blocks the deletion'); assert.ok(Date.now() - t0 < 2000, 'bounded');
    assert.ok(logs.some((l) => /alert/i.test(l) && /timeout/i.test(l) && l.includes(UID)), 'the alert timeout is logged');
    const db2 = fakeDb(); seedAccount(db2);
    const err = Object.assign(new Error('user ana.perez@gmail.com not found'), { code: 'auth/some-unlisted-code' });
    const q = await quietly(() => SE.deleteAccountCore(db2, ACCOUNT, { uid: UID, phoneHash: PH, now: 801, revoke: async () => { throw err; }, revokeDeadlineMs: 50 }));
    const a = db2.get(`dispatcher_alerts/account_revoke_failed_${UID}`);
    assert.strictEqual(a.reason, 'revoke_failed', '🔴 an unlisted code ⇒ the generic reason');
    assert.ok(!JSON.stringify(a).includes('@') && !q.logs.some((l) => l.includes('@')), '🔴 never the e.message (PII) — not in the alert, not in the log');
    const db3 = fakeDb(); seedAccount(db3);
    await quietly(() => SE.deleteAccountCore(db3, ACCOUNT, { uid: UID, phoneHash: PH, now: 802, revoke: async () => { throw Object.assign(new Error('gone'), { code: 'auth/user-not-found' }); }, revokeDeadlineMs: 50 }));
    assert.strictEqual(db3.get(`dispatcher_alerts/account_revoke_failed_${UID}`).reason, 'auth/user-not-found', 'an ALLOWLISTED auth code is kept');
  }
  ok('P2: a hanging alert write is deadline-bounded (logged, success returned); the persisted / logged reason is an allowlisted code — never e.message');

  // ── 10. the one-time owner migration: clear the STALE tombstones of revived accounts (dry run by default) ──
  {
    const M = require('./tools/repair-revived-tombstones');
    const db = fakeDb();
    const Rv = 'u_' + '3'.repeat(24), Dd = 'u_' + '4'.repeat(24), Cl = 'u_' + '5'.repeat(24), Od = 'u_' + '6'.repeat(24);
    db.set(`user_private/${Rv}`, { deleted_at: 7 }); db.set(`deleted_uids/${Rv}`, 7); db.set(`user_profiles/${Rv}`, { phone: '1', phone_hash: 'a', created_at: 1, last_login: 900 });   // revived
    db.set(`user_private/${Dd}`, { deleted_at: 8 }); db.set(`deleted_uids/${Dd}`, 8);                                                                                  // truly deleted
    db.set(`user_private/${Cl}`, { deleted_at: 9 }); db.set(`user_profiles/${Cl}`, { phone: '2', phone_hash: 'b', created_at: 1, last_login: 900, deleting_at: 950 });    // claimed by a sweep
    db.set(`user_private/${Od}`, { deleted_at: 50 }); db.set(`user_profiles/${Od}`, { phone: '3', phone_hash: 'c', created_at: 1, last_login: 10 });                  // no activity after deleted_at
    const before = JSON.stringify(db.tree);
    let r = await M.repair({ rtdb: db });
    assert.ok(r.dryRun); assert.deepStrictEqual(r.uids, [Rv], 'ONLY the revived account (profile present, no claim, last_login > deleted_at)');
    assert.deepStrictEqual(r.withDeletedUids, [Rv], 'the dry run LISTS revived accounts that still carry deleted_uids (the owner handles them manually)');
    assert.strictEqual(JSON.stringify(db.tree), before, 'DRY RUN writes nothing');
    r = await M.repair({ rtdb: db, apply: true });
    assert.deepStrictEqual([r.cleared, db.get(`user_private/${Rv}`)], [1, undefined], '--apply clears the STALE user_private.deleted_at');
    assert.strictEqual(db.get(`deleted_uids/${Rv}`), 7, '🔴 Codex r2 P1 (ruling): deleted_uids is NEVER cleared by the migration — the untouched source of truth');
    assert.deepStrictEqual([db.get(`deleted_uids/${Dd}`), db.get(`user_private/${Cl}/deleted_at`), db.get(`user_private/${Od}/deleted_at`)], [8, 9, 50], 'deleted / claimed / no-later-activity untouched');
    assert.deepStrictEqual((await M.repair({ rtdb: db })).uids, [], 'idempotent');
  }
  {
    // Codex r2 P1: repair READS → a sweep RE-DELETES the account → repair APPLIES — the authoritative tombstone survives, the uid is
    // never reusable (worst case: the sweep lands after the apply-time profile re-check, right before the user_private txn)
    const M = require('./tools/repair-revived-tombstones');
    const db = fakeDb(); const Rv = 'u_' + '7'.repeat(24), PHr = 'ph_rv';
    db.set(`user_private/${Rv}`, { deleted_at: 7 }); db.set(`deleted_uids/${Rv}`, 7);
    db.set(`user_profiles/${Rv}`, { phone: '1', phone_hash: PHr, created_at: 1, last_login: 900 }); db.set(`phone_index/${PHr}`, Rv);
    const real = db.ref; let fired = false;
    db.ref = (p) => { const r = real(p); if (p === `user_private/${Rv}` && !fired) { const t = r.transaction; r.transaction = async (fn) => { fired = true; await SE.deleteAccountCore(db, ACCOUNT, { uid: Rv, phoneHash: PHr, now: 5000, sweepCutoff: 1000, revoke: recorder() }); return t(fn); }; } return r; };
    const r = await M.repair({ rtdb: db, apply: true });
    db.ref = real;
    assert.ok(fired, 'premise: the sweep re-deleted between the re-check and the apply');
    assert.strictEqual(db.get(`deleted_uids/${Rv}`), 7, '🔴 the AUTHORITATIVE tombstone survives the race');
    assert.strictEqual(db.get(`user_profiles/${Rv}`), undefined, 'the sweep removed the profile');
    assert.notStrictEqual(await SE.loginUid(db, { pHash: PHr, uid: Rv, now: 6000, newUid: newUids(F1) }), Rv, '🔴 the uid is NOT reusable: a login lands on a fresh uid');
    void r;
  }
  ok('migration repair-revived-tombstones: dry run (default) lists ONLY revived accounts (+ separately those still carrying deleted_uids) and writes nothing; --apply clears ONLY the stale user_private.deleted_at (deleted_uids never); a sweep re-deleting mid-repair keeps the authoritative tombstone and the uid unreusable; deleted / claimed / inactive accounts untouched; idempotent');

  // ── 11. L3 (Google, linked): the gate bumps the authoritative last_login; a CLAIMED profile is refused ──
  {
    const RID = 'x_pizza', SID = 's'.repeat(24);
    const google = async (db) => {
      const st = await S.startGoogle(db, { rid: RID, sessionId: SID, now: 1000 });
      return S.googleSignIn(db, { idToken: 'x', sessionId: SID, rid: RID, now: 1001, verify: async () => ({ ok: true, sub: 'g1', nonce: st.nonce, email: 'a@x.hn', name: 'Ana' }) });
    };
    const db = fakeDb(); seedAccount(db);
    const r = await google(db);
    assert.deepStrictEqual([r.ok, r.linked, r.uid], [true, true, UID]);
    assert.strictEqual(db.get(`user_profiles/${UID}/last_login`), 1001, 'the gate wrote the AUTHORITATIVE last_login (the sweep reads it)');
    const db2 = fakeDb(); seedAccount(db2); db2.set(`user_profiles/${UID}/deleting_at`, 999);
    assert.deepStrictEqual(await google(db2), { ok: false, reason: 'account_unavailable' }, '🔴 a profile a sweep CLAIMED never gets a Google login');
  }
  ok('L3 Google (linked): the lifecycle gate bumps user_profiles.last_login; a claimed profile ⇒ account_unavailable');

  // ── 12. Codex r2 P2: the forms first-login claim is CREATE-IF-ABSENT — a concurrent platform first login converges, nothing orphaned ──
  {
    const db = fakeDb(); const P = 'ph_new';
    // the forms L1 sequence: its claim txn, the base get (+ set only if absent), the gate — interleaved with a platform claim
    const platformClaim = async () => { const cand = F2; const tx = await db.ref(`phone_index/${P}`).transaction((cur) => (typeof cur === 'string' && cur ? undefined : cand)); return tx.committed ? cand : tx.snapshot.val(); };
    let platformUid = null;
    db.HOOK.after = `phone_index/${P}`; db.HOOK.fn = async () => { platformUid = await platformClaim(); };
    const claimed = await SE.claimPhoneUid(db, P, () => F1);
    let uid = db.get(`phone_index/${P}`); if (!uid) { uid = 'u_' + '9'.repeat(24); db.set(`phone_index/${P}`, uid); }   // the base lines (never fire on a live entry)
    const formsUid = await SE.loginUid(db, { pHash: P, uid: claimed, now: 1, newUid: newUids('u_' + '8'.repeat(24)) });
    assert.strictEqual(formsUid, platformUid, '🔴 forms + platform first logins converge on ONE uid');
    assert.strictEqual(db.get(`phone_index/${P}`), formsUid, 'phone_index names it (nothing orphaned)');
    // and the other order: the platform claims first, the forms claim adopts it
    const db2 = fakeDb(); db2.set(`phone_index/${P}`, F2);
    assert.strictEqual(await SE.claimPhoneUid(db2, P, () => F1), F2, 'an existing entry is adopted, never overwritten');
    assert.strictEqual(db2.get(`phone_index/${P}`), F2);
  }
  ok('Codex r2 P2: the forms first-login claim is create-if-absent — a concurrent platform first login converges on ONE uid; an existing entry is adopted, never overwritten');

  // ── 13. slot 69b045de (signup-http differential): the claim draws a fresh uid ONLY when it creates the entry — a returning login
  //    consumes NO randomness (the base draws only in `if (!uid)`), so the forms' uid stream is byte-identical. The wrapper runs every
  //    transaction updater FIRST on null (the Admin SDK's uncached first run), so a merely-lazy draw cannot pass. ──
  {
    const counter = (id) => { const f = () => { f.n += 1; return id; }; f.n = 0; return f; };
    const uncached = (db, onGet) => ({ ...db, ref: (p) => { const r = db.ref(p); return { ...r,
      get: async () => { const s = await r.get(); if (onGet) await onGet(p); return s; },
      transaction: async (fn) => { fn(null); return r.transaction(fn); } }; } });
    const P = 'ph_ret';
    // returning: phone_index names a uid ⇒ that uid, ZERO draws, nothing written
    const d1 = fakeDb(); d1.set(`phone_index/${P}`, F2);
    const g1 = counter(F1);
    assert.strictEqual(await SE.claimPhoneUid(uncached(d1), P, g1), F2);
    assert.strictEqual(g1.n, 0, '🔴 a returning login drew a fresh uid (shifts every later new uid — the forms differential)');
    // new: absent ⇒ ONE draw even across the uncached rerun, and the entry names it
    const d2 = fakeDb(); const g2 = counter(F1);
    assert.strictEqual(await SE.claimPhoneUid(uncached(d2), P, g2), F1);
    assert.strictEqual(g2.n, 1, 'a first login draws exactly once');
    assert.strictEqual(d2.get(`phone_index/${P}`), F1);
    // race: absent at the read, created by a concurrent login before the txn ⇒ the existing entry is adopted, never overwritten
    const d3 = fakeDb(); const g3 = counter(F1);
    const raced = uncached(d3, async (p) => { if (p === `phone_index/${P}`) d3.set(p, F2); });
    assert.strictEqual(await SE.claimPhoneUid(raced, P, g3), F2, 'the concurrent winner is adopted');
    assert.strictEqual(d3.get(`phone_index/${P}`), F2, 'never overwritten');
    assert.ok(g3.n <= 1, 'at most one draw on the race');
  }
  ok('the forms claim draws ONLY to create: a returning login ⇒ the existing uid with ZERO draws; a first login ⇒ one draw (Admin-SDK uncached rerun included); a raced entry is adopted, never overwritten');

  // ── fix/privacy-gaps-5f: no saved card outlives the account — customer_cards/{uid} becomes the deletion FENCE { _deleted: at } in the
  //    SAME atomic update; the card is seeded by the REAL vault writer (payments/sdk/cards completeVault), read by the REAL readers ──
  {
    const CARDS = require('./payments/sdk/cards');
    const H = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
    const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2099 };
    const cdeps = (db, now) => ({ db, clock: () => now, verifyIdToken: async () => ({ uid: UID }) });
    const AUTH = { authorization: 'Bearer t' };
    const seedCard = async (db, tok = 'tok_A') => {
      assert.strictEqual((await CARDS.completeVault(cdeps(db, 10), { uid: UID, token: tok, token_hash: H(tok), display: DISP, vault_gen: 0 })).outcome, 'created', 'premise: the real writer vaults the card');
      return Object.keys(db.get(`customer_cards/${UID}/cards`))[0];
    };
    const goneFor = async (db, id, at, label, { exact = true } = {}) => {
      const node = db.get(`customer_cards/${UID}`) || {};
      assert.ok(!node.cards && !node.by_hash && !node.tomb && !node.removed_ids, `🔴 ${label}: no token, hash or card row survives the deletion`);
      if (exact) assert.deepStrictEqual(node, { _deleted: at }, `🔴 ${label}: customer_cards/{uid} is EXACTLY the deletion fence`);
      assert.deepStrictEqual((await CARDS.listCardsCore(cdeps(db, 20), { headers: AUTH })).body, { cards: [] }, `🔴 ${label}: listCards is empty`);
      assert.strictEqual(await CARDS.resolveSavedCard(cdeps(db, 20), UID, id), null, `🔴 ${label}: the saved card can no longer be charged`);
    };
    // owner ruling 11-18 (card items 1): every saved token is CAPTURED for the provider delete in the SAME atomic update as the fence —
    // card_delete_pending/{uid} = { at: <the deletion instant>, tokens: { <token_hash>: <token> } }; nothing else, never logged
    const pendingOf = (db) => db.get(`card_delete_pending/${UID}`);
    const PEND_AB = (at) => ({ at, tokens: { [H('tok_A')]: 'tok_A', [H('tok_B')]: 'tok_B' } });
    // D1 — user-initiated deletion
    const db = fakeDb(); seedAccount(db); const id = await seedCard(db); await seedCard(db, 'tok_B');
    const d1 = await quietly(() => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 100, revoke: recorder() }));
    await goneFor(db, id, 100, 'D1', { exact: false });
    assert.deepStrictEqual(pendingOf(db), PEND_AB(100), '🔴 CARD-PENDING: D1: every saved token is captured with the deletion instant');
    assert.ok(!d1.logs.some((l) => l.includes('tok_') || l.includes(H('tok_A'))), '🔴 CARD-PENDING: D1: no token or token hash reaches a log');   // the exact fence is pinned AFTER D3: a plain null must die at D3 (the late write)
    // D3 — a vault write in flight (completeVaultForOrder after `placed`) that lands AFTER the deletion is dropped, the fence stays
    assert.strictEqual((await CARDS.completeVault(cdeps(db, 150), { uid: UID, token: 'tok_C', token_hash: H('tok_C'), display: DISP, vault_gen: 0 })).outcome, 'dropped', '🔴 D3: a late vault write is dropped');
    await goneFor(db, id, 100, 'D3');
    assert.deepStrictEqual(pendingOf(db), PEND_AB(100), '🔴 CARD-PENDING: D3: a dropped late vault adds nothing to the record');
    // D4 — a repeat deletion keeps the FIRST instant on the fence
    await SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 300, revoke: recorder() });
    await goneFor(db, id, 100, 'D4');
    assert.deepStrictEqual(pendingOf(db), PEND_AB(100), '🔴 CARD-PENDING: D4: a repeat deletion (nothing left to capture) keeps the first record byte-for-byte');
    // D2 — the inactivity sweep (the same core, sweepCutoff)
    const db2 = fakeDb(); seedAccount(db2, { lastActive: 5 }); const id2 = await seedCard(db2);
    assert.strictEqual(await SE.deleteAccountCore(db2, ACCOUNT, { uid: UID, phoneHash: PH, now: 200, sweepCutoff: 50, revoke: recorder() }), true);
    await goneFor(db2, id2, 200, 'D2');
    assert.deepStrictEqual(db2.get(`card_delete_pending/${UID}`), { at: 200, tokens: { [H('tok_A')]: 'tok_A' } }, '🔴 CARD-PENDING: D2: the sweep captures too');
    // D5 — a failed deletion update leaves the cards untouched (one atomic write)
    const db3 = fakeDb(); seedAccount(db3); await seedCard(db3);
    const before = JSON.stringify(db3.get(`customer_cards/${UID}`));
    db3.FAIL.update = true;
    await assert.rejects(() => SE.deleteAccountCore(db3, ACCOUNT, { uid: UID, phoneHash: PH, now: 400, revoke: recorder() }), /injected update failure/);
    assert.strictEqual(JSON.stringify(db3.get(`customer_cards/${UID}`)), before, '🔴 D5: a failed deletion leaves the saved cards exactly as they were');
    assert.strictEqual(db3.get(`card_delete_pending/${UID}`), undefined, '🔴 CARD-PENDING: D5: a failed deletion records no obligation (one atomic write)');
    // D7 — an account with no saved card: no obligation node at all
    const db4 = fakeDb(); seedAccount(db4);
    await SE.deleteAccountCore(db4, ACCOUNT, { uid: UID, phoneHash: PH, now: 500, revoke: recorder() });
    assert.strictEqual(db4.get('card_delete_pending'), undefined, '🔴 CARD-PENDING: D7: no saved card ⇒ no card_delete_pending node');
    // D8 (owner 11-18 «airtight», PLAN (a).1) — a vault that completes in the GAP: right after the deletion's snapshot of customer_cards/{uid}
    // and before its update. The deletion first marks the node CLOSING in a transaction (the snapshot IS that transaction's), every vault
    // drops on the mark — so no token is ever saved that the obligation did not capture
    const db5 = fakeDb(); seedAccount(db5); await seedCard(db5);
    let gap = null;
    db5.TOUCH.at = `customer_cards/${UID}`;
    db5.TOUCH.fn = async () => { gap = (await CARDS.completeVault(cdeps(db5, 90), { uid: UID, token: 'tok_G', token_hash: H('tok_G'), display: DISP, vault_gen: 0 })).outcome; };
    await quietly(() => SE.deleteAccountCore(db5, ACCOUNT, { uid: UID, phoneHash: PH, now: 600, revoke: recorder() }));
    assert.ok(gap !== null, 'premise: the vault ran in the gap');
    const p5 = db5.get(`card_delete_pending/${UID}`) || {};
    assert.ok(gap !== 'created' || (p5.tokens || {})[H('tok_G')] === 'tok_G', `🔴 CARD-CLOSING: D8: a vault that completes between the deletion's read and its update saves a token the obligation never captured (vault ${gap})`);
    assert.strictEqual(gap, 'dropped', '🔴 CARD-CLOSING: D8: a vault in the gap drops on the closing mark');
    assert.deepStrictEqual(p5, { at: 600, tokens: { [H('tok_A')]: 'tok_A' } }, '🔴 CARD-CLOSING: D8: the obligation is exactly the cards saved before the mark');
    assert.deepStrictEqual(db5.get(`customer_cards/${UID}`), { _deleted: 600 }, '🔴 CARD-CLOSING: D8: the node ends EXACTLY the fence (the mark is not left behind)');
    // D9 — a failed deletion update RELEASES the mark: the live account can save cards again, the cards are untouched
    const db6 = fakeDb(); seedAccount(db6); await seedCard(db6);
    const before6 = JSON.stringify(db6.get(`customer_cards/${UID}`));
    db6.FAIL.update = true;
    await quietly(() => assert.rejects(() => SE.deleteAccountCore(db6, ACCOUNT, { uid: UID, phoneHash: PH, now: 700, revoke: recorder() }), /injected update failure/));
    assert.strictEqual(JSON.stringify(db6.get(`customer_cards/${UID}`)), before6, '🔴 CARD-CLOSING: D9: a failed deletion releases the closing mark (cards exactly as they were)');
    assert.strictEqual((await CARDS.completeVault(cdeps(db6, 710), { uid: UID, token: 'tok_H', token_hash: H('tok_H'), display: DISP, vault_gen: 0 })).outcome, 'created', '🔴 CARD-CLOSING: D9: after a failed deletion the live account vaults again');
    // D10 — the release only undoes ITS OWN mark: a fence (the update did commit) and another deletion's mark are left exactly as they are
    const db7 = fakeDb(); db7.set(`customer_cards/${UID}`, { _deleted: 800 });
    await CARDS.releaseClosing(db7, UID, 800);
    assert.deepStrictEqual(db7.get(`customer_cards/${UID}`), { _deleted: 800 }, '🔴 CARD-CLOSING: D10: a release never touches the fence');
    db7.set(`customer_cards/${UID}`, { _closing: 900 });
    await CARDS.releaseClosing(db7, UID, 800);
    assert.deepStrictEqual(db7.get(`customer_cards/${UID}`), { _closing: 900 }, '🔴 CARD-CLOSING: D10: a release never clears another deletion\'s mark');
  }
  ok('saved cards: deleteAccount and the sweep replace customer_cards/{uid} with the fence { _deleted: at } and capture every token in card_delete_pending/{uid} { at, tokens } atomically (never logged; none ⇒ no node); listCards [] / resolveSavedCard null; a late vault write is dropped; a repeat keeps the first instant; a failed update changes nothing');

  // ── D6 (Codex #133 r1 HIGH 1): the UPGRADE — an account deleted by the BASE deletion core (before the fence) keeps its cards; the owner's
  //    tools/fence-deleted-cards.js fences exactly the authoritatively deleted ones. Base core = the real signup-endpoints.js minus the
  //    privacy hunks (tools/privacy-module-inverse), compiled in place; cards seeded by the REAL completeVault, read by the REAL readers ──
  {
    const fs = require('fs'); const path = require('path'); const Module = require('module');
    const CARDS = require('./payments/sdk/cards');
    const FENCE = require('./tools/fence-deleted-cards');
    const { unapplyPrivacyModule } = require('./tools/privacy-module-inverse');
    const f = path.join(__dirname, 'signup-endpoints.js');
    const baseSrc = unapplyPrivacyModule('signup-endpoints.js', fs.readFileSync(f, 'utf8'));
    const m = new Module(f, module); m.filename = f; m.paths = Module._nodeModulePaths(__dirname); m._compile(baseSrc, f);
    const BASE_SE = m.exports;
    assert.ok(!baseSrc.includes('[`customer_cards/${uid}`]'), 'premise: the base deletion core has no card fence');
    const H = (t) => require('crypto').createHash('sha256').update(t).digest('hex');
    const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2099 };
    const cdeps = (db, now, uid = UID) => ({ db, clock: () => now, verifyIdToken: async () => ({ uid }) });
    const AUTH = { authorization: 'Bearer t' };
    const vault = async (db, uid, tok, now = 10) => (await CARDS.completeVault(cdeps(db, now, uid), { uid, token: tok, token_hash: H(tok), display: DISP, vault_gen: 0 })).outcome;
    const db = fakeDb(); seedAccount(db);
    assert.strictEqual(await vault(db, UID, 'tok_A'), 'created', 'premise: the real writer vaults the card');
    const id = Object.keys(db.get(`customer_cards/${UID}/cards`))[0];
    await BASE_SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 100, revoke: recorder() });
    assert.ok(db.get(`deleted_uids/${UID}`) && !db.get(`user_profiles/${UID}`), 'premise: the base core deleted the account');
    assert.ok(db.get(`customer_cards/${UID}/cards/${id}/token`), 'premise (the bug): the base core left the saved card behind');
    // the other accounts the tool must NEVER touch: live, revived (stale tombstone + profile), claimed by a sweep in progress; and an
    // older deletion known only by user_private.deleted_at (before deleted_uids was written)
    const LV = 'u_' + 'b'.repeat(24), RV = 'u_' + 'c'.repeat(24), CL = 'u_' + 'd'.repeat(24), OLD = 'u_' + 'e'.repeat(24);
    for (const u of [LV, RV, CL, OLD]) assert.strictEqual(await vault(db, u, `tok_${u}`), 'created');
    db.set(`user_profiles/${LV}`, { phone: '1', phone_hash: 'p1', created_at: 1, last_login: 1 });
    db.set(`user_profiles/${RV}`, { phone: '2', phone_hash: 'p2', created_at: 1, last_login: 900 }); db.set(`deleted_uids/${RV}`, 7); db.set(`user_private/${RV}`, { deleted_at: 7 });
    db.set(`user_profiles/${CL}`, { phone: '3', phone_hash: 'p3', created_at: 1, last_login: 1, deleting_at: 950 }); db.set(`user_private/${CL}`, { deleted_at: 960 });
    db.set(`user_private/${OLD}`, { deleted_at: 55 });
    const untouched = () => [LV, RV, CL].map((u) => JSON.stringify(db.get(`customer_cards/${u}`)));
    const keep = untouched();
    // dry run: counts only, writes nothing
    const before = JSON.stringify(db.tree);
    const dryQ = await quietly(() => FENCE.fence({ rtdb: db })); const dry = dryQ.r;
    assert.deepStrictEqual(dry, { dryRun: true, tombstoned: 4, live: 2, noCards: 0, alreadyFenced: 0, fenced: 2 }, '🔴 D6: the dry run counts the 2 deleted accounts with cards, never the live / revived / claimed');
    assert.strictEqual(JSON.stringify(db.tree), before, '🔴 D6: the dry run writes nothing');
    assert.ok(!JSON.stringify(dry).includes('u_'), 'D6: counts only — no uid in the result');
    // apply: the same fence the deletion core writes, at the account's own deletion instant
    const rQ = await quietly(() => FENCE.fence({ rtdb: db, apply: true })); const r = rQ.r;
    assert.ok(![...dryQ.logs, ...rQ.logs].some((l) => l.includes('tok_')), '🔴 CARD-PENDING: D6: no token reaches a log');
    assert.deepStrictEqual(r, { dryRun: false, tombstoned: 4, live: 2, noCards: 0, alreadyFenced: 0, fenced: 2 }, '🔴 D6: --apply fences the 2 deleted accounts');
    assert.deepStrictEqual([db.get(`customer_cards/${UID}`), db.get(`customer_cards/${OLD}`)], [{ _deleted: 100 }, { _deleted: 55 }], '🔴 D6: customer_cards/{uid} is EXACTLY the fence at the account\'s own deletion instant');
    assert.deepStrictEqual((await CARDS.listCardsCore(cdeps(db, 200), { headers: AUTH })).body, { cards: [] }, '🔴 D6: listCards is empty after the upgrade');
    assert.strictEqual(await CARDS.resolveSavedCard(cdeps(db, 200), UID, id), null, '🔴 D6: the old saved card can no longer be charged');
    assert.strictEqual(await vault(db, UID, 'tok_LATE', 300), 'dropped', '🔴 D6: a late vault write after the upgrade is dropped');
    assert.deepStrictEqual(db.get(`customer_cards/${UID}`), { _deleted: 100 }, 'D6: the fence stays exact after the late write');
    assert.deepStrictEqual(untouched(), keep, '🔴 D6: live / revived / claimed accounts keep their cards byte-for-byte');
    assert.deepStrictEqual([db.get(`card_delete_pending/${UID}`), db.get(`card_delete_pending/${OLD}`)], [{ at: 100, tokens: { [H('tok_A')]: 'tok_A' } }, { at: 55, tokens: { [H(`tok_${OLD}`)]: `tok_${OLD}` } }],
      '🔴 CARD-PENDING: D6: --apply captures each fenced account\'s tokens at its own deletion instant, in the same update as the fence');
    assert.deepStrictEqual([LV, RV, CL].map((u) => db.get(`card_delete_pending/${u}`)), [undefined, undefined, undefined], '🔴 CARD-PENDING: D6: live / revived / claimed accounts get no obligation');
    // idempotent: a re-run writes nothing
    const again = JSON.stringify(db.tree);
    assert.deepStrictEqual(await FENCE.fence({ rtdb: db, apply: true }), { dryRun: false, tombstoned: 4, live: 2, noCards: 0, alreadyFenced: 2, fenced: 0 }, 'D6: a re-run finds both already fenced');
    assert.strictEqual(JSON.stringify(db.tree), again, 'D6: a re-run writes nothing');
    // the current core's own deletion is already fenced: the tool counts it, never rewrites it
    const db2 = fakeDb(); seedAccount(db2); assert.strictEqual(await vault(db2, UID, 'tok_A'), 'created');
    await SE.deleteAccountCore(db2, ACCOUNT, { uid: UID, phoneHash: PH, now: 400, revoke: recorder() });
    assert.deepStrictEqual(await FENCE.fence({ rtdb: db2, apply: true }), { dryRun: false, tombstoned: 1, live: 0, noCards: 0, alreadyFenced: 1, fenced: 0 }, 'D6: a fence written by the deletion core is left as is');
    assert.deepStrictEqual(db2.get(`customer_cards/${UID}`), { _deleted: 400 });
  }
  ok('D6 upgrade: an account deleted by the BASE core keeps its card; fence-deleted-cards (dry run: counts, no write) --apply fences exactly the tombstoned no-profile accounts at their own instant; listCards [] / resolve null / late vault dropped; live, revived and claimed untouched; idempotent');

  FINISHED = true;
  console.log(`\ndeletion-tombstone: OK (${n})`);
})().catch((e) => { process.stderr.write(`deletion-tombstone: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
