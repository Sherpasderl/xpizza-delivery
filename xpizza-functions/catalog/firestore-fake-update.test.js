'use strict';
// catalog/firestore-fake.js update() — faithful to Firestore's DocumentReference.update (PLAN-manager-request-consequences, Codex r1):
// a missing doc → code 5; the precondition must be a real Timestamp and a stale one → code 9; a top-level key replaces that field,
// a DOTTED key sets the nested field and keeps its siblings; every other field is kept; each write stamps a new updateTime.
// Run: node catalog/firestore-fake-update.test.js
const assert = require('assert');
const { Timestamp } = require('firebase-admin/firestore');
const { makeDb } = require('./firestore-fake');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  const db = makeDb(); const ref = db.collection('c').doc('d');
  await assert.rejects(ref.update({ a: 1 }), (e) => e.code === 5, 'a missing document refuses with code 5');
  await ref.set({ keep: 'k', a: 1, m: { x: 1, y: 2 } });
  const t0 = (await ref.get()).updateTime;
  await assert.rejects(ref.update({ a: 2 }, { lastUpdateTime: `${t0.seconds}.${String(t0.nanoseconds).padStart(9, '0')}` }), TypeError, 'a string precondition is refused (the SDK takes a Timestamp)');
  await assert.rejects(ref.update({ a: 2 }, { lastUpdateTime: new Timestamp(t0.seconds - 1, 0) }), (e) => e.code === 9, 'a stale Timestamp precondition refuses with code 9');
  assert.deepStrictEqual((await ref.get()).data(), { keep: 'k', a: 1, m: { x: 1, y: 2 } }, 'nothing written by a refused update');
  ok('missing → 5; a string precondition → TypeError; a stale Timestamp → 9; nothing written');
  const w = await ref.update({ a: 2, 'm.x': 9, 'n.p.q': 'deep' }, { lastUpdateTime: t0 });
  const after = await ref.get();
  assert.deepStrictEqual(after.data(), { keep: 'k', a: 2, m: { x: 9, y: 2 }, n: { p: { q: 'deep' } } }, 'top-level replaces; dotted sets the nested field, keeps siblings, creates maps');
  assert.ok(w.writeTime.isEqual(after.updateTime) && !after.updateTime.isEqual(t0), 'a new updateTime, returned as writeTime');
  ok('a matching Timestamp precondition commits: top-level replace, dotted nested set with siblings kept, new updateTime');
  await ref.update({ m: { z: 3 } });
  assert.deepStrictEqual((await ref.get()).data().m, { z: 3 }, 'a top-level key REPLACES the whole map (no deep merge)');
  ok('a top-level map value replaces the field whole; no precondition → unconditional');
  // Codex r2: an update never alters a field it was not given — Timestamps, NaN, ±Infinity and a plain map that merely LOOKS like an
  // encoded value all survive exactly
  const r2 = db.collection('c').doc('p');
  const ts = new Timestamp(1700000000, 123456789);
  await r2.set({ nan: NaN, inf: Infinity, ninf: -Infinity, ts, nested: { ts, list: [ts, NaN, { __ts: [1, 2], keep: 'k' }] }, look: { __ts: [1, 2], keep: 'k' }, n: 1 });
  await r2.update({ n: 2, 'nested.other': true }, { lastUpdateTime: (await r2.get()).updateTime });
  const d = (await r2.get()).data();
  assert.ok(Number.isNaN(d.nan) && d.inf === Infinity && d.ninf === -Infinity, 'NaN / ±Infinity preserved');
  assert.ok(d.ts instanceof Timestamp && d.ts.isEqual(ts) && d.nested.ts instanceof Timestamp && d.nested.list[0] instanceof Timestamp && Number.isNaN(d.nested.list[1]), 'Timestamps (top-level, nested, in arrays) preserved as Timestamps');
  assert.deepStrictEqual([d.look, d.nested.list[2], d.n, d.nested.other], [{ __ts: [1, 2], keep: 'k' }, { __ts: [1, 2], keep: 'k' }, 2, true], 'a plain map shaped like an encoded value stays a plain map (keep intact); the given fields change');
  ok('an update preserves every field it was not given: Timestamps, NaN, ±Infinity, look-alike plain maps');
  // ── WriteBatch.update (advisor 11-13, for editCatalogCore's draft + high-water-mark commit, edit-catalog-handler.js:405) ──
  // Firestore's batch is ATOMIC: every write lands, or none does; update() refuses a missing doc (5) and a stale precondition (9);
  // create() refuses an existing doc (6); the writes share ONE commit time, returned per write as writeTime.
  {
    const b0 = makeDb(); const D = b0.collection('c').doc('draft'); const X = b0.collection('c').doc('x'); const H = b0.collection('c').doc('hwm');
    const batchOf = () => b0.batch();
    let bt = batchOf(); bt.create(X, { v: 1 }); bt.update(D, { a: 1 });
    await assert.rejects(bt.commit(), (e) => e.code === 5, 'BU-MISSING: a batch update of a missing doc refuses with code 5');
    assert.strictEqual((await X.get()).exists, false, 'BU-MISSING: atomic — the create beside it did not land');
    ok('BU-MISSING batch.update of a missing document → code 5, and nothing in the batch lands');
    await D.set({ keep: 'k', a: 1, m: { x: 1, y: 2 } }); await H.set({ value: 3 });
    const tD = (await D.get()).updateTime; const tH = (await H.get()).updateTime;
    bt = batchOf(); bt.set(X, { v: 1 }); bt.update(D, { a: 2 }, { lastUpdateTime: new Timestamp(tD.seconds - 1, 0) });
    await assert.rejects(bt.commit(), (e) => e.code === 9, 'BU-STALE: a stale precondition refuses with code 9');
    assert.deepStrictEqual([(await X.get()).exists, (await D.get()).data(), (await D.get()).updateTime.isEqual(tD)], [false, { keep: 'k', a: 1, m: { x: 1, y: 2 } }, true], 'BU-STALE: atomic — nothing landed');
    bt = batchOf(); bt.update(D, { a: 2 }, { lastUpdateTime: tD }); bt.create(H, { value: 4 });
    await assert.rejects(bt.commit(), (e) => e.code === 6, 'BU-ROLLBACK: a create of an existing doc refuses with code 6');
    assert.deepStrictEqual([(await D.get()).data().a, (await D.get()).updateTime.isEqual(tD), (await H.get()).data()], [1, true, { value: 3 }], 'BU-ROLLBACK: atomic — the update BEFORE the failing create is rolled back');
    ok('BU-STALE / BU-ROLLBACK a stale precondition → 9, a create over an existing doc → 6; either way the whole batch is rolled back');
    assert.throws(() => batchOf().update(D, { a: 2 }, { lastUpdateTime: `${tD.seconds}` }), TypeError, 'BU-TYPES: a string precondition is refused (the SDK takes a Timestamp)');
    assert.throws(() => batchOf().update(D, {}), /at least one field/i, 'BU-TYPES: an empty update is refused, as the SDK refuses it');
    assert.throws(() => batchOf().update(D, 'a', 2), /field\/value form/, 'BU-TYPES: the field/value varargs form is not modelled — refused, never misread');
    ok('BU-TYPES a string precondition, an empty update and the unmodelled field/value form are refused at the call');
    bt = batchOf(); bt.update(D, { a: 2, 'm.x': 9, 'n.p': 'deep' }, { lastUpdateTime: tD }); bt.update(H, { value: 4 }, { lastUpdateTime: tH });
    const res = await bt.commit();
    const d1 = await D.get(); const h1 = await H.get();
    assert.deepStrictEqual(d1.data(), { keep: 'k', a: 2, m: { x: 9, y: 2 }, n: { p: 'deep' } }, 'BU-MERGE: top-level replaces; a dotted path sets the nested field and keeps its siblings; other fields kept');
    assert.deepStrictEqual(h1.data(), { value: 4 }, 'BU-MERGE: the second write landed');
    assert.ok(Array.isArray(res) && res.length === 2 && res[0].writeTime.isEqual(d1.updateTime) && res[1].writeTime.isEqual(h1.updateTime), 'BU-MERGE: commit returns one WriteResult per write, writeTime = the stored updateTime');
    assert.ok(d1.updateTime.isEqual(h1.updateTime) && !d1.updateTime.isEqual(tD), 'BU-MERGE: one commit time for the whole batch, new');
    ok('BU-MERGE a matching precondition commits: field-path merge, one WriteResult per write, one shared new commit time');
  }
  console.log(`\nfirestore-fake-update: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
