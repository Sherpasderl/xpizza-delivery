'use strict';
// Portal 1D · D4-a — SAFETY UNDER SUSPENSION (PLAN-D4a-ERRATA E4, owner-approved option A).
//
// On Cloud Functions a detached background read gets no CPU after its invocation ends and resumes in a
// later one. This suite stages exactly that with a FAKE CLOCK and gated fakes, for every request-side
// background path — discovery, build, persisted load, verifier observe:
//   • SUSPEND: initiate, advance the clock beyond the deadline AND beyond the TTL before the read
//     resolves, then resolve → DISCARDED (nothing cached as fresh), and the next request RE-INITIATES.
//     The real deadline timers are set far in the future, so only the EXPLICIT initiation-relative check
//     can discard — the "timer-only" defect would pass the late data through.
//   • RESUME IN TIME: resolve within the deadline → accepted, stamped with the INITIATION time.
//   • a verifier observation stamped at initiation expires on time.
// Plus the rate-limited `context_attach_stats` diagnostic.
const assert = require('assert');
const { createContextSource } = require('./context-source');
const { createCatalogVerifier } = require('./catalog-verifier');
const { persistedNode } = require('./context-writer');
const { contentHash } = require('./content-hash');
const { catalogSnapshot } = require('./generate-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const tick = () => new Promise((r) => setTimeout(r, 5));
const DEADLINE = 3000, TTL = 45000;           // fake-clock ms; the REAL timers below are given 10 minutes

// ── One certified version as raw data (the same shape the real readers return) ─────────────────────
const RID = 'rid_s', V = 'v-s';
const snap = JSON.parse(JSON.stringify(catalogSnapshot('x_pizza')));
snap.items.forEach((it, i) => { it.display.identity_id = `D${String(i).padStart(9, '0')}`; });
snap.extras.forEach((ex, i) => { ex.display.identity_id = `E${String(i).padStart(9, '0')}`; });
const order = (recs, ord) => ord.map((k) => recs.find((r) => r.key === k));
const record = { version: V, seq: 4, schema_version: 2, identity_certified: true, identity_revision: 1,
  content_hash: contentHash({ rid: RID, schema_version: 2, items: order(snap.items, snap.structure.item_order), extras: order(snap.extras, snap.structure.extra_order), structure: snap.structure }) };
const rows = (recs) => recs.map((r, i) => ({ id: `d${String(i).padStart(3, '0')}`, data: { key: r.key, price: r.price, display: r.display } }));
const ITEMS = rows(snap.items), EXTRAS = rows(snap.extras);
const UT = { seconds: 1700000000, nanoseconds: 9 };
const PRICES = { menu: Object.fromEntries(snap.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(snap.extras.map((e) => [e.key, e.price])) };
const SERVED = { rid: RID, versionId: V, seq: 4, source: 'live', prices: PRICES };
const NODE = { ...persistedNode({ rid: RID, versionId: V, record, items: ITEMS, extras: EXTRAS, structure: snap.structure, fk: { generation: 2, revision: 1, updateTime: UT } }), at: 1 };

// A gate that holds an operation until the test releases it. `held` counts operations waiting.
function gate() {
  let open = null; const g = { on: false, held: 0, release: () => { if (open) open(); } };
  g.wait = () => { if (!g.on) return Promise.resolve(); g.held += 1; return new Promise((r) => { open = () => { g.on = false; r(); }; }); };
  return g;
}
// Fake Firestore: doc gets (discovery) and transactions (build + verifier) each have their own gate.
function fakeFs({ registry = {} } = {}) {
  const g = { doc: gate(), tx: gate() }; const count = { doc: 0, tx: 0 };
  const vpath = `restaurants/${RID}/versions/${V}`;
  const docSnap = (path) => {
    if (path === vpath) return { exists: true, data: () => record, updateTime: UT };
    if (path === `${vpath}/meta/menu_structure`) return { exists: true, data: () => snap.structure };
    if (registry[path]) return { exists: true, data: () => registry[path] };
    return { exists: false, data: () => undefined };
  };
  const colSnap = (path) => ({ docs: (path.endsWith('/menu_items') ? ITEMS : path.endsWith('/extras') ? EXTRAS : []).map((r) => ({ id: r.id, data: () => r.data })) });
  const ref = (path) => ({ path, collection: (c) => ref(`${path}/${c}`), doc: (d) => ref(`${path}/${d}`),
    get: async () => { count.doc += 1; await g.doc.wait(); return docSnap(path); } });
  return {
    g, count,
    collection: (c) => ref(c), doc: (p) => ref(p),
    runTransaction: async (fn) => { count.tx += 1; const r = await fn({ get: async (x) => (x.path.split('/').length % 2 === 0 ? docSnap(x.path) : colSnap(x.path)), getAll: async (...xs) => xs.map((x) => docSnap(x.path)) }); await g.tx.wait(); return r; },
  };
}
function fakeRtdb() {
  const g = gate(); const count = { get: 0 };
  return { g, count, ref: () => ({ get: async () => { count.get += 1; await g.wait(); return { val: () => NODE }; } }) };
}
const mk = (opts = {}) => {
  const clock = { t: 1000 };
  const fs = fakeFs(opts), rt = fakeRtdb();
  const logs = [];
  const src = createContextSource({ db: fs, rtdb: rt, verifier: null, now: () => clock.t, readDeadlineMs: DEADLINE, recordTtlMs: TTL,
    log: (k, d) => logs.push({ k, d }) });
  return { clock, fs, rt, src, logs };
};
// The REAL deadline timers must not be what discards: the source above uses DEADLINE for its timers too,
// which is 3s of REAL time — the suspend cells release long before that.

(async () => {
  // ═══ DISCOVERY ═════════════════════════════════════════════════════════════════════════════════════
  {
    const { clock, fs, src } = mk();
    fs.g.doc.on = true;
    const p = src.discover(RID, V);
    await tick(); assert.strictEqual(fs.g.doc.held, 1, 'premise — the read is in flight');
    clock.t += DEADLINE + TTL;                                    // SUSPENDED past the deadline and the TTL
    fs.g.doc.release();
    assert.strictEqual(await p, null, '🔴 a completion past its deadline (timer unfired) must be discarded');
    assert.strictEqual(src._state.discovered.size, 0, 'nothing cached as fresh');
    assert.strictEqual(src._state.discFlights.size, 0, 'the flight is released');
    assert.strictEqual(src.stats.lateDiscards, 1);
    src.resolve(SERVED); await tick();
    assert.strictEqual(fs.count.doc, 2, 'the NEXT request re-initiates the read');
    // RESUME IN TIME: accepted, stamped with the INITIATION time.
    const b = mk(); b.fs.g.doc.on = true;
    const t0 = b.clock.t;
    const q = b.src.discover(RID, V);
    await tick(); b.clock.t += DEADLINE - 1; b.fs.g.doc.release();
    assert.ok(await q, 'accepted within the deadline');
    assert.strictEqual([...b.src._state.discovered.values()][0].at, t0, '🔴 discovery is stamped at INITIATION, not completion');
  }
  ok('discovery: suspended past deadline + TTL → discarded (timer unfired), nothing cached, the next request re-initiates; resumed in time → accepted, stamped at initiation');

  // ═══ BUILD ═════════════════════════════════════════════════════════════════════════════════════════
  {
    const { clock, fs, src } = mk();
    fs.g.tx.on = true;
    const p = src.build(RID, V);
    await tick(); assert.strictEqual(fs.g.tx.held, 1);
    clock.t += DEADLINE + TTL;
    fs.g.tx.release();
    assert.strictEqual(await p, null, '🔴 a late build is discarded');
    assert.strictEqual(src._state.built.size, 0, 'nothing cached as fresh'); assert.strictEqual(src._state.discovered.size, 0);
    const r = src.resolve(SERVED);
    assert.strictEqual(r.availability, 'unavailable', 'nothing stale is reported');
    await tick(); assert.strictEqual(fs.count.tx, 2, 'the next request re-initiates the build');
    const b = mk(); b.fs.g.tx.on = true; const t0 = b.clock.t;
    const q = b.src.build(RID, V);
    await tick(); b.clock.t += DEADLINE - 1; b.fs.g.tx.release();
    const built = await q;
    assert.ok(built); assert.strictEqual(built.observedAt, t0, '🔴 the built context carries the INITIATION stamp');
    assert.strictEqual([...b.src._state.discovered.values()][0].at, t0, '…and so does the discovery it implies');
  }
  ok('build: suspended past deadline + TTL → discarded, not cached, unavailable reported, the next request re-initiates; resumed in time → accepted with the initiation stamp');

  // ═══ PERSISTED LOAD (mirror routes) ════════════════════════════════════════════════════════════════
  {
    const { clock, rt, src } = mk();
    rt.g.on = true;
    const p = src.loadPersisted(RID);
    await tick(); assert.strictEqual(rt.g.held, 1);
    clock.t += DEADLINE + TTL;
    rt.g.release();
    assert.strictEqual(await p, null, '🔴 a late persisted load is discarded');
    assert.strictEqual(src._state.persisted.size, 0, 'nothing cached as fresh');
    const mirror = { ...SERVED, source: 'mirror' };
    assert.strictEqual(src.resolve(mirror).availability, 'unavailable');
    await tick(); assert.strictEqual(rt.count.get, 2, 'the next request re-initiates');
    const b = mk(); b.rt.g.on = true; const t0 = b.clock.t;
    const q = b.src.loadPersisted(RID);
    await tick(); b.clock.t += DEADLINE - 1; b.rt.g.release();
    assert.ok(await q);
    const entry = b.src._state.persisted.get(RID);
    assert.strictEqual(entry.at, t0, '🔴 the persisted node is stamped at INITIATION');
    assert.strictEqual(entry.ctx.observedAt, t0, '…and so is its rebuilt context');
    // and the TTL is measured from that stamp: at t0 + TTL - 1 no reload; at t0 + TTL a reload starts
    b.clock.t = t0 + TTL - 1; b.src.resolve(mirror); await tick(); assert.strictEqual(b.rt.count.get, 1);
    b.clock.t = t0 + TTL; b.src.resolve(mirror); await tick(); assert.strictEqual(b.rt.count.get, 2, 'refreshed one TTL after INITIATION');
  }
  ok('persisted load: suspended past deadline + TTL → discarded, not cached, the next request re-initiates; resumed in time → node and context stamped at initiation, TTL measured from it');

  // ═══ VERIFIER OBSERVE ══════════════════════════════════════════════════════════════════════════════
  {
    const pairs = [{ kind: 'dish', canonicalId: 'ID1', legacyKey: 'K1' }];
    const reg = { 'restaurants/R/identity/dish/ids/ID1': { legacy_key: 'K1', status: 'live', kind: 'dish' } };
    reg[`restaurants/R/identity/dish/keys/${Buffer.from('K1').toString('base64url')}`] = { canonical_id: 'ID1', kind: 'dish' };
    const clock = { t: 1000 };
    const fs = fakeFs({ registry: reg });
    const v = createCatalogVerifier({ db: fs, now: () => clock.t, ttlMs: 60000, timeoutMs: DEADLINE, log: () => {} });
    fs.g.tx.on = true;
    const p = v.verify('R', pairs);
    await tick(); assert.strictEqual(fs.g.tx.held, 1);
    clock.t += DEADLINE + 60000;
    fs.g.tx.release();
    const r = await p;
    assert.strictEqual(r.state, 'unknown', '🔴 a late observation is discarded — never the basis of `confirmed`');
    assert.strictEqual(v._cache.size, 0, 'nothing cached'); assert.strictEqual(v._inflight.size, 0);
    v.eligibilityFor('R', pairs); await tick();
    assert.strictEqual(fs.count.tx, 2, 'the next request re-initiates the observation');
    // RESUME IN TIME + expiry from initiation
    const clock2 = { t: 5000 };
    const fs2 = fakeFs({ registry: reg });
    const v2 = createCatalogVerifier({ db: fs2, now: () => clock2.t, ttlMs: 60000, timeoutMs: DEADLINE, log: () => {} });
    fs2.g.tx.on = true;
    const q = v2.verify('R', pairs);
    await tick(); clock2.t += DEADLINE - 1; fs2.g.tx.release();
    const ok2 = await q;
    assert.strictEqual(ok2.state, 'confirmed'); assert.strictEqual(ok2.observedAt, 5000, '🔴 observedAt is the INITIATION');
    clock2.t = 5000 + 60000;
    assert.strictEqual(v2.eligibilityFor('R', pairs, { startRead: false }).state, 'confirmed', 'valid through observedAt + TTL');
    clock2.t = 5000 + 60001;
    assert.strictEqual(v2.eligibilityFor('R', pairs, { startRead: false }).state, 'unknown', '🔴 expired from initiation — never `confirmed`');
  }
  ok('verifier: an observation suspended past its deadline is discarded (never cached, never confirmed) and the next request re-initiates; one resumed in time is stamped at initiation and expires exactly one TTL after it');

  // ═══ An expired observation is never `confirmed` through the context either ═══════════════════════
  {
    const { clock, src } = mk();
    const fake = { stateAt: null, eligibilityFor: () => ({ state: 'confirmed', observedAt: 0, expiresAt: clock.t + 10 }) };
    const s2 = createContextSource({ db: src._db || fakeFs(), rtdb: fakeRtdb(), verifier: fake, now: () => clock.t, readDeadlineMs: DEADLINE, recordTtlMs: TTL, log: () => {} });
    s2.resolve(SERVED); await tick(); await tick();
    const fresh = s2.resolve(SERVED);
    assert.strictEqual(fresh.usableAsIdentity, true, 'premise — usable while unexpired');
    fake.eligibilityFor = () => ({ state: 'confirmed', observedAt: 0, expiresAt: clock.t - 1 });
    assert.strictEqual(s2.resolve(SERVED).usableAsIdentity, false, '🔴 a confirmation past its expiry never makes the context usable');
  }
  ok('a confirmation past its expiry never makes a context usable-as-identity');

  // ═══ context_attach_stats — counts by availability/reason/route, at most once per 10 min ═════════════
  {
    const { clock, src, logs } = mk();
    for (let i = 0; i < 3; i += 1) src.resolve({ ...SERVED, versionId: null });          // flat
    src.resolve({ ...SERVED, source: 'mirror' });                                       // not persisted
    assert.strictEqual(logs.filter((l) => l.k === 'context_attach_stats').length, 0, 'nothing before 10 min');
    clock.t += 10 * 60 * 1000;
    src.resolve({ ...SERVED, versionId: null });
    const em = logs.filter((l) => l.k === 'context_attach_stats');
    assert.strictEqual(em.length, 1);
    assert.deepStrictEqual(em[0].d.counts, { 'unavailable|flat|live': 4, 'unavailable|context_not_persisted|mirror': 1 });
    src.resolve({ ...SERVED, versionId: null });
    assert.strictEqual(logs.filter((l) => l.k === 'context_attach_stats').length, 1, 'rate-limited: no second emission within 10 min');
    clock.t += 10 * 60 * 1000; src.resolve({ ...SERVED, versionId: null });
    const em2 = logs.filter((l) => l.k === 'context_attach_stats');
    assert.strictEqual(em2.length, 2); assert.deepStrictEqual(em2[1].d.counts, { 'unavailable|flat|live': 2 }, 'counts are SINCE the last emission');
  }
  ok('context_attach_stats: counts by availability|reason|route since the last emission, emitted at most once per instance per 10 min');

  console.log(`context-suspension: OK (${n})`);
  process.exit(0);   // the source's real deadline timers (3s) are irrelevant once every cell has finished
})().catch((e) => { console.error('context-suspension FAILED:', e); process.exit(1); });
