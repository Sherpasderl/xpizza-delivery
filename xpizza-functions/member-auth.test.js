'use strict';
// PLAN-3a-capp-member-reads r4 §R2.1 — member-auth.memberUidOf: the ONE member predicate of the capp's member reads. Its callers'
// handler suites (my-orders.test.js M1, …) prove the wiring; this file pins the predicate itself, cell by cell. Run: node member-auth.test.js
const assert = require('assert');
const { memberUidOf, verifiedMemberUid, isMemberTombstoned } = require('./member-auth');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 member-auth: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });

function fakeDb(seed = {}) {
  const reads = [];
  const get = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), seed);
  return { reads, ref: (p) => ({ once: async () => { reads.push(p); const v = get(p); return { exists: () => v != null, val: () => (v == null ? null : v) }; } }) };
}
const U = 'u_member';
const TOK = { good: { uid: U, customer: true }, hh: { uid: U, customer: true, handheld: true }, staff: { uid: U }, nouid: { customer: true }, blank: { uid: '', customer: true } };
const verify = async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; };
const UNAUTH = { status: 401, reason: 'unauthenticated' };

(async () => {
  // 1. every 401 class — and none of them reads the database
  for (const [why, t] of [['no token', undefined], ['an empty token', ''], ['a non-string token', 42], ['a bad token', 'nope'],
    ['a non-customer token', 'staff'], ['a customer + HANDHELD token', 'hh'], ['no uid', 'nouid'], ['an empty uid', 'blank']]) {
    const db = fakeDb();
    assert.deepStrictEqual(await memberUidOf(db, t, verify), UNAUTH, `🔴 ${why} ⇒ 401`);
    assert.strictEqual(db.reads.length, 0, `🔴 ${why}: no database read before the token is a member's`);
  }
  ok('401 for no / empty / non-string / bad token, a non-customer token, a customer+HANDHELD token, no or empty uid — before any read');

  // 2. each of the THREE tombstones alone ⇒ 403 deleted
  for (const [why, seed] of [['deleted_uids', { deleted_uids: { [U]: 1 } }], ['user_private deleted_at', { user_private: { [U]: { deleted_at: 1 } } }],
    ['user_profiles deleting_at (the sweep claim)', { user_profiles: { [U]: { deleting_at: 1 } } }]]) {
    assert.deepStrictEqual(await memberUidOf(fakeDb(seed), 'good', verify), { status: 403, reason: 'deleted' }, `🔴 ${why} ⇒ 403`);
  }
  ok('403 deleted for EACH of the three tombstones alone (deleted_uids, user_private/deleted_at, user_profiles/deleting_at)');

  // 3. a live member ⇒ { uid }, after exactly the three tombstone reads
  {
    const db = fakeDb({ user_private: { [U]: { last_tip: { cents: 2000 } } }, user_profiles: { [U]: { name: 'Ana' } } });
    assert.deepStrictEqual(await memberUidOf(db, 'good', verify), { uid: U });
    assert.deepStrictEqual(db.reads.slice().sort(), [`deleted_uids/${U}`, `user_private/${U}/deleted_at`, `user_profiles/${U}/deleting_at`].sort());
  }
  ok('a live member ⇒ { uid } after exactly the three tombstone point reads (siblings of the tombstones never count)');

  // 4. the two steps compose to the same answer
  assert.strictEqual(await verifiedMemberUid('hh', verify), null);
  assert.strictEqual(await verifiedMemberUid('good', verify), U);
  assert.strictEqual(await isMemberTombstoned(fakeDb({ user_profiles: { [U]: { deleting_at: 1 } } }), U), true);
  assert.strictEqual(await isMemberTombstoned(fakeDb(), U), false);
  ok('the exported steps: verifiedMemberUid refuses a handheld token; isMemberTombstoned sees the sweep claim');

  // 5. Codex asm9b r1 P2: EACH tombstone read failing alone (an outage) ⇒ refused — the predicate rejects (its callers answer 503), it
  //    never resolves to a uid, and nothing is written
  for (const failing of [`deleted_uids/${U}`, `user_private/${U}/deleted_at`, `user_profiles/${U}/deleting_at`]) {
    const base = fakeDb({ user_profiles: { [U]: { name: 'Ana' } } });
    const writes = [];
    const db = { reads: base.reads, ref: (p) => ({
      once: async () => { if (p === failing) { base.reads.push(p); throw new Error('rtdb unavailable'); } return base.ref(p).once(); },
      set: async () => { writes.push(p); }, update: async () => { writes.push(p); }, transaction: async () => { writes.push(p); }, remove: async () => { writes.push(p); } }) };
    let out = 'resolved';
    try { out = await memberUidOf(db, 'good', verify); } catch (_) { out = 'rejected'; }
    assert.strictEqual(out, 'rejected', `🔴 ${failing} unreadable ⇒ refused (rejected), never a uid (${JSON.stringify(out)})`);
    let t = 'resolved';
    try { t = await isMemberTombstoned(db, U); } catch (_) { t = 'rejected'; }
    assert.strictEqual(t, 'rejected', `🔴 ${failing} unreadable ⇒ isMemberTombstoned rejects (never a guessed «live»)`);
    assert.deepStrictEqual(writes, [], `🔴 ${failing} unreadable ⇒ nothing written`);
  }
  ok('an outage on EACH tombstone read alone ⇒ refused (the predicate rejects; never a uid, never «live»); nothing written');

  FINISHED = true;
  console.log(`\nmember-auth: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\nmember-auth: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
