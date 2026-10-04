'use strict';
// Portal 1D · D4-a — the catalog registry verifier (catalog/catalog-verifier.js), over a controllable fake
// Firestore so hangs, late completions and the clock are exact. The REAL coherent read on the emulator is
// exercised in test/catalog-context.emulator.test.js.
const assert = require('assert');
const V = require('./catalog-verifier');
const { catalogSnapshot } = require('./generate-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'rid_a';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A registry as rows keyed by doc path. `gate` (optional) is awaited before a read returns.
function fakeDb(rows, { gate = null, fail = false } = {}) {
  const reads = [];
  return {
    reads,
    doc: (path) => ({ path }),
    runTransaction: async (fn, opts) => {
      assert.deepStrictEqual(opts, { readOnly: true }, 'the coherent read is a READ-ONLY transaction');
      return fn({
        getAll: async (...refs) => {
          reads.push(refs.map((r) => r.path));
          if (gate) await gate();
          if (fail) throw new Error('UNAVAILABLE');
          const snapshot = { ...rows };                               // one consistent view
          return refs.map((r) => ({ exists: !!snapshot[r.path], data: () => snapshot[r.path] }));
        },
      });
    },
  };
}
const live = (kind, id, legacyKey) => ({ [V.idPath(RID, kind, id)]: { legacy_key: legacyKey, status: 'live', kind }, [V.keyPath(RID, kind, legacyKey)]: { canonical_id: id, kind } });
const pairs2 = [{ kind: 'dish', canonicalId: 'ID1', legacyKey: 'Margherita' }, { kind: 'dish', canonicalId: 'ID2', legacyKey: 'Pepperoni' }];
const reg2 = () => ({ ...live('dish', 'ID1', 'Margherita'), ...live('dish', 'ID2', 'Pepperoni') });

(async () => {
  // 1. The per-pair judgement, every rejection reason NAMING the object.
  const obs = (rows) => ({ rows, observedAt: 0 });
  const judge = (rows, p) => V.judgePair(RID, p, rows);
  const p1 = pairs2[0];
  assert.strictEqual(judge(reg2(), p1), null, 'a live, bidirectionally agreeing pair passes');
  const cases = [
    ['retired', { ...reg2(), [V.idPath(RID, 'dish', 'ID1')]: { legacy_key: 'Margherita', status: 'retired', kind: 'dish' } }],
    ['not_live', { ...reg2(), [V.idPath(RID, 'dish', 'ID1')]: { legacy_key: 'Margherita', status: 'pending', kind: 'dish' } }],
    ['missing_id_row', (() => { const r = reg2(); delete r[V.idPath(RID, 'dish', 'ID1')]; return r; })()],
    ['foreign_kind', (() => { const r = reg2(); delete r[V.idPath(RID, 'dish', 'ID1')]; r[V.idPath(RID, 'extra', 'ID1')] = { legacy_key: 'Margherita', status: 'live', kind: 'extra' }; return r; })()],
    ['missing_key_row', (() => { const r = reg2(); delete r[V.keyPath(RID, 'dish', 'Margherita')]; return r; })()],
    ['id_names_other_key', { ...reg2(), [V.idPath(RID, 'dish', 'ID1')]: { legacy_key: 'Pepperoni', status: 'live', kind: 'dish' } }],
    ['key_names_other_id', { ...reg2(), [V.keyPath(RID, 'dish', 'Margherita')]: { canonical_id: 'ID2', kind: 'dish' } }],
  ];
  for (const [reason, rows] of cases) {
    const r = judge(rows, p1);
    assert.ok(r, `${reason}: rejected`);
    assert.strictEqual(r.reason, reason);
    assert.deepStrictEqual({ kind: r.kind, legacyKey: r.legacyKey, canonicalId: r.canonicalId }, { kind: 'dish', legacyKey: 'Margherita', canonicalId: 'ID1' }, `${reason}: names the object`);
  }
  // non-retired but non-live is NOT accepted (the forward resolver would accept it; the verifier must not)
  assert.strictEqual(V.evaluate(RID, [p1], obs(cases[1][1])).state, 'rejected');
  ok(`every rejection names the object: ${cases.map((c) => c[0]).join(', ')}; status must be exactly 'live'`);

  // 2. WARM stamp swap: verify a correct map (observation cached), then swap two stamps → rejected, NO new read.
  {
    let t = 1000;
    const db = fakeDb(reg2());
    const v = V.createCatalogVerifier({ db, now: () => t, log: () => {} });
    assert.strictEqual((await v.verify(RID, pairs2)).state, 'confirmed');
    assert.strictEqual(db.reads.length, 1);
    const swapped = [{ ...pairs2[0], canonicalId: 'ID2' }, { ...pairs2[1], canonicalId: 'ID1' }];
    assert.deepStrictEqual(V.readSetOf(RID, swapped), V.readSetOf(RID, pairs2), 'premise — a swap has the SAME read set');
    const e = v.eligibilityFor(RID, swapped);
    assert.strictEqual(db.reads.length, 1, 'served from the cached OBSERVATION, not a new read');
    assert.strictEqual(e.state, 'rejected', '🔴 a cached confirmation must never be reused by a different identity map');
    assert.deepStrictEqual(e.rejections.map((r) => r.legacyKey).sort(), ['Margherita', 'Pepperoni'], 'names BOTH swapped objects');
    assert.strictEqual(v.eligibilityFor(RID, pairs2).state, 'confirmed', '…while the true map is still confirmed from the same rows');
  }
  ok('warm swap: a confirmed map caches only the rows; the swapped map (same read set, same rows) is rejected naming both objects, with no new read');

  // 3. Two CONCURRENT cold requests, same read set, different pairs → ONE read in flight, each judged on its own pairs.
  {
    let release; const gate = () => new Promise((r) => { release = r; });
    const db = fakeDb(reg2(), { gate });
    const v = V.createCatalogVerifier({ db, now: () => 5, log: () => {} });
    const swapped = [{ ...pairs2[0], canonicalId: 'ID2' }, { ...pairs2[1], canonicalId: 'ID1' }];
    const a = v.verify(RID, pairs2), b = v.verify(RID, swapped);
    await wait(5);
    assert.strictEqual(db.reads.length, 1, 'single-flight by read set: one coherent read');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra.state, 'confirmed'); assert.strictEqual(rb.state, 'rejected');
    // a DIFFERENT read set needs its own read
    await v.verify(RID, [pairs2[0]]);
    assert.strictEqual(db.reads.length, 2, 'a different read set → its own coherent read');
  }
  ok('concurrent cold requests sharing a read set share one read and are each judged on their OWN pairs; a different read set reads separately');

  // 4. Expiry from observedAt (the read's START), and bounded staleness for a retirement after the observation.
  {
    let t = 0;
    const rows = reg2();
    let release; const gate = () => new Promise((r) => { release = r; });
    const db = fakeDb(rows, { gate });
    // a deadline the read MEETS (E4: a completion past its deadline is discarded — see context-hardening)
    const v = V.createCatalogVerifier({ db, now: () => t, ttlMs: 60000, timeoutMs: 30000, log: () => {} });
    const pending = v.verify(RID, pairs2);
    await wait(5);
    t = 20000;                         // the read takes 20s of fake time (within its 30s deadline)…
    release();
    const r = await pending;
    assert.strictEqual(r.observedAt, 0, 'observedAt is the read START, not its completion');
    assert.strictEqual(r.expiresAt, 60000, 'expiry is computed from observedAt');
    // the registry retires ID1 AFTER the observation was cached
    rows[V.idPath(RID, 'dish', 'ID1')] = { legacy_key: 'Margherita', status: 'retired', kind: 'dish' };
    t = 59999;
    assert.strictEqual(v.eligibilityFor(RID, pairs2, { startRead: false }).state, 'confirmed', 'confirmed AS OF the unexpired observation (bounded staleness)');
    t = 60001;
    assert.strictEqual(v.eligibilityFor(RID, pairs2, { startRead: false }).state, 'unknown', 'expired → dropped, never served');
    const db2 = fakeDb(rows);
    const v2 = V.createCatalogVerifier({ db: db2, now: () => t, log: () => {} });
    const after = await v2.verify(RID, pairs2);
    assert.strictEqual(after.state, 'rejected'); assert.strictEqual(after.rejections[0].reason, 'retired');
  }
  ok('expiry runs from the read START (a 20s read does not extend it); a retirement after caching is confirmed until expiry, then rejected on re-read');

  // 5. Timeout + LATE completion discarded (never cached); a failing read → unknown.
  {
    let release; const gate = () => new Promise((r) => { release = r; });
    const db = fakeDb(reg2(), { gate });
    const v = V.createCatalogVerifier({ db, now: () => 1, timeoutMs: 30, log: () => {} });
    const r = await v.verify(RID, pairs2);
    assert.deepStrictEqual(r, { state: 'unknown', reason: 'unreachable' });
    release(); await wait(10);
    assert.strictEqual(v._cache.size, 0, '🔴 a completion after the deadline is DISCARDED, not cached');
    assert.strictEqual(v.stats.discardedLate, 1);
    const vf = V.createCatalogVerifier({ db: fakeDb(reg2(), { fail: true }), now: () => 1, log: () => {} });
    assert.strictEqual((await vf.verify(RID, pairs2)).state, 'unknown');
  }
  ok('a hung read times out to unknown and its late completion is discarded (cache stays empty); a failing read → unknown');

  // 6. Off the price path: eligibilityFor is synchronous and returns unknown at once while the read is pending; global cap.
  {
    let release; const gate = () => new Promise((r) => { release = r; });
    const db = fakeDb(reg2(), { gate });
    const v = V.createCatalogVerifier({ db, now: () => 1, maxInflight: 1, log: () => {} });
    const r = v.eligibilityFor(RID, pairs2);
    assert.ok(!(r instanceof Promise) && r.state === 'unknown' && r.reason === 'not_observed', 'synchronous, unknown on a miss');
    v.eligibilityFor(RID, [pairs2[0]]);   // a different read set while the cap (1) is full
    assert.strictEqual(v.stats.capped, 1, 'the global concurrency cap refuses a second concurrent read');
    await wait(5); release(); await wait(5);   // the read starts on a later microtask (F3), then reaches the gate
    assert.strictEqual(v.eligibilityFor(RID, pairs2).state, 'confirmed', 'the background read lands for the NEXT request');
    assert.deepStrictEqual(v.eligibilityFor(RID, []), { state: 'unknown', reason: 'no_identity_pairs' });
    assert.deepStrictEqual(v.eligibilityFor(RID, [{ kind: 'dish', canonicalId: '..', legacyKey: 'x' }]), { state: 'unknown', reason: 'malformed_pair' });
  }
  ok('eligibilityFor never awaits: a miss is unknown immediately and starts a bounded read; the global cap holds; no pairs / a malformed pair → unknown');

  // 7. A full catalog batch (la_musa: 44 dishes + 14 extras = 58 objects) in ONE coherent read.
  {
    const snap = catalogSnapshot('la_musa');
    const all = [...snap.items.map((i) => ({ kind: 'dish', canonicalId: i.key, legacyKey: i.key })), ...snap.extras.map((e) => ({ kind: 'extra', canonicalId: e.key, legacyKey: e.key }))];
    assert.strictEqual(all.length, 58, 'premise — the 58-object catalog');
    let rows = {};
    for (const p of all) rows = { ...rows, ...live(p.kind, p.canonicalId, p.legacyKey) };
    const db = fakeDb(rows);
    const v = V.createCatalogVerifier({ db, now: () => 1, log: () => {} });
    const r = await v.verify(RID, all);
    assert.strictEqual(r.state, 'confirmed');
    assert.strictEqual(db.reads.length, 1, 'ONE coherent read');
    assert.strictEqual(db.reads[0].length, 58 * 3, 'own-kind id row + other-kind id row + key row per object');
  }
  ok('a full 58-object batch is confirmed from ONE coherent read of 174 documents');

  console.log(`catalog-verifier: OK (${n})`);
})().catch((e) => { console.error('catalog-verifier FAILED:', e); process.exit(1); });
