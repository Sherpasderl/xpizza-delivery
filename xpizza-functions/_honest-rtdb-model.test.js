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
  const db4 = makeHonestDb({ q: { b: 1, '10': 2, a: 3, '9': 4, '2147483648': 5, '-1': 6 } });
  const pg = (await db4.ref('q').orderByKey().limitToFirst(4).once('value')).val();
  const sel = async (n) => Object.keys((await db4.ref('q').orderByKey().limitToFirst(n).once('value')).val()).sort();
  assert.deepStrictEqual(await sel(3), ['-1', '10', '9'], `HRM-KEY-ORDER: 32-bit integer keys are selected first, numerically (got ${JSON.stringify(await sel(3))})`);
  assert.deepStrictEqual(await sel(5), ['-1', '10', '2147483648', '9', 'a'], `HRM-KEY-ORDER: then the rest by string — a key past 32 bits is a string (got ${JSON.stringify(await sel(5))})`);
  assert.deepStrictEqual(pg, { '-1': 6, 9: 4, 10: 2, 2147483648: 5 }, 'HRM-KEY-ORDER: a bounded page carries only the first n children');
  assert.strictEqual((await db4.ref('none').orderByKey().limitToFirst(3).once('value')).val(), null, 'HRM-KEY-ORDER: an absent node is null');
  assert.throws(() => db4.ref('q').orderByKey().limitToFirst(0), /invalid limit/, 'HRM-KEY-ORDER: a non-positive limit throws (never everything)');
  ok('key-ordered bounded page');
  for (const bad of ['a.b/c', 'a/b#', 'x/$y', 'q[1]', 'q]', 'a/b\u0000c', 'a/\u001f', 'a/\u007f']) assert.throws(() => db4.ref(bad), /invalid RTDB path/, `HRM-REF-PATH: ref("${bad}") throws, as the Admin SDK does`);
  assert.doesNotThrow(() => db4.ref(''), 'HRM-REF-PATH: the root is a valid ref');
  await assert.rejects(db4.ref('k').set({ 'x\u0001y': 1 }), /invalid RTDB key/, 'HRM-REF-PATH: a control character in a written key is refused, as the Admin SDK does');
  ok('an invalid path throws at ref()');
  // HRM-VALUE-ORDER: orderByValue().endAt(v).limitToFirst(n) — RTDB's value order (null < false < true < numbers < strings <
  // objects; ties by key), endAt inclusive, a bounded page; a non-positive limit throws.
  const db5 = makeHonestDb({ d: { a: 30, b: 10, c: 20, d: 10, e: 'x', f: { z: 1 }, g: true } });
  const vsel = async (end, n) => Object.keys((await db5.ref('d').orderByValue().endAt(end).limitToFirst(n).once('value')).val() || {}).sort();
  assert.deepStrictEqual(await vsel(20, 10), ['b', 'c', 'd', 'g'], `HRM-VALUE-ORDER: endAt 20 keeps true and the numbers <= 20 (got ${JSON.stringify(await vsel(20, 10))})`);
  assert.deepStrictEqual(await vsel(20, 2), ['b', 'g'], `HRM-VALUE-ORDER: the first 2 in value order are true, then 10@b (tie b<d by key) (got ${JSON.stringify(await vsel(20, 2))})`);
  assert.deepStrictEqual(await vsel(5, 10), ['g'], 'HRM-VALUE-ORDER: only true sorts below 5');
  assert.strictEqual((await db5.ref('none').orderByValue().endAt(1).limitToFirst(3).once('value')).val(), null, 'HRM-VALUE-ORDER: an absent node is null');
  assert.throws(() => db5.ref('d').orderByValue().endAt(1).limitToFirst(0), /invalid limit/, 'HRM-VALUE-ORDER: a non-positive limit throws');
  ok('value-ordered bounded page');
  // HRM-EMPTY-ARRAY: RTDB stores an array as children; an EMPTY array (or one of only nulls) has none, so the key is absent
  const db6 = makeHonestDb({});
  await db6.ref('x').set({ a: [], b: [null], c: [1, 2], keep: 1 });
  assert.deepStrictEqual(db6.getAt('x'), { c: [1, 2], keep: 1 }, `HRM-EMPTY-ARRAY: an empty array is absent, as in RTDB (got ${JSON.stringify(db6.getAt('x'))})`);
  ok('an empty array is pruned');
  // LEDGER S5: the nightly rebuild's queries — orderByChild(c).startAt(x) / .equalTo(x) and orderByKey().startAt(a).endAt(b) — in
  // RTDB's VALUE order (absent < false < true < numbers < strings < objects): a startAt(number) ALSO returns string / object values,
  // as production does, so a reader must re-check the type. Every query is logged (db.queries) for the index cross-check.
  const db7 = makeHonestDb({ o: { a: { t: 5 }, b: { t: 10 }, c: { t: 'x' }, d: {}, e: { t: { n: 1 } }, f: { t: 10, r: true }, g: { r: false } } });
  assert.deepStrictEqual(Object.keys((await db7.ref('o').orderByChild('t').startAt(10).once('value')).val()), ['b', 'f', 'c', 'e'], '🔴 HRM-CHILD-START: numbers ≥ 10, then strings, then objects (value order, ties by key)');
  assert.deepStrictEqual(Object.keys((await db7.ref('o').orderByChild('r').equalTo(true).once('value')).val()), ['f'], '🔴 HRM-CHILD-EQ: equalTo(true) is exact');
  assert.strictEqual((await db7.ref('o').orderByChild('t').equalTo(11).once('value')).val(), null, '🔴 HRM-CHILD-EQ: no match ⇒ null');
  const db8 = makeHonestDb({ r: { 'A-1': 1, 'A-2': 2, 'AB-1': 3, 'B-1': 4 } });
  assert.deepStrictEqual(Object.keys((await db8.ref('r').orderByKey().startAt('A-').endAt('A-\uf8ff').once('value')).val()), ['A-1', 'A-2'], '🔴 HRM-KEY-RANGE: a key prefix range, inclusive');
  assert.deepStrictEqual(db7.queries.map((q) => [q.path, q.child]), [['o', 't'], ['o', 'r'], ['o', 't']], '🔴 HRM-QUERY-LOG: every child query is logged');
  ok('orderByChild startAt / equalTo in RTDB value order; orderByKey startAt/endAt; child queries logged');
  // Codex #116 #4: the query bounds DIFFERENTIALLY against the installed Admin SDK (it validates a bound synchronously, before any network)
  {
    const sdkApp = require('firebase-admin').initializeApp({ projectId: 'demo-hrm', databaseURL: 'http://127.0.0.1:1?ns=demo-hrm' }, 'hrm-bounds');
    const sdk = sdkApp.database();
    const db9 = makeHonestDb({ o: { a: { t: 1 }, b: { u: 1 }, c: { t: 'x' } } });
    const BOUNDS = [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['null', null], ['undefined', undefined], ['1', 1], ['"x"', 'x'], ['true', true], ['{}', { a: 1 }], ['[]', [1]]];
    const throws = (f) => { try { f(); return false; } catch (_) { return true; } };
    for (const m of ['startAt', 'equalTo']) for (const [label, v] of BOUNDS) {
      assert.strictEqual(throws(() => db9.ref('o').orderByChild('t')[m](v)), throws(() => sdk.ref('o').orderByChild('t')[m](v)), `🔴 HRM-BOUNDS: orderByChild().${m}(${label}) — the model must accept / refuse as the Admin SDK does`);
    }
    for (const [label, v] of BOUNDS) assert.strictEqual(throws(() => db9.ref('o').orderByKey().startAt(v)), throws(() => sdk.ref('o').orderByKey().startAt(v)), `🔴 HRM-BOUNDS: orderByKey().startAt(${label})`);
    assert.deepStrictEqual(Object.keys((await db9.ref('o').orderByChild('t').startAt(null).once('value')).val()), ['b', 'a', 'c'], '🔴 HRM-BOUNDS: startAt(null) keeps every child (absent first)');
    assert.deepStrictEqual(Object.keys((await db9.ref('o').orderByChild('t').equalTo(null).once('value')).val()), ['b'], '🔴 HRM-BOUNDS: equalTo(null) = the children without the value');
    await sdkApp.delete();
  }
  ok('query bounds accepted / refused exactly as the Admin SDK (differential); null bounds behave as RTDB');
  // LEDGER S6 r3 (Codex #118 r2 #2): the bounded reads — limitToFirst after equalTo / startAt and after a key range, in the query's order
  {
    const db10 = makeHonestDb({ p: { a: { o: 'X' }, b: { o: 'X' }, c: { o: 'Y' }, d: { o: 'X' } }, r: { 'A-1': 1, 'A-2': 2, 'A-3': 3 } });
    assert.deepStrictEqual(Object.keys((await db10.ref('p').orderByChild('o').equalTo('X').limitToFirst(2).once('value')).val()), ['a', 'b'], '🔴 HRM-LIMIT: equalTo(…).limitToFirst(2)');
    assert.deepStrictEqual(Object.keys((await db10.ref('r').orderByKey().startAt('A-').endAt('A-\uf8ff').limitToFirst(2).once('value')).val()), ['A-1', 'A-2'], '🔴 HRM-LIMIT: a key range .limitToFirst(2)');
    assert.throws(() => db10.ref('p').orderByChild('o').equalTo('X').limitToFirst(0), /limitToFirst/, '🔴 HRM-LIMIT: a non-positive limit throws');
  }
  ok('limitToFirst after a child equalTo / startAt and after a key range (bounded reads)');
  console.log(`\nhonest-rtdb-model: OK (${n})`);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
