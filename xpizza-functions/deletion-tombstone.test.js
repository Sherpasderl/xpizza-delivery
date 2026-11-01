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
  const ref = (p = '') => ({
    get: async () => snap(get(p)), once: async () => snap(get(p)),
    set: async (v) => set(p, v), remove: async () => set(p, null),
    update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v); },
    orderByChild: (c) => query(p, c),
    transaction: async (fn) => { const next = fn(clone(get(p)) ?? null); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; set(p, next); return { committed: true, snapshot: snap(get(p)) }; },
  });
  return { tree, get, set, ref };
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
    assert.ok(a && a.type === 'account_revoke_failed' && a.uid === UID && a.created_at === 300 && typeof a.reason === 'string', `🔴 ${label}: the failure is ALERTED (${JSON.stringify(a)})`);
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
    const r = await SE.pruneResidual(db, 1000);
    assert.strictEqual(db.get(`deleted_uids/${A}`), 7, '🔴 backfilled with ITS deleted_at');
    assert.strictEqual(db.get(`deleted_uids/${B}`), 3, 'an existing tombstone is never rewritten');
    assert.strictEqual(db.get(`deleted_uids/${C}`), undefined, 'a live account never gets a tombstone');
    assert.strictEqual(r.tombstones, 1, 'the residual reports how many it backfilled');
    assert.strictEqual((await SE.pruneResidual(db, 1001)).tombstones, 0, 'idempotent');
  }
  ok('residual backfill: a user_private tombstone without deleted_uids gets one (its own deleted_at); existing kept; live untouched; idempotent');

  console.log(`\ndeletion-tombstone: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
