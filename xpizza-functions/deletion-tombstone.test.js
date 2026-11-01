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
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeDb() {
  const tree = {};
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
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
  const ref = (p = '') => ({
    get: async () => snap(get(p)), once: async () => snap(get(p)),
    set: async (v) => set(p, v), remove: async () => set(p, null),
    update: async (m) => { if (FAIL.update) { FAIL.update = false; throw new Error('injected update failure'); } for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v); },
    orderByChild: (c) => query(p, c),
    transaction: async (fn) => {
      if (FAIL.txnAt && String(p).startsWith(FAIL.txnAt)) { FAIL.txnAt = null; throw new Error('injected transaction failure'); }
      const next = fn(clone(get(p)) ?? null);
      const out = next === undefined ? { committed: false, snapshot: snap(get(p)) } : (set(p, next), { committed: true, snapshot: snap(get(p)) });
      if (HOOK.after && String(p).startsWith(HOOK.after)) { const f = HOOK.fn; HOOK.after = null; HOOK.fn = null; await f(); }
      return out;
    },
  });
  return { tree, get, set, ref, FAIL, HOOK };
}
const UID = 'u_' + 'a'.repeat(24), PH = 'ph_a';
const seedAccount = (db, { lastActive = 5 } = {}) => {
  db.set(`user_profiles/${UID}`, { phone: '50499990000', phone_hash: PH, created_at: 1, last_login: 1 });
  db.set(`user_orders/${UID}`, { o1: true }); db.set(`user_rewards/${UID}`, { x_pizza: { balance: 10 } });
  db.set(`phone_index/${PH}`, UID);
  db.set(`user_private/${UID}`, { email: 'a@x.hn', last_active: lastActive });
  db.set('auth_links/google/g1', { uid: UID, at: 1 });
  db.set('reward_welcome/ph_a_x_pizza', { at: 1 });
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
    for (const p of [`user_profiles/${UID}`, `user_orders/${UID}`, `user_rewards/${UID}`, `phone_index/${PH}`, 'auth_links/google/g1']) assert.strictEqual(db.get(p), undefined, `${p} removed`);
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
    const { r, logs } = await quietly(() => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 800, revoke: async () => { throw new Error('x'); }, revokeDeadlineMs: 50 }));
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
    assert.strictEqual(JSON.stringify(db.tree), before, 'DRY RUN writes nothing');
    r = await M.repair({ rtdb: db, apply: true });
    assert.deepStrictEqual([r.cleared, db.get(`user_private/${Rv}`), db.get(`deleted_uids/${Rv}`)], [1, undefined, undefined], '--apply clears BOTH stale tombstones of the revived account');
    assert.deepStrictEqual([db.get(`deleted_uids/${Dd}`), db.get(`user_private/${Cl}/deleted_at`), db.get(`user_private/${Od}/deleted_at`)], [8, 9, 50], 'deleted / claimed / no-later-activity untouched');
    assert.deepStrictEqual((await M.repair({ rtdb: db })).uids, [], 'idempotent');
  }
  ok('migration repair-revived-tombstones: dry run (default) lists ONLY revived accounts and writes nothing; --apply clears their stale tombstones; deleted / claimed / inactive accounts untouched; idempotent');

  console.log(`\ndeletion-tombstone: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
