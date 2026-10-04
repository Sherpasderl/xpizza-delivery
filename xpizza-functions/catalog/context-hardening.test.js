'use strict';   // strict mode: a write to a frozen object THROWS, so "has no effect" cannot pass silently
// Portal 1D · D4-a — the codex build r1 fixes, pinned:
//   F1 the context graph is DEEP-frozen before it is cached or exposed (cross-request mutation)
//   F3 single-flight entries are registered before any SDK call (synchronous-throw poisoning)
//   F4 the mirror route rebuilds in the background, memoized per node; resolve() does no rebuild
// Fakes stand in for Firestore/RTDB so synchronous throws and builder calls are exact; the same paths
// run against the real emulators in test/catalog-context.emulator.test.js.
const assert = require('assert');
const { createContextSource } = require('./context-source');
const { createCatalogVerifier } = require('./catalog-verifier');
const { createContextWriter, persistedNode } = require('./context-writer');
const { buildContext } = require('./catalog-context');
const { createCatalogReader } = require('./catalog');
const { createPricingResolver, envelopeOf, contextOf } = require('./pricing-tables');
const { contentHash } = require('./content-hash');
const { catalogSnapshot } = require('./generate-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = () => {};

// ── A certified, fully stamped x_pizza version as raw Firestore data ─────────────────────────────
const RID = 'rid_h', V = 'v-h';
const snap = JSON.parse(JSON.stringify(catalogSnapshot('x_pizza')));
snap.items.forEach((it, i) => { it.display.identity_id = `D${String(i).padStart(9, '0')}`; });
snap.extras.forEach((ex, i) => { ex.display.identity_id = `E${String(i).padStart(9, '0')}`; });
const order = (recs, ord) => ord.map((k) => recs.find((r) => r.key === k));
const record = { version: V, seq: 4, schema_version: 2, identity_certified: true, identity_revision: 1,
  content_hash: contentHash({ rid: RID, schema_version: 2, items: order(snap.items, snap.structure.item_order), extras: order(snap.extras, snap.structure.extra_order), structure: snap.structure }) };
const rows = (recs) => recs.map((r, i) => ({ id: `d${String(i).padStart(3, '0')}`, data: { key: r.key, price: r.price, display: r.display } }));
const ITEMS = rows(snap.items), EXTRAS = rows(snap.extras);
const UPDATE_TIME = { seconds: 1700000000, nanoseconds: 5 };
const PRICES = { menu: Object.fromEntries(snap.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(snap.extras.map((e) => [e.key, e.price])) };
const SERVED = { rid: RID, versionId: V, seq: 4, source: 'live', prices: PRICES };

// A minimal Firestore: refs are paths; `throwSync` makes the next N SDK entry calls throw SYNCHRONOUSLY.
function fakeFs({ throwSync = 0 } = {}) {
  const state = { throwSync, docGets: 0, txs: 0 };
  const boom = () => { if (state.throwSync > 0) { state.throwSync -= 1; throw new Error('SDK sync throw'); } };
  const vpath = `restaurants/${RID}/versions/${V}`;
  const docSnap = (path) => {
    if (path === vpath) return { exists: true, data: () => record, updateTime: UPDATE_TIME };
    if (path === `${vpath}/meta/menu_structure`) return { exists: true, data: () => snap.structure };
    return { exists: false, data: () => undefined };
  };
  const colSnap = (path) => ({ docs: (path.endsWith('/menu_items') ? ITEMS : path.endsWith('/extras') ? EXTRAS : []).map((r) => ({ id: r.id, data: () => r.data })) });
  const ref = (path) => ({ path, collection: (c) => ref(`${path}/${c}`), doc: (d) => ref(`${path}/${d}`),
    get: () => { boom(); state.docGets += 1; return Promise.resolve(path.split('/').length % 2 === 0 ? docSnap(path) : colSnap(path)); } });
  return {
    state,
    collection: (c) => ref(c),
    doc: (p) => ref(p),
    runTransaction: (fn) => { boom(); state.txs += 1; return fn({ get: (r) => Promise.resolve(r.path.split('/').length % 2 === 0 ? docSnap(r.path) : colSnap(r.path)), getAll: async (...rs) => rs.map((r) => docSnap(r.path)) }); },
  };
}
function fakeRtdb(node, { throwSync = 0 } = {}) {
  const state = { throwSync, gets: 0, node };
  return { state, ref: () => ({ get: () => { if (state.throwSync > 0) { state.throwSync -= 1; throw new Error('RTDB sync throw'); } state.gets += 1; return Promise.resolve({ val: () => state.node }); } }) };
}
const until = async (cond, label) => { for (let i = 0; i < 200; i += 1) { if (await cond()) return; await wait(5); } throw new Error(`timed out: ${label}`); };

// Every object/array in a graph, with its path — to prove EVERY level is frozen and no Set/Map hides in it.
function walk(v, path = '$', out = []) {
  if (v === null || typeof v !== 'object') return out;
  out.push([path, v]);
  for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`, out);
  return out;
}

(async () => {
  // ═══ F1 — DEEP FREEZE, ACROSS REQUESTS ════════════════════════════════════════════════════════
  {
    const src = createContextSource({ db: fakeFs(), rtdb: fakeRtdb(null), verifier: null, log: silent });
    src.resolve(SERVED);
    await until(() => src._state.built.size > 0, 'built');
    const c1 = src.resolve(SERVED);
    assert.strictEqual(c1.attached, true, 'premise — attached');
    const nodes = walk(c1);
    assert.ok(nodes.length > 2 * c1.objects.length, `premise — a real graph: every object and its policy (${nodes.length} objects/arrays)`);
    for (const [p, v] of nodes) {
      assert.ok(Object.isFrozen(v), `🔴 ${p} is not frozen`);
      assert.ok(!(v instanceof Set) && !(v instanceof Map), `🔴 ${p} is a Set/Map (freezing does not stop .add)`);
    }
    for (const [p, v] of walk([...src._state.built.values()][0])) assert.ok(Object.isFrozen(v), `🔴 cached ${p} is not frozen`);
    // Every mutation attempt THROWS (strict mode) — the codex reproduction first.
    const attempts = [
      ['an object\'s price', () => { c1.objects[0].price = 1; }],
      ['an object\'s label', () => { c1.objects[0].label = 'tampered'; }],
      ['an object\'s canonicalId', () => { c1.objects[1].canonicalId = 'X'; }],
      ['a policy membership', () => { c1.objects[0].policy.weekend_only = !c1.objects[0].policy.weekend_only; }],
      ['the objects array', () => { c1.objects.push({}); }],
      ['coverage', () => { c1.coverage.dish.covered = 0; }],
      ['labels.missing', () => { c1.labels.missing.push({}); }],
      ['ids.problems', () => { c1.ids.problems.push({}); }],
      ['policyRules provenance', () => { c1.policyRules.weekend_only.provenance.push('x'); }],
      ['contentIntegrity', () => { c1.contentIntegrity.state = 'intact'; }],
      ['registryEligibility', () => { c1.registryEligibility.state = 'confirmed'; }],
      ['a top-level field', () => { c1.usableAsIdentity = true; }],
    ];
    for (const [what, fn] of attempts) assert.throws(fn, TypeError, `🔴 mutating ${what} did not throw`);
    // …and the NEXT request is unaffected: its objects still carry the served prices.
    const c2 = src.resolve(SERVED);
    assert.strictEqual(c2.attached, true);
    assert.strictEqual(c2.contentIntegrity.state, 'intact');
    for (const o of c2.objects) assert.strictEqual(o.price, PRICES[o.kind === 'dish' ? 'menu' : 'extras'][o.legacyKey], `${o.legacyKey}: price intact on the next request`);
    assert.strictEqual(c2.objects[0].label, snap.items.find((i) => i.key === c2.objects[0].legacyKey).display.name);
    // the unavailable projections are frozen too
    const u = src.resolve({ ...SERVED, versionId: 'v-other' });
    for (const [p, v] of walk(u)) assert.ok(Object.isFrozen(v), `unavailable ${p}`);
    // the pure builder's own output is deep-frozen (its consumers include the writer's integrity check)
    for (const [p, v] of walk(buildContext({ rid: RID, versionId: V, record, items: ITEMS, extras: EXTRAS, structure: snap.structure }))) assert.ok(Object.isFrozen(v), `builder ${p}`);
    ok(`F1: every one of ${nodes.length} objects/arrays in an attached context is frozen (no Set/Map); ${attempts.length} mutation attempts each THROW, and the next request still reports the served prices and labels`);
  }

  // ═══ F3 — A SYNCHRONOUS SDK THROW NEVER POISONS A SINGLE-FLIGHT ENTRY ═══════════════════════════
  {
    // discovery + build (context source): first attempts throw synchronously, then recovery.
    const fsx = fakeFs({ throwSync: 2 });
    const src = createContextSource({ db: fsx, rtdb: fakeRtdb(null), verifier: null, log: silent });
    assert.strictEqual(await src.discover(RID, V), null, 'a sync throw → null, not a crash');
    assert.strictEqual(src._state.discFlights.size, 0, '🔴 the discovery flight was removed');
    assert.strictEqual(await src.build(RID, V), null);
    assert.strictEqual(src._state.buildFlights.size, 0, '🔴 the build flight was removed');
    assert.ok(await src.discover(RID, V), 'the NEXT discovery runs and succeeds');
    assert.ok(await src.build(RID, V), 'the NEXT build runs and succeeds');
    assert.strictEqual(src.resolve(SERVED).attached, true, 'and the context attaches');
    // persisted-node load (RTDB)
    const node = { ...persistedNode({ rid: RID, versionId: V, record, items: ITEMS, extras: EXTRAS, structure: snap.structure,
      fk: { generation: 2, revision: 1, updateTime: UPDATE_TIME } }), at: 1 };
    const rt = fakeRtdb(node, { throwSync: 1 });
    const src2 = createContextSource({ db: fakeFs(), rtdb: rt, verifier: null, log: silent });
    assert.strictEqual(await src2.loadPersisted(RID), null);
    assert.strictEqual(src2._state.persisted.size, 0);
    assert.ok(await src2.loadPersisted(RID), 'the NEXT persisted load runs');
    assert.strictEqual(rt.state.gets, 1);
    // the verifier: FOUR synchronous failures must not exhaust its cap of 4.
    const vfs = fakeFs({ throwSync: 4 });
    const v = createCatalogVerifier({ db: vfs, now: () => 1, maxInflight: 4, log: silent });
    for (let i = 0; i < 4; i += 1) {
      const r = await v.verify(RID, [{ kind: 'dish', canonicalId: `C${i}`, legacyKey: `K${i}` }]);
      assert.strictEqual(r.state, 'unknown');
    }
    assert.strictEqual(v._inflight.size, 0, '🔴 four sync failures left dead entries in the in-flight map');
    const fifth = await v.verify(RID, [{ kind: 'dish', canonicalId: 'C9', legacyKey: 'K9' }]);
    assert.strictEqual(v.stats.capped, 0, 'the cap was never consumed'); assert.strictEqual(vfs.state.txs, 1, 'the fifth read actually ran');
    assert.strictEqual(fifth.state, 'rejected', 'and reached a verdict (the fake registry has no rows → missing_id_row)');
    // the writer: a synchronous throw on its first SDK call → failed, flight released, next attempt runs.
    const wfs = fakeFs({ throwSync: 1 });
    const w = createContextWriter({ db: wfs, rtdb: fakeRtdb(null), log: silent, deadlineMs: 500 });
    const r1 = await w.writeActiveContext(RID);
    assert.strictEqual(r1.outcome, 'failed'); assert.strictEqual(w._flights.size, 0, '🔴 writer flight removed');
    const r2 = await w.writeActiveContext(RID);
    assert.notStrictEqual(r2.error, r1.error, 'the next attempt ran (a different failure: the fake has no pointer doc)');
    ok('F3: a synchronous SDK throw in discovery, build, persisted load, the verifier and the writer leaves no in-flight entry; each NEXT attempt runs; four verifier failures do not consume its cap of 4');
  }

  // ═══ F4 — THE MIRROR ROUTE: rebuilt in the background, memoized per node; resolve() never rebuilds ═══
  {
    let builds = 0;
    const countingBuild = (raw) => { builds += 1; return buildContext(raw); };
    const node = { ...persistedNode({ rid: RID, versionId: V, record, items: ITEMS, extras: EXTRAS, structure: snap.structure,
      fk: { generation: 2, revision: 1, updateTime: UPDATE_TIME } }), at: 1 };
    const rt = fakeRtdb(node);
    let t = 0;
    const src = createContextSource({ db: fakeFs(), rtdb: rt, verifier: null, now: () => t, buildContext: countingBuild, log: silent });
    const mirrorServed = { ...SERVED, source: 'mirror' };
    assert.strictEqual(src.resolve(mirrorServed).availability, 'unavailable', 'cold: not loaded yet');
    await until(() => src._state.persisted.size > 0, 'loaded');
    assert.strictEqual(builds, 1, 'rebuilt ONCE, in the background loader');
    const N = 500;
    const t0 = process.hrtime.bigint();
    let last;
    for (let i = 0; i < N; i += 1) last = src.resolve(mirrorServed);
    const perCallUs = Number(process.hrtime.bigint() - t0) / 1000 / N;
    assert.strictEqual(builds, 1, `🔴 resolve() rebuilt the context (${builds - 1} extra builder calls over ${N} requests)`);
    assert.strictEqual(last.attached, true); assert.strictEqual(last.contentIntegrity.state, 'intact', 'still the raw rebuild, re-checked');
    // Timing partner: one builder call (what each request used to pay) vs one cached resolve().
    const b0 = process.hrtime.bigint(); for (let i = 0; i < 20; i += 1) buildContext(JSON.parse(JSON.stringify({ rid: RID, versionId: V, record, items: ITEMS, extras: EXTRAS, structure: snap.structure }))); const perBuildUs = Number(process.hrtime.bigint() - b0) / 1000 / 20;
    assert.ok(perCallUs < 1000, `a cached mirror resolve() is bounded: ${perCallUs.toFixed(1)}µs per call`);
    assert.ok(perCallUs * 3 < perBuildUs, `…and well below a rebuild (${perCallUs.toFixed(1)}µs vs ${perBuildUs.toFixed(1)}µs)`);
    // Memoized per EXACT node: the same node reloaded → no rebuild; a payload changed under the SAME FK → rebuilt and re-judged.
    t += 45000; src.resolve(mirrorServed); await wait(20);
    assert.strictEqual(rt.state.gets, 2, 'premise — reloaded after the TTL'); assert.strictEqual(builds, 1, 'same node → the memo is reused');
    const tampered = JSON.parse(node.payload); tampered.items[0].data.display.name += ' (tampered)';
    rt.state.node = { ...node, payload: JSON.stringify(tampered) };
    t += 45000; src.resolve(mirrorServed); await wait(20);
    assert.strictEqual(builds, 2, 'a changed payload under the same FK is rebuilt');
    assert.strictEqual(src.resolve(mirrorServed).contentIntegrity.state, 'mismatch', '…and re-judged: mismatch');
    ok(`F4: the mirror route rebuilds once per persisted node in the background; ${N} cached resolve() calls made 0 builder calls (${perCallUs.toFixed(1)}µs each vs ${perBuildUs.toFixed(1)}µs per rebuild); an unchanged reload reuses the memo, a payload changed under the same FK is rebuilt → mismatch`);
  }

  // ═══ F1 RESIDUAL (codex build r2) — the ENVELOPE records independent, deep-frozen copies of the prices ═══
  {
    // The REAL reader + resolver: a warm hit hands back the SAME cached table objects, which is exactly
    // the alias the envelope used to hold.
    const reader = createCatalogReader({
      getRestaurantDocs: async () => ({ versionId: V, seq: 4, itemDocs: snap.items.map((i) => ({ key: i.key, price: i.price })), extraDocs: snap.extras.map((e) => ({ key: e.key, price: e.price })) }),
      getActiveVersionId: async () => V,
    });
    const src = createContextSource({ db: fakeFs(), rtdb: fakeRtdb(null), verifier: null, log: silent });
    const seen = [];
    const res = createPricingResolver({ reader, alarm: silent, context: { resolve: (x) => { seen.push(x.prices); return src.resolve(x); } } });
    await res.getPricingTables(RID);
    await until(() => src._state.built.size > 0, 'built');
    const t1 = await res.getPricingTables(RID);
    const env = envelopeOf(t1);
    assert.strictEqual(contextOf(t1).attached, true, 'premise — attached');
    const key = snap.items[0].key, price = snap.items[0].price;
    // (a) every object reachable from the envelope is frozen
    const envNodes = walk(env);
    for (const [p, v] of envNodes) assert.ok(Object.isFrozen(v), `🔴 envelope ${p} is not frozen`);
    assert.notStrictEqual(env.prices.menu, t1.menu, '🔴 the envelope must not ALIAS the returned (cached) menu');
    assert.notStrictEqual(env.prices.extras, t1.extras, '🔴 …nor the extras');
    assert.strictEqual(seen[seen.length - 1], env.prices, 'the context judged attachment against EXACTLY the prices the envelope records');
    // (c) the legacy returned tables are NOT frozen — legacy behaviour pinned
    assert.strictEqual(Object.isFrozen(t1), false); assert.strictEqual(Object.isFrozen(t1.menu), false); assert.strictEqual(Object.isFrozen(t1.extras), false);
    // (b1) a write THROUGH THE ENVELOPE throws and changes nothing: not the returned tables, not the cache, not the next request
    assert.throws(() => { env.prices.menu[key] = 1; }, TypeError, '🔴 the envelope accepted a write');
    assert.throws(() => { env.prices.extras[snap.extras[0].key] = 1; }, TypeError);
    assert.strictEqual(t1.menu[key], price, 'the returned table is untouched');
    const t2 = await res.getPricingTables(RID);
    assert.strictEqual(t2.menu[key], price, '🔴 the next request\'s price is untouched');
    assert.strictEqual(contextOf(t2).attached, true);
    // (b2) a write through the LEGACY returned tables (today's behaviour, still allowed) does NOT reach the
    // envelope or the context recorded for that resolution
    t2.menu[key] = 999;
    assert.strictEqual(t2.menu[key], 999, 'premise — the legacy table is still writable, exactly as before');
    const env2 = envelopeOf(t2);
    assert.strictEqual(env2.prices.menu[key], price, '🔴 the envelope recorded the FINAL prices, not a live view');
    assert.strictEqual(contextOf(t2).objects.find((o) => o.legacyKey === key).price, price, 'the attached context is unchanged');
    assert.strictEqual(seen[seen.length - 1].menu[key], price, 'and so is what attachment was judged against');
    t2.menu[key] = price;                     // restore the (shared) cache for anything after this cell
    // cost: one flat copy of each table per resolution
    const N = 2000, big = { menu: Object.fromEntries(Array.from({ length: 58 }, (_, i) => [`k${i}`, 100 + i])), extras: {} };
    const r2 = createPricingResolver({ reader: { getTables: async () => ({ ...big, versionId: 'v', seq: 1 }) }, alarm: silent, context: { resolve: () => null } });
    const c0 = process.hrtime.bigint(); for (let i = 0; i < N; i += 1) await r2.getPricingTables('r'); const perUs = Number(process.hrtime.bigint() - c0) / 1000 / N;
    assert.ok(perUs < 200, `a whole resolution incl. the 58-entry copy stays cheap: ${perUs.toFixed(1)}µs`);
    ok(`F1 residual: all ${envNodes.length} objects reachable from envelopeOf() are frozen copies (not the cached tables); an envelope write throws and leaves the returned table, the cache and the next request at ${price}; a legacy write (still allowed, tables not frozen) does not reach the envelope or the context; a full 58-entry resolution costs ${perUs.toFixed(1)}µs`);
  }

  console.log(`context-hardening: OK (${n})`);
})().catch((e) => { console.error('context-hardening FAILED:', e); process.exit(1); });
