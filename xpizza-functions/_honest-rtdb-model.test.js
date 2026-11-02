'use strict';
// Proves the test RTDB model is not laxer than production on the five points codex extra-pay r2 named.
const assert = require('assert');
const { makeHonestDb } = require('./_honest-rtdb-model');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  const db = makeHonestDb({});
  await assert.rejects(db.ref('a').set({ ok: { 'bad.key': 1 } }), /invalid RTDB key/, 'HRM-NESTED-KEYS: a reserved character in a NESTED key is refused');
  await assert.rejects(db.ref('a').update({ 'x/y': { 'b#': 1 } }), /invalid RTDB key/, 'HRM-NESTED-KEYS: also through update');
  await assert.rejects(db.ref('a').update({ x: { y: undefined } }), /undefined value/, 'HRM-NESTED-KEYS: an undefined value is refused, as the Admin SDK does');
  const dbt = makeHonestDb({}, { now: () => 777 });
  await dbt.ref('al').push({ created_at: { '.sv': 'timestamp' } });
  assert.deepStrictEqual(Object.values(dbt.getAt('al')), [{ created_at: 777 }], 'HRM-NESTED-KEYS: a server timestamp is accepted and resolved, as RTDB does');
  await assert.rejects(dbt.ref('b').set({ x: { '.sv': 'timestamp', y: 1 } }), /invalid RTDB key/, 'HRM-NESTED-KEYS: a dotted key beside other keys is still refused');
  ok('nested keys are validated on set and update');

  await db.ref('o').set({ a: 1, b: null, c: { d: null } });
  assert.deepStrictEqual(db.getAt('o'), { a: 1 }, 'HRM-NULL-PRUNE: null children and emptied objects are not stored');
  await db.ref('o/a').set(null);
  assert.strictEqual(db.getAt('o'), null, 'HRM-NULL-PRUNE: a node emptied of its last child disappears');
  ok('null children pruned; emptied parents disappear');

  await db.ref('s').set({ v: 1 });
  const snap = await db.ref('s').once('value');
  await db.ref('s').set({ v: 2 });
  assert.deepStrictEqual(snap.val(), { v: 1 }, 'HRM-IMMUTABLE-SNAPSHOT: a snapshot never shows a later write');
  const got = snap.val(); got.v = 99;
  assert.deepStrictEqual(snap.val(), { v: 1 }, 'HRM-IMMUTABLE-SNAPSHOT: mutating a returned value does not change the snapshot');
  ok('snapshots are immutable');

  let calls = 0;
  const ab = await db.ref('t').transaction((cur) => { calls += 1; if (cur === null) return; return 1; });
  assert.strictEqual(ab.committed, false, 'HRM-NULL-FIRST: undefined on the uncached null call aborts');
  assert.strictEqual(calls, 1, 'HRM-NULL-FIRST: and is not retried');
  await db.ref('t2').set(5);
  const re = await db.ref('t2').transaction((cur) => (cur === null ? 0 : cur + 1));
  assert.ok(re.committed && db.getAt('t2') === 6, 'HRM-NULL-FIRST: a value from the null call is re-run against the server value');
  ok('null-first: abort honoured; a server mismatch re-runs with the server value');

  const db2 = makeHonestDb({ c: 0 }, { beforeTx: async () => {} });
  let runs = 0;
  const tx = db2.ref('c').transaction((cur) => { runs += 1; if (runs === 2) Promise.resolve().then(() => db2.setAt('c', 10)); return (cur || 0) + 1; });
  const res = await tx;
  assert.ok(res.committed && db2.getAt('c') === 11, `HRM-CONFLICT-RETRY: a write landing mid-transaction re-runs the function on the new value (got ${db2.getAt('c')}, runs ${runs})`);
  ok('a concurrent write during a transaction is a conflict that re-runs it');
  const db3 = makeHonestDb({});
  await db3.ref('a/b').set(1);
  assert.deepStrictEqual(db3.root, { a: { b: 1 } }, 'HRM-ROOT-LIVE: db.root reflects writes made AFTER the model was created (a whole-database comparison is never vacuous)');
  const r1 = db3.root; r1.a.b = 9;
  assert.deepStrictEqual(db3.root, { a: { b: 1 } }, 'HRM-ROOT-LIVE: and is a copy');
  ok('db.root is live and a copy');
  console.log(`\nhonest-rtdb-model: OK (${n})`);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
