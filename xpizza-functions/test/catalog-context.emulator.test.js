'use strict';
// Portal 1D · D4-a — THE RESOLVED CATALOG CONTEXT, against the Firestore + RTDB EMULATORS.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-context
//
// The plan's writer × reader-revision × source × failure matrix (PLAN-D4a rev 9 "Tests", amended by
// PLAN-D4a-ERRATA E1/E2), on the REAL writers: publishVersion, rollbackVersion, bootstrapIdentityStamps,
// the unchanged makeRtdbMirror, the NEW context writer through BOTH invokers (the deployed trigger and
// reconciler, driven through their own `.run`), and the REAL attachment reader (the production pricing
// resolver + catalog reader + fallback ladder + context source + verifier). Expected values are written
// from the catalog snapshot, the Firestore records and the plan — never read back from the code under test.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
// index.js OWNS the app (it initializeApp()s at load); requiring it first is also the faithful wiring for
// the two invokers, which are exercised through the deployed function objects' own `.run`.
const app = require('../index.js');
const admin = require('firebase-admin');
const fs = admin.firestore();
const rtdb = admin.database();

const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize, sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { bootstrapIdentityStamps } = require('../catalog/identity-bootstrap');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer, getRestaurantDocs, getActiveVersionId } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { createCatalogReader } = require('../catalog/catalog');
const { createPricingResolver, envelopeOf, contextOf } = require('../catalog/pricing-tables');
const { createSnapshotFallback, makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const { createContextSource, CONTEXT_RECORD_TTL_MS } = require('../catalog/context-source');
const { createCatalogVerifier, idPath, keyPath } = require('../catalog/catalog-verifier');
const { createContextWriter, CONTEXT_PATH } = require('../catalog/context-writer');
const { identityPairs } = require('../catalog/catalog-context');
const { idsColOf, keysColOf, encodeKey } = require('../catalog/identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('catalog-context(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = () => {};
const logs = [];
const capture = (k, d) => logs.push({ k, d });

const vrefOf = (rid, v) => fs.collection('restaurants').doc(rid).collection('versions').doc(v);
const ctxNode = async (rid) => (await rtdb.ref(`${CONTEXT_PATH}/${rid}`).get()).val();
const tablesOf = (rid) => {
  const s = catalogSnapshot(rid);
  return { menu: Object.fromEntries(s.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(s.extras.map((e) => [e.key, e.price])) };
};

// ── Fixtures, built through the REAL writers (the d4p1-bootstrap recipe) ───────────────────────────
// A pre-P1 baseline: source seeded, published from code, activation record stripped, registry backfilled,
// then stripped to the pre-P1 shape (no stamps, no certification) so bootstrap meets what production had.
async function asPreP1(rid, versionId) {
  const vref = vrefOf(rid, versionId);
  for (const col of ['menu_items', 'extras']) {
    const snap = await vref.collection(col).get();
    await Promise.all(snap.docs.map((d) => {
      const display = (d.data() || {}).display;
      if (!display || display.identity_id === undefined) return null;
      const { identity_id, ...rest } = display;   // eslint-disable-line no-unused-vars
      return d.ref.update({ display: rest });
    }).filter(Boolean));
  }
  await vref.update({ identity_activation: admin.firestore.FieldValue.delete(), identity_certified: admin.firestore.FieldValue.delete() });
}
async function seedPreP1(rid, { dataFrom = rid } = {}) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(dataFrom)));
  const { input } = buildPublishCandidate(dataFrom, { activeVersionId: null }, { source_sha: `ctx-${rid}` });
  const res = await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await vrefOf(rid, res.versionId).update({ identity_activation: admin.firestore.FieldValue.delete() });
  await backfillIdentities(fs, rid, catalogSnapshot(dataFrom), { captured: await getActivePointer(fs, rid) });
  await asPreP1(rid, res.versionId);
  return res.versionId;
}
// A publish from the STORED SOURCE (what production does once certified — it carries the stamps).
async function publishFromSource(rid, sha, { mutate = null, dataRid = rid } = {}) {
  const src = (await sourceRefOf(fs, rid).get()).data();
  if (mutate) mutate(src);
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(dataRid, { formData: inputs.formData, priceTable: inputs.priceTable });
  const input = { items: built.items, structure: built.structure, extras: inputs.extras,
    extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })), source_sha: sha };
  const cur = await getActivePointer(fs, rid);
  return publishVersion(fs, rid, input, { expected: { activeVersionId: cur.version }, mirror: makeRtdbMirror(rtdb) });
}

// A production-shaped resolution stack with a CONTROLLED clock. `withContext:false` is the CONTROL: the
// same resolver exactly as it was before D4-a (no context source).
function stack({ now, withContext = true, sourceDb = fs, sourceRtdb = rtdb, verifierDb = fs, readerDb = fs, mirrorDb = rtdb, alarms = [], fail = { on: false } } = {}) {
  const clock = now || (() => Date.now());
  const guard = (fn) => (rid) => { if (fail.on) return Promise.reject(new Error('UNAVAILABLE: firestore down (test)')); return fn(rid); };
  const ladder = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(mirrorDb), alarm: (k, d) => alarms.push({ k, d }) });
  const verifier = createCatalogVerifier({ db: verifierDb, now: clock, log: capture });
  const source = createContextSource({ db: sourceDb, rtdb: sourceRtdb, verifier, now: clock, log: capture });
  const reader = createCatalogReader({ getRestaurantDocs: guard((rid) => getRestaurantDocs(readerDb, rid)), getActiveVersionId: guard((rid) => getActiveVersionId(readerDb, rid)), now: clock });
  const resolver = createPricingResolver({ reader, alarm: (k, d) => alarms.push({ k, d }), ladder, now: clock,
    ...(withContext ? { context: { resolve: (s) => source.resolve(s) } } : {}) });
  return { resolver, source, verifier, ladder, reader, alarms, fail };
}
// Let every background context read land (bounded): poll until `cond` or fail.
async function until(cond, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${label}`);
    await wait(25);
  }
}


// A Firestore / RTDB whose every operation NEVER settles — the "hung read" of the isolation cells.
const never = () => new Promise(() => {});
const hungRef = { doc: () => hungRef, collection: () => hungRef, get: never, child: () => hungRef };
const hungFs = { collection: () => hungRef, doc: () => hungRef, runTransaction: never };
const hungRtdb = { ref: () => hungRef };
// Swap two docs' display.identity_id in place (a persisted stamp swap with unchanged record metadata).
async function swapStamps(rid, versionId, col, [a, b]) {
  const docs = (await vrefOf(rid, versionId).collection(col).get()).docs;
  const da = docs.find((d) => d.data().key === a), db = docs.find((d) => d.data().key === b);
  const ia = da.data().display.identity_id, ib = db.data().display.identity_id;
  await da.ref.update({ 'display.identity_id': ib });
  await db.ref.update({ 'display.identity_id': ia });
  return async () => { await da.ref.update({ 'display.identity_id': ia }); await db.ref.update({ 'display.identity_id': ib }); };
}

// An RTDB whose context-path TRANSACTION waits at a gate (the read side is real). `arrived` resolves when
// a writer reaches the gate, so a cell can interleave other writes between a writer's consistent read and
// its fenced commit.
function gatedRtdb() {
  let open; const opened = new Promise((r) => { open = r; });
  let arrive; const arrived = new Promise((r) => { arrive = r; });
  return {
    open, arrived,
    db: { ref: (path) => { const r = rtdb.ref(path); return { get: (...a) => r.get(...a), child: (c) => r.child(c),
      transaction: async (...a) => { arrive(); await opened; return r.transaction(...a); } }; } },
  };
}
// A Firestore wrapper that COUNTS reads (an independent read-volume witness) and can hang chosen rids.
function countingFs({ hangRids = [] } = {}) {
  const counts = { docGets: 0, collectionGets: 0, transactions: 0 };
  const hang = (path) => hangRids.some((r) => path.startsWith(`restaurants/${r}/`) || path === `restaurants/${r}`);
  const wrapDoc = (real) => ({ _real: real, path: real.path, collection: (c) => wrapCol(real.collection(c)),
    get: () => { counts.docGets += 1; return hang(real.path) ? never() : real.get(); } });
  const wrapCol = (real) => ({ _real: real, path: real.path, doc: (d) => wrapDoc(real.doc(d)),
    get: () => { counts.collectionGets += 1; return hang(real.path) ? never() : real.get(); } });
  return {
    counts,
    collection: (c) => wrapCol(fs.collection(c)),
    doc: (p) => wrapDoc(fs.doc(p)),
    runTransaction: (fn, opts) => { counts.transactions += 1; return fs.runTransaction((tx) => fn({
      get: (w) => { if (w._real.constructor.name === 'CollectionReference') counts.collectionGets += 1; else counts.docGets += 1; return hang(w._real.path) ? never() : tx.get(w._real); },
      getAll: (...ws) => tx.getAll(...ws.map((w) => w._real || w)),
    }), opts); },
  };
}
const outcomeOf = async (p) => (await p).outcome;
const contextWriterRun = (rid, after) => app.writeCatalogContextOnMirror.run({ params: { rid }, data: { before: null, after: { val: () => after } } });

(async () => {
  // ═══ SETUP: x_pizza (to be certified), la_musa (uncertified, as in production), synthetic_3 (a 3rd brand) ═══
  const xV1 = await seedPreP1('x_pizza');
  const lV1 = await seedPreP1('la_musa');
  // A THIRD restaurant gets today's default key strategy (dishes keyed by NAME, menu-pricing.js:145 —
  // pre-existing brand debt, not D4-a's), so its fixture is name-keyed data under a new rid.
  const sV1 = await seedPreP1('synthetic_3', { dataFrom: 'x_pizza' });
  const boot = await bootstrapIdentityStamps(fs, 'x_pizza');
  assert.strictEqual(boot.stamped, true, 'premise — x_pizza certified through the REAL bootstrap');
  assert.strictEqual((await bootstrapIdentityStamps(fs, 'synthetic_3')).stamped, true, 'premise — synthetic_3 certified the same way');
  const xRec = (await vrefOf('x_pizza', xV1).get()).data();
  assert.strictEqual(xRec.identity_certified, true);
  assert.strictEqual(xRec.identity_revision, 1, 'bootstrap bumped identity_revision in its stamping transaction (plan step 6)');
  assert.strictEqual((await vrefOf('la_musa', lV1).get()).data().identity_certified, undefined, 'premise — la_musa is uncertified');
  ok(`fixtures through the real writers: x_pizza ${xV1.slice(-6)} and synthetic_3 ${sV1.slice(-6)} certified (revision 1), la_musa ${lV1.slice(-6)} uncertified`);

  // ═══ BOTH INVOKERS, THE REAL WRITER ═══════════════════════════════════════════════════════════════
  // The reconciler enumerates restaurants from Firestore (no list in code) and writes every context.
  await app.reconcileCatalogContexts.run({});
  for (const [rid, v] of [['x_pizza', xV1], ['la_musa', lV1], ['synthetic_3', sV1]]) {
    const node = await ctxNode(rid);
    const ptr = await getActivePointer(fs, rid);
    const recSnap = await vrefOf(rid, v).get();
    assert.ok(node && node.head, `${rid}: the reconciler wrote a context`);
    assert.strictEqual(node.head.versionId, v);
    assert.strictEqual(node.head.seq, recSnap.data().seq);
    assert.deepStrictEqual(node.head.fk, { generation: ptr.generation, revision: recSnap.data().identity_revision || 0,
      updateTime: { seconds: recSnap.updateTime.seconds, nanoseconds: recSnap.updateTime.nanoseconds } },
      `${rid}: HEAD.fk is (pointer generation, record identity_revision, record updateTime) — nanoseconds preserved`);
    assert.strictEqual(node.content_hash, recSnap.data().content_hash, 'the pinned hash is persisted beside the payload');
    assert.strictEqual(typeof node.payload, 'string', 'the RAW payload, persisted as one canonical string');
    assert.strictEqual(node.objects, undefined, 'derived objects are NEVER persisted');
  }
  assert.ok((await rtdb.ref('catalog_snapshot').get()).val().x_pizza.menu, 'premise — the legacy mirror is there too, written by the unchanged publisher');
  ok('reconciler (deployed handler): every restaurant enumerated from Firestore gets a context; HEAD.fk = (generation, revision, updateTime{s,ns}) exactly; raw payload + pinned hash, no derived objects');

  // The trigger: a wake-up on the legacy mirror path. A STALE event payload is ignored — the writer reads
  // the authoritative pointer itself.
  await rtdb.ref(`${CONTEXT_PATH}/la_musa`).remove();
  await app.writeCatalogContextOnMirror.run({ params: { rid: 'la_musa' }, data: { before: null, after: { val: () => ({ version: 'v-STALE', seq: -1 }) } } });
  assert.strictEqual((await ctxNode('la_musa')).head.versionId, lV1, 'the trigger wrote the CURRENT activation, not the stale event payload');
  ok('trigger (deployed handler): a stale wake-up event still writes the current activation (the payload is never trusted)');

  // ═══ THE LEGACY PRICE PROJECTION IS BYTE-IDENTICAL, ON EVERY SOURCE ═══════════════════════════════
  // A flat (un-migrated) restaurant for the `flat` route.
  const flatRef = fs.collection('restaurants').doc('flat_rid');
  await flatRef.set({ name: 'flat' });
  await flatRef.collection('menu_items').doc('a').set({ key: 'Alpha', price: 100 });
  await flatRef.collection('menu_items').doc('b').set({ key: 'Beta', price: 250 });
  await flatRef.collection('extras').doc('c').set({ key: 'Gamma', price: 30 });
  const expectTables = { x_pizza: tablesOf('x_pizza'), la_musa: tablesOf('la_musa'), synthetic_3: tablesOf('x_pizza'),
    flat_rid: { menu: { Alpha: 100, Beta: 250 }, extras: { Gamma: 30 } } };
  const routes = {};
  for (const rid of ['x_pizza', 'la_musa', 'synthetic_3', 'flat_rid']) {
    // control (no context) and D4-a, driven through the SAME sequence: live → last_good → (cold) mirror_cold → (seeded) mirror
    const seqOf = async (withContext) => {
      const out = [];
      let t = Date.now();
      const a = stack({ withContext, now: () => t });
      out.push(await a.resolver.getPricingTables(rid));                   // live (or flat)
      a.fail.on = true; t += 46000;                                       // past the pointer TTL: the outage is SEEN
      if (rid !== 'flat_rid') out.push(await a.resolver.getPricingTables(rid));   // last_good
      if (rid !== 'flat_rid') {
        const cold = stack({ withContext }); cold.fail.on = true;
        out.push(await cold.resolver.getPricingTables(rid));              // mirror_cold
        const warmish = stack({ withContext }); const p = await getActivePointer(fs, rid);
        warmish.ladder.recordActive(rid, p.version, (await vrefOf(rid, p.version).get()).data().seq); warmish.fail.on = true;
        out.push(await warmish.resolver.getPricingTables(rid));           // mirror (version-checked)
        out.alarms = [...a.alarms, ...cold.alarms, ...warmish.alarms].map((x) => x.k);
      } else out.alarms = a.alarms.map((x) => x.k);
      return out;
    };
    const control = await seqOf(false);
    const d4a = await seqOf(true);
    assert.strictEqual(JSON.stringify(d4a), JSON.stringify(control), `🔴 ${rid}: the prices a caller receives changed (bytes, key order, shape)`);
    assert.deepStrictEqual(d4a.alarms, control.alarms, `${rid}: identical alarms`);
    for (const t of d4a) assert.deepStrictEqual({ menu: t.menu, extras: t.extras }, expectTables[rid], `${rid}: the catalog's tables`);
    routes[rid] = d4a.map((t) => envelopeOf(t).source);
    for (const t of d4a) assert.deepStrictEqual(Object.keys(t), ['restaurantId', 'menu', 'extras'], 'no field was added to what callers receive');
  }
  assert.deepStrictEqual(routes.x_pizza, ['live', 'last_good', 'mirror_cold', 'mirror']);
  assert.deepStrictEqual(routes.flat_rid, ['flat']);
  assert.strictEqual(contextOf((await stack().resolver.getPricingTables('flat_rid'))).reason, 'flat', 'flat → context unavailable');
  // Sensitivity partner: an UPSTREAM price change moves both projections — the comparison is not vacuous.
  await flatRef.collection('menu_items').doc('b').set({ key: 'Beta', price: 275 });
  const [c2, d2] = [await stack({ withContext: false }).resolver.getPricingTables('flat_rid'), await stack().resolver.getPricingTables('flat_rid')];
  assert.strictEqual(c2.menu.Beta, 275); assert.strictEqual(JSON.stringify(d2), JSON.stringify(c2));
  ok(`legacy price projection byte-identical to the no-context CONTROL on live, flat, last_good, mirror and mirror_cold for 4 restaurants (same alarms, same shape, = the catalog tables); a 250→275 upstream change moves both`);

  // ═══ ATTACHMENT (live route) + ERRATA E2 — a context already cached attaches on THAT request ═══════
  const att = {};
  for (const rid of ['x_pizza', 'la_musa', 'synthetic_3']) {
    const st = stack();
    const first = contextOf(await st.resolver.getPricingTables(rid));
    assert.strictEqual(first.availability, 'unavailable', `${rid}: a cold instance reports unavailable for that request`);
    await until(() => st.source._state.built.size > 0, `${rid} context built`);
    const second = contextOf(await st.resolver.getPricingTables(rid));
    assert.strictEqual(second.attached, true, `🔴 ${rid}: a context already cached must attach on the same request (E2)`);
    assert.strictEqual(second.contentIntegrity.state, 'intact');
    assert.ok(Number.isFinite(second.contentIntegrity.observedAt), 'integrity carries its observedAt');
    if (rid !== 'la_musa') await until(() => st.verifier._cache.size > 0, `${rid} registry observed`);
    const third = contextOf(await st.resolver.getPricingTables(rid));
    att[rid] = third;
  }
  for (const rid of ['x_pizza', 'synthetic_3']) {
    const c = att[rid];
    assert.strictEqual(c.registryEligibility.state, 'confirmed', `${rid}: certified, registry agrees both ways`);
    assert.ok(c.registryEligibility.expiresAt > c.registryEligibility.observedAt);
    assert.strictEqual(c.coverage.dish.state, 'full'); assert.strictEqual(c.coverage.extra.state, 'full');
    assert.strictEqual(c.complete, true); assert.strictEqual(c.usableAsIdentity, true);
  }
  const lm = att.la_musa;
  assert.ok(lm.objects.every((o) => o.canonicalId === null), 'la_musa (uncertified): canonicalIds null');
  assert.strictEqual(lm.coverage.dish.state, 'none'); assert.strictEqual(lm.registryEligibility.state, 'unknown');
  assert.strictEqual(lm.usableAsIdentity, false); assert.strictEqual(lm.contentIntegrity.state, 'intact');
  const brandShape = (c) => ({ i: c.contentIntegrity.state, e: c.registryEligibility.state, cov: c.coverage, complete: c.complete, usable: c.usableAsIdentity, labels: c.labels.state });
  assert.deepStrictEqual(brandShape(att.synthetic_3), brandShape(att.x_pizza), 'a synthetic 3rd restaurant behaves exactly like x_pizza');
  ok('live route: cold → unavailable; the next request attaches (E2); x_pizza and a synthetic 3rd brand: intact + confirmed + complete → usable; la_musa: intact, canonicalIds null, coverage none, unknown eligibility');

  // ═══ ISOLATION: a HUNG structure/record/registry read changes NOTHING on the price path ══════════════
  {
    const ctlAlarms = [], hungAlarms = [];
    const ctl = stack({ withContext: false, alarms: ctlAlarms });
    const hung = stack({ sourceDb: hungFs, sourceRtdb: hungRtdb, verifierDb: hungFs, alarms: hungAlarms });
    for (const rid of ['x_pizza', 'la_musa']) {
      const t0 = Date.now(); const c = await ctl.resolver.getPricingTables(rid); const dc = Date.now() - t0;
      const t1 = Date.now(); const h = await hung.resolver.getPricingTables(rid); const dh = Date.now() - t1;
      assert.strictEqual(JSON.stringify(h), JSON.stringify(c), `${rid}: identical prices`);
      assert.strictEqual(envelopeOf(h).source, 'live');
      assert.strictEqual(contextOf(h).availability, 'unavailable');
      assert.ok(dh < 1000 && dh < dc + 500, `${rid}: the hung context reads add no latency (control ${dc}ms, hung ${dh}ms)`);
    }
    // …and on the mirror route with Firestore down and the context node read hung
    ctl.fail.on = true; hung.fail.on = true;
    const cold = [stack({ withContext: false, alarms: ctlAlarms }), stack({ sourceDb: hungFs, sourceRtdb: hungRtdb, verifierDb: hungFs, alarms: hungAlarms })];
    cold.forEach((x) => { x.fail.on = true; });
    const [mc, mh] = [await cold[0].resolver.getPricingTables('la_musa'), await cold[1].resolver.getPricingTables('la_musa')];
    assert.strictEqual(JSON.stringify(mh), JSON.stringify(mc)); assert.strictEqual(envelopeOf(mh).source, 'mirror_cold');
    assert.deepStrictEqual(hungAlarms.map((a) => a.k), ctlAlarms.map((a) => a.k), 'identical alarms');
    assert.strictEqual(contextOf(mh).availability, 'unavailable');
  }
  ok('isolation: with every context read HUNG (record, payload, registry, RTDB node) prices, source, latency and alarms equal the control; context unavailable');

  // ═══ MIRROR ROUTES: the persisted context is REBUILT from raw and re-checked on every serve ═════════
  {
    const st = stack(); st.fail.on = true;
    const first = contextOf(await st.resolver.getPricingTables('x_pizza'));
    assert.strictEqual(first.availability, 'unavailable', 'node not loaded yet on this instance');
    await until(() => st.source._state.persisted.size > 0, 'context node loaded');
    let c = contextOf(await st.resolver.getPricingTables('x_pizza'));
    assert.strictEqual(c.route, 'mirror_cold'); assert.strictEqual(c.attached, true); assert.strictEqual(c.contentIntegrity.state, 'intact');
    await until(async () => { c = contextOf(await st.resolver.getPricingTables('x_pizza')); return c.registryEligibility.state !== 'unknown'; }, 'eligibility on mirror route');
    assert.strictEqual(c.registryEligibility.state, 'confirmed'); assert.strictEqual(c.usableAsIdentity, true);
    // A mutated persisted RAW display name → mismatch (re-checked on serve).
    const node = await ctxNode('x_pizza');
    const raw = JSON.parse(node.payload);
    const save = node.payload;
    raw.items[0].data.display.name += ' (tampered)';
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza/payload`).set(JSON.stringify(raw));
    const st2 = stack(); st2.fail.on = true;
    await st2.resolver.getPricingTables('x_pizza');
    await until(() => st2.source._state.persisted.size > 0, 'tampered node loaded');
    const t = contextOf(await st2.resolver.getPricingTables('x_pizza'));
    assert.strictEqual(t.contentIntegrity.state, 'mismatch'); assert.strictEqual(t.usableAsIdentity, false);
    // A persisted stamp SWAP (stamps are outside the hash) → integrity intact, eligibility REJECTED naming both.
    const raw2 = JSON.parse(save);
    const [i0, i1] = [raw2.items[0].data.display, raw2.items[1].data.display];
    [i0.identity_id, i1.identity_id] = [i1.identity_id, i0.identity_id];
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza/payload`).set(JSON.stringify(raw2));
    const st3 = stack({ verifierDb: fs }); st3.fail.on = true;
    await st3.resolver.getPricingTables('x_pizza');
    await until(() => st3.source._state.persisted.size > 0, 'swapped node loaded');
    let sw;
    await until(async () => { sw = contextOf(await st3.resolver.getPricingTables('x_pizza')); return sw.registryEligibility.state !== 'unknown'; }, 'swap verdict');
    assert.strictEqual(sw.contentIntegrity.state, 'intact', 'by design: stamps are not content');
    assert.strictEqual(sw.registryEligibility.state, 'rejected');
    assert.deepStrictEqual(sw.registryEligibility.rejections.map((r) => r.legacyKey).sort(), [raw2.items[0].data.key, raw2.items[1].data.key].sort(), 'names both swapped objects');
    assert.strictEqual(sw.usableAsIdentity, false);
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza/payload`).set(save);
  }
  ok('mirror_cold: the persisted raw payload is rebuilt from raw + re-checked when loaded (memoized per node, never on the request path) → intact/confirmed/usable; a tampered raw name → mismatch; a persisted stamp swap → intact but REJECTED naming both');

  // ═══ WARM + COLD STAMP SWAP IN FIRESTORE, AGAINST THE REAL REGISTRY ═══════════════════════════════
  {
    const st = stack();
    await st.resolver.getPricingTables('x_pizza');
    await until(() => st.source._state.built.size > 0, 'built');
    await st.resolver.getPricingTables('x_pizza');
    await until(() => st.verifier._cache.size > 0, 'observed');
    assert.strictEqual(contextOf(await st.resolver.getPricingTables('x_pizza')).registryEligibility.state, 'confirmed', 'premise — WARM: a correct context is confirmed and its observation cached');
    const recBefore = (await vrefOf('x_pizza', xV1).get());
    const keys = catalogSnapshot('x_pizza').items.slice(0, 2).map((i) => i.key);
    const restore = await swapStamps('x_pizza', xV1, 'menu_items', keys);
    const recAfter = (await vrefOf('x_pizza', xV1).get());
    assert.strictEqual(recAfter.updateTime.isEqual(recBefore.updateTime), true, 'premise — the version RECORD is untouched (same revision, same updateTime)');
    // A fresh context source (a new instance) SHARING the warm verifier builds the swapped context.
    const readsBefore = st.verifier.stats.reads;
    const src2 = createContextSource({ db: fs, rtdb, verifier: st.verifier, log: silent });
    const served = { rid: 'x_pizza', versionId: xV1, seq: recAfter.data().seq, source: 'live', prices: tablesOf('x_pizza') };
    src2.resolve(served); await until(() => src2._state.built.size > 0, 'swapped built');
    const warm = src2.resolve(served);
    assert.strictEqual(warm.contentIntegrity.state, 'intact');
    assert.strictEqual(warm.registryEligibility.state, 'rejected', '🔴 a warm confirmation was NOT reused by the swapped identity map');
    assert.deepStrictEqual(warm.registryEligibility.rejections.map((r) => r.legacyKey).sort(), [...keys].sort());
    assert.strictEqual(st.verifier.stats.reads, readsBefore, 'judged against the CACHED observation — same read set, no new read');
    // COLD: a fresh verifier too.
    const src3 = createContextSource({ db: fs, rtdb, verifier: createCatalogVerifier({ db: fs, log: silent }), log: silent });
    src3.resolve(served); await until(() => src3._state.built.size > 0, 'cold built');
    let cold; await until(() => { cold = src3.resolve(served); return cold.registryEligibility.state !== 'unknown'; }, 'cold verdict');
    assert.strictEqual(cold.registryEligibility.state, 'rejected');
    // Two concurrent requests, same read set, different pairs → one read, each on its own pairs.
    const v = createCatalogVerifier({ db: fs, log: silent });
    const goodPairs = identityPairs(st.source._state.built.values().next().value);
    const badPairs = identityPairs(src3._state.built.values().next().value);
    const [g, b] = await Promise.all([v.verify('x_pizza', goodPairs), v.verify('x_pizza', badPairs)]);
    assert.strictEqual(v.stats.reads, 1); assert.strictEqual(g.state, 'confirmed'); assert.strictEqual(b.state, 'rejected');
    await restore();
  }
  ok('Firestore stamp swap with unchanged record metadata: WARM (cached observation, no new read) and COLD both → integrity intact, eligibility rejected naming both; concurrent same-read-set requests share 1 read and are judged on their own pairs');

  // ═══ REGISTRY NEGATIVES, each naming the object, on the real registry ═════════════════════════════
  {
    const st = stack(); await st.resolver.getPricingTables('x_pizza');
    await until(() => st.source._state.built.size > 0, 'built');
    const ctx = st.source._state.built.values().next().value;
    const pairs = identityPairs(ctx);
    const [d0] = pairs.filter((p) => p.kind === 'dish');
    const [e0] = pairs.filter((p) => p.kind === 'extra');
    const verdict = async (ps) => createCatalogVerifier({ db: fs, log: silent }).verify('x_pizza', ps);
    const idRef = idsColOf(fs, 'x_pizza', 'dish').doc(d0.canonicalId);
    const keyRef = keysColOf(fs, 'x_pizza', 'dish').doc(encodeKey(d0.legacyKey));
    const idRow = (await idRef.get()).data(), keyRow = (await keyRef.get()).data();
    assert.strictEqual((await verdict(pairs)).state, 'confirmed', 'premise');
    const expectReject = async (label, reason, ps = pairs) => {
      const r = await verdict(ps);
      assert.strictEqual(r.state, 'rejected', label);
      const hit = r.rejections.find((x) => x.reason === reason);
      assert.ok(hit, `${label}: reason ${reason} (got ${JSON.stringify(r.rejections)})`);
      return hit;
    };
    await idRef.update({ status: 'retired' });
    assert.strictEqual((await expectReject('a retired id', 'retired')).legacyKey, d0.legacyKey);
    await idRef.update({ status: 'pending' });
    await expectReject('a non-live non-retired id', 'not_live');
    await idRef.set(idRow);
    await keyRef.delete();
    await expectReject('a missing key row', 'missing_key_row');
    await keyRef.set(keyRow);
    const foreign = pairs.map((p) => (p === d0 ? { ...p, canonicalId: e0.canonicalId } : p));
    await expectReject('a dish stamped with an EXTRA\'s id', 'foreign_kind', foreign);
    assert.strictEqual((await verdict(pairs)).state, 'confirmed', 'restored');

    // A retirement RACING the read: the coherent batch sees one consistent side, never half of a 2-row change.
    const [p1, p2] = pairs.filter((p) => p.kind === 'dish');
    const refs = [idsColOf(fs, 'x_pizza', 'dish').doc(p1.canonicalId), idsColOf(fs, 'x_pizza', 'dish').doc(p2.canonicalId)];
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
      // staggered so the read lands on either side of the 2-row retirement
      const retire = fs.runTransaction(async (tx) => { await Promise.all(refs.map((r) => tx.get(r))); refs.forEach((r) => tx.update(r, { status: 'retired' })); });
      if (i % 3 === 1) await wait(i * 3); else if (i % 3 === 2) await retire;
      const r = await verdict([p1, p2]);
      await retire;
      const rejected = (r.rejections || []).map((x) => x.legacyKey).sort().join('|');
      seen.add(rejected || 'none');
      assert.ok(rejected === '' || rejected === [p1.legacyKey, p2.legacyKey].sort().join('|'), `🔴 a torn registry read: only ${rejected} retired`);
      await Promise.all(refs.map((ref) => ref.update({ status: 'live' })));
    }
    ok(`registry negatives name the object (retired, non-live, missing key row, foreign kind); a 2-row retirement racing the read is seen whole or not at all over 12 staggered races (sides observed: ${[...seen].map((x) => (x === 'none' ? 'before' : 'after')).join(', ')})`);

    // Bounded staleness on the REAL registry with a controlled clock.
    let t = 1000000;
    const v = createCatalogVerifier({ db: fs, now: () => t, log: silent });
    assert.strictEqual((await v.verify('x_pizza', pairs)).state, 'confirmed');
    await idRef.update({ status: 'retired' });
    t += 59000;
    assert.strictEqual(v.eligibilityFor('x_pizza', pairs, { startRead: false }).state, 'confirmed', 'confirmed AS OF the unexpired observation');
    t += 2000;
    assert.strictEqual(v.eligibilityFor('x_pizza', pairs, { startRead: false }).state, 'unknown', 'expired → not served');
    const after = await v.verify('x_pizza', pairs);
    assert.strictEqual(after.state, 'rejected'); assert.strictEqual(after.rejections[0].reason, 'retired');
    await idRef.set(idRow);
    ok('bounded staleness on the real registry: a retirement after the observation → confirmed until the observation expires (fake clock), then rejected on re-read');

    // A full 58-object batch: la_musa's grandfathered registry, one coherent read.
    const lmPairs = [...catalogSnapshot('la_musa').items.map((x) => ({ kind: 'dish', canonicalId: x.key, legacyKey: x.key })),
      ...catalogSnapshot('la_musa').extras.map((x) => ({ kind: 'extra', canonicalId: x.key, legacyKey: x.key }))];
    const vb = createCatalogVerifier({ db: fs, log: silent });
    const t0 = Date.now(); const big = await vb.verify('la_musa', lmPairs); const dt = Date.now() - t0;
    assert.strictEqual(lmPairs.length, 58); assert.strictEqual(big.state, 'confirmed'); assert.strictEqual(vb.stats.reads, 1);
    ok(`a full 58-object batch (la_musa) is confirmed by ONE coherent read of 174 docs in ${dt}ms`);
  }

  // ═══ PROVENANCE: attachment follows the SERVED prices, never recency or the pointer ═══════════════
  {
    let t = Date.now();
    const st = stack({ now: () => t });
    const A = await st.resolver.getPricingTables('synthetic_3');
    await until(() => st.source._state.built.size > 0, 'A built');
    assert.strictEqual(contextOf(await st.resolver.getPricingTables('synthetic_3')).versionId, sV1, 'premise — context A attached');
    // Publish B with a changed price (Firestore now at B); the warm instance still serves cached A.
    const firstKey = catalogSnapshot('x_pizza').items[0].key;
    const resB = await publishFromSource('synthetic_3', 'ctx-B', { dataRid: 'x_pizza', mutate: (src) => { src.items[0].price += 10; src.items[0].display.price += 10; } });
    const sV2 = resB.versionId;
    const stillA = contextOf(await st.resolver.getPricingTables('synthetic_3'));
    assert.strictEqual(stillA.attached, true); assert.strictEqual(stillA.versionId, sV1, 'Firestore at B, serving cached A → context A ATTACHES (historical for historical)');
    // Past the pointer TTL the instance serves B: A's context must NOT attach to B's prices.
    t += 46000;
    const B = await st.resolver.getPricingTables('synthetic_3');
    assert.strictEqual(B.menu[firstKey], tablesOf('x_pizza').menu[firstKey] + 10, 'premise — B prices served');
    const cB = contextOf(B);
    assert.strictEqual(cB.attached, false, '🔴 version A context never attaches to version B prices');
    // Direct provenance probes on the source: same version + different prices → price_mismatch; wrong seq → provenance_mismatch.
    const seqA = (await vrefOf('synthetic_3', sV1).get()).data().seq;
    const pA = { rid: 'synthetic_3', versionId: sV1, seq: seqA, source: 'live', prices: { menu: A.menu, extras: A.extras } };
    assert.strictEqual(st.source.resolve(pA).attached, true);
    assert.strictEqual(st.source.resolve({ ...pA, prices: { menu: { ...A.menu, [firstKey]: A.menu[firstKey] + 1 }, extras: A.extras } }).reason, 'price_mismatch');
    assert.strictEqual(st.source.resolve({ ...pA, seq: seqA + 1 }).reason, 'provenance_mismatch');
    // last_good A with context A while Firestore is at B → attached.
    const lg = stack({ now: () => t });
    await lg.resolver.getPricingTables('synthetic_3');
    await until(() => lg.source._state.built.size > 0, 'B built');
    await lg.resolver.getPricingTables('synthetic_3');
    lg.fail.on = true; t += 46000;
    const lgB = await lg.resolver.getPricingTables('synthetic_3');
    assert.strictEqual(envelopeOf(lgB).source, 'last_good'); assert.strictEqual(contextOf(lgB).attached, true); assert.strictEqual(contextOf(lgB).versionId, sV2);
    // An old-revision publish (legacy mirror at B) before the context trigger: mirror route serves B, the
    // persisted context is still A → unavailable; the trigger runs → converged + attached.
    assert.strictEqual((await ctxNode('synthetic_3')).head.versionId, sV1, 'premise — context path still at A (no trigger ran)');
    const m = stack(); m.fail.on = true;
    await m.resolver.getPricingTables('synthetic_3'); await until(() => m.source._state.persisted.size > 0, 'node');
    const interim = contextOf(await m.resolver.getPricingTables('synthetic_3'));
    assert.strictEqual(envelopeOf(await m.resolver.getPricingTables('synthetic_3')).versionId, sV2, 'premise — the legacy mirror serves B');
    assert.strictEqual(interim.attached, false); assert.strictEqual(interim.reason, 'provenance_mismatch');
    await app.writeCatalogContextOnMirror.run({ params: { rid: 'synthetic_3' }, data: {} });
    const m2 = stack(); m2.fail.on = true;
    await m2.resolver.getPricingTables('synthetic_3'); await until(() => m2.source._state.persisted.size > 0, 'node');
    const conv = contextOf(await m2.resolver.getPricingTables('synthetic_3'));
    assert.strictEqual(conv.attached, true); assert.strictEqual(conv.versionId, sV2);
    globalThis.__sV2 = sV2;
  }
  ok('provenance: Firestore at B while serving cached A → A attaches; A never attaches to B prices; same version + different prices / wrong seq → not attached; last_good B attaches; legacy mirror at B with context A → interim unavailable, trigger → converged + attached');

  // ═══ THE FENCE, ON THE REAL WRITER ════════════════════════════════════════════════════════════════
  const W = (opts = {}) => createContextWriter({ db: fs, rtdb, log: capture, ...opts });
  const head = async (rid) => (await ctxNode(rid)).head;
  {
    // A higher generation replaces — including a ROLLBACK to a lower seq. ERRATA E1: re-activating the SAME
    // version (CK unchanged) reuses the request-side entry while the HEAD/fence advance.
    let t = Date.now();
    const st = stack({ now: () => t });
    await st.resolver.getPricingTables('x_pizza'); await until(() => st.source._state.built.size > 0, 'V1 built');
    const v1Entry = [...st.source._state.built.entries()].find(([k]) => k.includes(xV1));
    const h1 = await head('x_pizza');
    const r2 = await publishFromSource('x_pizza', 'ctx-x2');
    await app.writeCatalogContextOnMirror.run({ params: { rid: 'x_pizza' }, data: {} });
    const h2 = await head('x_pizza');
    assert.strictEqual(h2.versionId, r2.versionId); assert.ok(h2.fk.generation > h1.fk.generation && h2.seq > h1.seq);
    t += 46000; await st.resolver.getPricingTables('x_pizza');
    const buildsBefore = st.source.stats.builds;
    await rollbackVersion(fs, 'x_pizza', xV1, { expected: { activeVersionId: r2.versionId }, mirror: makeRtdbMirror(rtdb) });
    await app.writeCatalogContextOnMirror.run({ params: { rid: 'x_pizza' }, data: {} });
    const h3 = await head('x_pizza');
    assert.strictEqual(h3.versionId, xV1); assert.ok(h3.seq < h2.seq, 'a LOWER seq…'); assert.ok(h3.fk.generation > h2.fk.generation, '…at a HIGHER generation replaces');
    assert.deepStrictEqual({ r: h3.fk.revision, u: h3.fk.updateTime }, { r: h1.fk.revision, u: h1.fk.updateTime }, 'premise (E1) — the re-activated version\'s CK is unchanged');
    t += 46000;
    const back = contextOf(await st.resolver.getPricingTables('x_pizza'));
    assert.strictEqual(back.attached, true); assert.strictEqual(back.versionId, xV1);
    const v1Now = [...st.source._state.built.entries()].find(([k]) => k.includes(xV1));
    assert.ok(v1Now && v1Now[1] === v1Entry[1], '🔴 E1: the request-side entry for (rid, V1, CK) is REUSED — same object, not evicted');
    assert.strictEqual(st.source.stats.builds, buildsBefore, 'no rebuild for the re-activated version');
    globalThis.__x2 = r2.versionId;
  }
  ok('fence: a higher generation replaces, incl. a rollback to a LOWER seq; E1 — re-activating the same version advances HEAD.fk.generation while the request-side (rid, V, CK) entry is reused (same object, no rebuild)');

  {
    // A LOWER generation after a higher one COMMITTED → superseded. W1 captures V2@g at its consistent read,
    // then the instance-wide writer commits a higher activation; W1's fenced commit must not regress it.
    const x2 = globalThis.__x2;
    await rollbackVersion(fs, 'x_pizza', x2, { expected: { activeVersionId: xV1 }, mirror: makeRtdbMirror(rtdb) });   // pointer → V2 (gen up)
    const g = gatedRtdb();
    const p1 = W({ rtdb: g.db }).writeActiveContext('x_pizza');
    await g.arrived;                                                           // W1 has read V2@g
    await rollbackVersion(fs, 'x_pizza', xV1, { expected: { activeVersionId: x2 }, mirror: makeRtdbMirror(rtdb) });   // → V1 @ g+1
    assert.strictEqual(await outcomeOf(W().writeActiveContext('x_pizza')), 'committed');
    const top = await head('x_pizza');
    g.open();
    assert.strictEqual(await outcomeOf(p1), 'superseded');
    assert.deepStrictEqual(await head('x_pizza'), top, 'the committed higher FK is not regressed');
  }
  ok('fence: a write captured at a lower generation, landing after a higher one COMMITTED → superseded; the path is not regressed');

  {
    // Same generation, LOWER revision → superseded — staged with the REAL in-place bootstrap of la_musa, while a
    // warm instance (revision 0) proves revision DISCOVERY within one CONTEXT_RECORD_TTL_MS UNDER CONTINUOUS TRAFFIC (E4: no
    // wall-clock liveness is claimed for request-side caches — see catalog/context-suspension.test.js), pricing caches untouched,
    // and a late revision-0 build result is discarded.
    let t = Date.now();
    let releaseBuild; const buildGate = new Promise((r) => { releaseBuild = r; });
    let gateBuilds = false;
    const slowBuildFs = { collection: (c) => fs.collection(c), runTransaction: async (fn, o) => { const r = await fs.runTransaction(fn, o); if (gateBuilds) await buildGate; return r; } };
    const st = stack({ now: () => t, sourceDb: slowBuildFs });
    const before = await st.resolver.getPricingTables('la_musa');
    await until(() => st.source._state.built.size > 0, 'rev0 built');
    const rev0 = contextOf(await st.resolver.getPricingTables('la_musa'));
    assert.strictEqual(rev0.certified, false, 'premise — warm on la_musa at revision 0 (uncertified)');
    await rtdb.ref(`${CONTEXT_PATH}/la_musa`).remove();
    const g = gatedRtdb();
    const p1 = W({ rtdb: g.db }).writeActiveContext('la_musa');
    await g.arrived;                                                           // W1 captured revision 0
    const gen0 = (await getActivePointer(fs, 'la_musa')).generation;
    // a late revision-0 build is now in flight on the warm instance
    for (const k of [...st.source._state.built.keys()]) st.source._state.built.delete(k);
    gateBuilds = true; t += 1; st.source.build('la_musa', lV1);
    await wait(150);
    const b = await bootstrapIdentityStamps(fs, 'la_musa');
    assert.strictEqual(b.stamped, true);
    assert.strictEqual((await getActivePointer(fs, 'la_musa')).generation, gen0, 'premise — in place: no pointer change');
    assert.strictEqual(await outcomeOf(W().writeActiveContext('la_musa')), 'committed');   // the reconciler's path: revision 1
    g.open();
    assert.strictEqual(await outcomeOf(p1), 'superseded', 'same generation, lower revision → superseded');
    assert.strictEqual((await head('la_musa')).fk.revision, 1);
    // DISCOVERY within one TTL under continuous traffic (requests keep arriving): before the TTL the warm instance still holds revision 0's record observation…
    t += CONTEXT_RECORD_TTL_MS - 2;
    const pre = await st.resolver.getPricingTables('la_musa');
    assert.strictEqual(pre.menu, before.menu, 'the PRICING cache is untouched (the same immutable table object, a warm hit)');
    t += 2;                                                                    // …one TTL → re-read the record
    await st.resolver.getPricingTables('la_musa');
    await until(() => [...st.source._state.discovered.values()].some((d) => d.ck.revision === 1), 'revision 1 discovered');
    releaseBuild();                                                            // the LATE revision-0 build lands now
    await wait(100);
    assert.ok(st.source.stats.discoveryDiscarded >= 1 || ![...st.source._state.built.keys()].some((k) => k.includes('.r0.')), 'the late revision-0 result is discarded');
    assert.ok(![...st.source._state.built.keys()].some((k) => k.includes(lV1) && k.includes('::r0.')), '🔴 no revision-0 entry survives');
    gateBuilds = false;
    await until(async () => { const c = contextOf(await st.resolver.getPricingTables('la_musa')); return c.attached && c.certified; }, 'certified context attached');
    const certifiedCtx = contextOf(await st.resolver.getPricingTables('la_musa'));
    assert.strictEqual(certifiedCtx.coverage.dish.state, 'full'); assert.strictEqual(certifiedCtx.contentIntegrity.state, 'intact');
    // Certification followed by a registry OUTAGE → integrity intact, eligibility unknown, prices unchanged.
    const downFs = { doc: (p) => fs.doc(p), runTransaction: () => Promise.reject(new Error('UNAVAILABLE')) };
    const out = stack({ verifierDb: downFs });
    const p = await out.resolver.getPricingTables('la_musa');
    await until(() => out.source._state.built.size > 0, 'built');
    const oc = contextOf(await out.resolver.getPricingTables('la_musa'));
    await wait(50);
    const oc2 = contextOf(await out.resolver.getPricingTables('la_musa'));
    assert.deepStrictEqual({ menu: p.menu, extras: p.extras }, tablesOf('la_musa'));
    assert.strictEqual(oc2.contentIntegrity.state, 'intact'); assert.strictEqual(oc2.registryEligibility.state, 'unknown'); assert.strictEqual(oc.usableAsIdentity, false);
  }
  ok('in-place bootstrap of la_musa (no pointer change): a write captured at revision 0 → superseded; the warm instance discovers revision 1 within one CONTEXT_RECORD_TTL_MS under continuous traffic, pricing cache untouched, the late revision-0 build discarded; then a registry outage → intact + unknown, prices unchanged');

  {
    // Equal FK + identical content → idempotent; equal FK + DIFFERENT content → refused (nothing overwritten).
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza`).remove();
    const [g1, g2] = [gatedRtdb(), gatedRtdb()];
    const [a, b] = [W({ rtdb: g1.db }).writeActiveContext('x_pizza'), W({ rtdb: g2.db }).writeActiveContext('x_pizza')];
    await Promise.all([g1.arrived, g2.arrived]);
    g1.open(); const oa = await outcomeOf(a); g2.open(); const ob = await outcomeOf(b);
    assert.deepStrictEqual([oa, ob], ['committed', 'idempotent']);
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza`).remove();
    const g3 = gatedRtdb();
    const c = W({ rtdb: g3.db }).writeActiveContext('x_pizza');
    await g3.arrived;
    assert.strictEqual(await outcomeOf(W().writeActiveContext('x_pizza')), 'committed');
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza/payload`).set('{"tampered":true}');
    g3.open();
    assert.strictEqual(await outcomeOf(c), 'refused', 'equal FK, different content → refused');
    assert.strictEqual((await ctxNode('x_pizza')).payload, '{"tampered":true}', 'refused means NOTHING written');
    // An absent / malformed head → replaced.
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza/head/fk`).set('garbage');
    assert.strictEqual(await outcomeOf(W().writeActiveContext('x_pizza')), 'committed', 'a malformed stored FK is the minimum → replaced');
    assert.strictEqual(typeof (await head('x_pizza')).fk.generation, 'number');
  }
  ok('fence: equal FK + identical content → idempotent; equal FK + different content → refused with nothing written; a malformed stored FK → replaced');

  {
    // B ACTIVATED in Firestore but B's context NOT yet committed → A's captured write COMMITS (no supersession
    // is claimed), and attachment still follows the served provenance.
    const x2 = globalThis.__x2;
    await rtdb.ref(`${CONTEXT_PATH}/x_pizza`).remove();
    const g = gatedRtdb();
    const p1 = W({ rtdb: g.db }).writeActiveContext('x_pizza');               // captures A (V1)
    await g.arrived;
    await rollbackVersion(fs, 'x_pizza', x2, { expected: { activeVersionId: xV1 }, mirror: makeRtdbMirror(rtdb) });   // B (V2) active
    g.open();
    assert.strictEqual(await outcomeOf(p1), 'committed', 'nothing higher has COMMITTED at the context path, so A commits');
    assert.strictEqual((await head('x_pizza')).versionId, xV1);
    const m = stack(); m.fail.on = true;
    await m.resolver.getPricingTables('x_pizza'); await until(() => m.source._state.persisted.size > 0, 'node');
    const served = await m.resolver.getPricingTables('x_pizza');
    assert.strictEqual(envelopeOf(served).versionId, x2, 'premise — the legacy mirror serves B');
    assert.strictEqual(contextOf(served).attached, false, 'context A does not attach to B');
    await app.writeCatalogContextOnMirror.run({ params: { rid: 'x_pizza' }, data: {} });
    assert.strictEqual((await head('x_pizza')).versionId, x2, 'then B commits (higher generation)');
  }
  ok('B activated but its context not committed: A\'s captured write COMMITS (no cross-store supersession claimed); attachment follows provenance (A ≠ served B); the next wake-up commits B');

  {
    // An old-revision legacy mirror write never touches the context path, but it WAKES the writer.
    const before = await ctxNode('x_pizza');
    await makeRtdbMirror(rtdb)('x_pizza', { version: xV1, seq: 1, rid: 'x_pizza', menu: tablesOf('x_pizza').menu, extras: tablesOf('x_pizza').extras });
    assert.deepStrictEqual(await ctxNode('x_pizza'), before, 'the legacy mirror write did not touch catalog_snapshot_ctx');
    await app.writeCatalogContextOnMirror.run({ params: { rid: 'x_pizza' }, data: {} });
    assert.strictEqual((await head('x_pizza')).versionId, globalThis.__x2, 'the woken writer wrote the CURRENT activation, not the old mirror\'s version');
    // A payload whose recomputed content_hash ≠ the pinned one → refused, nothing written.
    const tV = await seedPreP1('tamper_rid', { dataFrom: 'x_pizza' });
    const d = (await vrefOf('tamper_rid', tV).collection('menu_items').get()).docs[0];
    await d.ref.update({ 'display.name': 'edited in place' });
    assert.strictEqual(await outcomeOf(W().writeActiveContext('tamper_rid')), 'refused');
    assert.strictEqual(await ctxNode('tamper_rid'), null, 'nothing written');
    assert.ok(logs.some((l) => l.k === 'context_write' && l.d.rid === 'tamper_rid' && l.d.outcome === 'refused' && l.d.reason === 'content_integrity'), 'a bounded context_write diagnostic names it');
  }
  ok('an old-revision legacy mirror write leaves the context path untouched and the woken writer writes the current activation; a payload failing its pinned content_hash → refused, nothing written');

  {
    // OLD-EXECUTABLE certification: identity_certified + stamps written with NO identity_revision bump and no
    // pointer change. The reconciler sees the record's updateTime advance → a strictly newer context, no
    // equal-pair refusal. With the discovery AND payload caches WARM, the new CK is discovered, the old entry is
    // evicted, and the next build uses the certified payload.
    const oV = await seedPreP1('oldexec', { dataFrom: 'x_pizza' });
    await W().reconcile({ listIds: async () => ['oldexec'] });
    const h0 = await head('oldexec');
    let t = Date.now();
    const st = stack({ now: () => t });
    await st.resolver.getPricingTables('oldexec'); await until(() => st.source._state.built.size > 0, 'built');
    const oldKey = [...st.source._state.built.keys()][0];
    // the old executable's write: stamps from the registry + identity_certified, nothing else
    const vref = vrefOf('oldexec', oV);
    for (const [col, kind] of [['menu_items', 'dish'], ['extras', 'extra']]) {
      for (const doc of (await vref.collection(col).get()).docs) {
        const key = doc.data().key;
        const row = (await keysColOf(fs, 'oldexec', kind).doc(encodeKey(key)).get()).data();
        await doc.ref.update({ 'display.identity_id': row.canonical_id });
      }
    }
    await vref.update({ identity_certified: true });
    assert.strictEqual((await vref.get()).data().identity_revision, undefined, 'premise — NO revision bump (old executable)');
    const res = await W().reconcile({ listIds: async () => ['oldexec'] });
    assert.deepStrictEqual(res.results.map((r) => r.outcome), ['committed'], 'no equal-pair refusal');
    const h1 = await head('oldexec');
    assert.strictEqual(h1.fk.revision, 0); assert.strictEqual(h1.fk.generation, h0.fk.generation);
    assert.ok(h1.fk.updateTime.seconds > h0.fk.updateTime.seconds || (h1.fk.updateTime.seconds === h0.fk.updateTime.seconds && h1.fk.updateTime.nanoseconds > h0.fk.updateTime.nanoseconds), 'strictly newer by recordUpdateTime');
    assert.strictEqual(h1.certified, true);
    const recTime = (await vref.get()).updateTime;
    assert.deepStrictEqual(h1.fk.updateTime, { seconds: recTime.seconds, nanoseconds: recTime.nanoseconds }, 'HEAD round-trips FK losslessly (nanoseconds preserved)');
    t += CONTEXT_RECORD_TTL_MS;
    await st.resolver.getPricingTables('oldexec');
    await until(() => !st.source._state.built.has(oldKey), 'old CK evicted');
    await until(async () => { const c = contextOf(await st.resolver.getPricingTables('oldexec')); return c.attached && c.certified; }, 'certified build');
    const c = contextOf(await st.resolver.getPricingTables('oldexec'));
    assert.ok(c.objects.every((o) => o.canonicalId !== null), 'the next build uses the CERTIFIED payload');
    assert.ok(st.source.stats.evictions >= 1);
  }
  ok('old-executable certification (no revision bump, no pointer change): the reconciler commits a strictly newer context by recordUpdateTime; HEAD.fk round-trips nanoseconds; warm discovery evicts the old CK entry and rebuilds certified');

  // ═══ INVOKERS: duplicates, staleness, overlap, hung slots, read volume ═══════════════════════════════
  {
    const x2 = globalThis.__x2;
    // duplicated / reordered / stale wake-ups converge on the current activation
    const evs = [{ version: xV1, seq: 1 }, { version: 'v-old', seq: 0 }, { version: x2, seq: 99 }, null, { version: xV1, seq: 1 }];
    const outs = await Promise.all(evs.map((after) => contextWriterRun('x_pizza', after)));
    void outs;
    assert.strictEqual((await head('x_pizza')).versionId, (await getActivePointer(fs, 'x_pizza')).version, 'converged to the current activation');
    // duplicate-event load → the pre-check skips: head-sized reads only (independent read counter)
    const cfs = countingFs();
    const w = createContextWriter({ db: cfs, rtdb, log: capture });
    const results = [];
    for (let i = 0; i < 10; i += 1) results.push(await w.writeActiveContext('x_pizza'));
    assert.ok(results.every((r) => r.outcome === 'idempotent' && r.precheck === true));
    assert.deepStrictEqual({ col: cfs.counts.collectionGets, tx: cfs.counts.transactions, doc: cfs.counts.docGets }, { col: 0, tx: 0, doc: 20 },
      'an up-to-date write reads only the pointer + the version record (+ the RTDB head): 2 doc reads, no catalog reads, no transaction');
    // an up-to-date reconciler pass is head-sized too
    const cfs2 = countingFs();
    await createContextWriter({ db: cfs2, rtdb, log: capture }).reconcile({ listIds: async () => ['x_pizza', 'la_musa', 'synthetic_3'] });
    assert.strictEqual(cfs2.counts.collectionGets, 0); assert.strictEqual(cfs2.counts.transactions, 0);
  }
  ok('trigger: duplicated, reordered and stale wake-ups converge on the current activation; repeated wake-ups and an up-to-date reconciler pass do head-sized reads only (independent counter: 0 catalog reads, 0 transactions)');

  {
    // HUNG restaurants filling EVERY worker slot, then a healthy restaurant needing repair → slots released at
    // the deadline and the healthy one repaired. Restaurants come from the enumerator, not a list in code.
    await rtdb.ref(`${CONTEXT_PATH}/synthetic_3`).remove();
    const hf = countingFs({ hangRids: ['hung_a', 'hung_b'] });
    const w = createContextWriter({ db: hf, rtdb, deadlineMs: 300, log: capture });
    const t0 = Date.now();
    const res = await w.reconcile({ listIds: async () => ['hung_a', 'hung_b', 'synthetic_3'], concurrency: 2 });
    const dt = Date.now() - t0;
    const by = Object.fromEntries(res.results.map((r) => [r.rid, r.outcome]));
    assert.deepStrictEqual(by, { hung_a: 'timeout', hung_b: 'timeout', synthetic_3: 'committed' });
    assert.ok(dt < 3000, `bounded: ${dt}ms`);
    assert.strictEqual(w._flights.size, 0, 'single-flight entries released on timeout');
    // trigger DISABLED (a missed wake-up): one reconciler pass repairs it
    await rtdb.ref(`${CONTEXT_PATH}/la_musa`).remove();
    await app.reconcileCatalogContexts.run({});
    assert.ok(await ctxNode('la_musa'), 'repaired by one pass');
    // two OVERLAPPING reconciler invocations (separate instances) → the same end state as one, no regression, no refusal
    const want = {};
    for (const rid of ['x_pizza', 'la_musa', 'synthetic_3']) want[rid] = await head(rid);
    for (const rid of ['x_pizza', 'la_musa', 'synthetic_3']) await rtdb.ref(`${CONTEXT_PATH}/${rid}`).remove();
    const list = async () => ['x_pizza', 'la_musa', 'synthetic_3'];
    const [r1, r2] = await Promise.all([W().reconcile({ listIds: list }), W().reconcile({ listIds: list })]);
    const outcomes = [...r1.results, ...r2.results].map((r) => r.outcome);
    assert.ok(outcomes.every((o) => ['committed', 'idempotent', 'superseded'].includes(o)), `no refusal/failure under overlap: ${outcomes}`);
    for (const rid of Object.keys(want)) assert.deepStrictEqual(await head(rid), want[rid], `${rid}: same end state as one invocation`);
  }
  ok('reconciler: hung restaurants filling every slot time out at the deadline and release their slots — the healthy one is repaired; a missed trigger is repaired by one pass; two overlapping invocations reach the same end state with no refusal');

  {
    // A version EDIT racing the writer's read → never a mixed payload (one consistent read-only transaction).
    const rV = await seedPreP1('race_rid', { dataFrom: 'x_pizza' });
    const doc = (await vrefOf('race_rid', rV).collection('menu_items').get()).docs[0];
    const original = doc.data().display.name;
    const tally = {};
    for (let i = 0; i < 8; i += 1) {
      await rtdb.ref(`${CONTEXT_PATH}/race_rid`).remove();
      // staggered: the edit lands before, during or after the writer's consistent read
      const pw = (i % 2 === 0) ? W().writeActiveContext('race_rid') : null;
      const edit = wait(i % 4).then(() => doc.ref.update({ 'display.name': `${original} #${i}` })).then(() => wait(i % 3 === 0 ? 30 : 0)).then(() => doc.ref.update({ 'display.name': original }));
      const r = pw ? await pw : (await wait(5), await W().writeActiveContext('race_rid'));
      await edit;
      tally[r.outcome] = (tally[r.outcome] || 0) + 1;
      if (r.outcome === 'committed') {
        const raw = JSON.parse((await ctxNode('race_rid')).payload);
        assert.ok(raw.items.every((it) => !/#\d+$/.test(it.data.display.name)), '🔴 a committed payload is never a mix (an edited name would have failed its pinned hash)');
      } else assert.strictEqual(r.outcome, 'refused');
    }
    ok(`a version edit racing the writer's read: every write is committed-intact or refused, never mixed (${JSON.stringify(tally)})`);
  }

  // ═══ DECOUPLING: publish is today's, even with a context write HUNG ════════════════════════════════
  {
    const ctlRes = await publishFromSource('synthetic_3', 'ctx-ctl', { dataRid: 'x_pizza' });
    const hungW = createContextWriter({ db: fs, rtdb: hungRtdb, deadlineMs: 400, log: capture });
    const pending = hungW.writeActiveContext('synthetic_3');                 // blocked on the RTDB head read
    const t0 = Date.now();
    const res = await publishFromSource('synthetic_3', 'ctx-during', { dataRid: 'x_pizza' });
    const dt = Date.now() - t0;
    assert.deepStrictEqual(Object.keys(res).sort(), Object.keys(ctlRes).sort(), 'the same result shape as the control publish');
    assert.strictEqual(res.mirrored, ctlRes.mirrored, 'the legacy `mirrored` result is unchanged');
    assert.ok(res.versionId && res.versionId !== ctlRes.versionId, 'a concurrent publish is ACCEPTED');
    assert.strictEqual((await outcomeOf(pending)), 'timeout', 'the hung context write settles at its own deadline');
    ok(`decoupling: with a context write HUNG, a concurrent publish is accepted with the control's result shape (mirrored: ${JSON.stringify(res.mirrored)}) in ${dt}ms; the hung write times out on its own`);
  }

  // ═══ POLICY: no gate-reader call on the pricing path; the shadow diff reads only an ALREADY-cached gate ═══
  {
    const { createGateReader } = require('../catalog/menu-gates');
    const { previewVersion } = require('../catalog/catalog-publish');
    let gateReads = 0;
    const gate = createGateReader({ getVersionId: (rid) => getActiveVersionId(fs, rid), getMenu: (rid, v) => { gateReads += 1; return previewVersion(fs, rid, v); } });
    const localLogs = [];
    const verifier = createCatalogVerifier({ db: fs, log: silent });
    const source = createContextSource({ db: fs, rtdb, verifier, peekGates: (r, v) => gate.peek(r, v), log: (k, d) => localLogs.push({ k, d }) });
    const reader = createCatalogReader({ getRestaurantDocs: (rid) => getRestaurantDocs(fs, rid), getActiveVersionId: (rid) => getActiveVersionId(fs, rid) });
    const res = createPricingResolver({ reader, alarm: silent, context: { resolve: (x) => source.resolve(x) } });
    for (let i = 0; i < 5; i += 1) await res.getPricingTables('la_musa');
    await until(() => source._state.built.size > 0, 'built');
    for (let i = 0; i < 5; i += 1) await res.getPricingTables('la_musa');
    assert.strictEqual(gateReads, 0, '🔴 the pricing path made NO gate-reader read');
    const v = (await getActivePointer(fs, 'la_musa')).version;
    await gate.gatesFor('la_musa', v);                                         // the gate reader warms on its own path
    await res.getPricingTables('la_musa');
    assert.ok(!localLogs.some((l) => l.k === 'context_policy_diff'), 'the context agrees with the cached gates');
    gate._cache.set(`la_musa::${v}`, { ...gate._cache.get(`la_musa::${v}`), redeem: { restaurantId: 'la_musa', allow: new Set(['not-a-dish']) } });
    await res.getPricingTables('la_musa'); await res.getPricingTables('la_musa');
    const diffs = localLogs.filter((l) => l.k === 'context_policy_diff');
    assert.strictEqual(diffs.length, 1, 'a difference is logged once (rate-limited)'); assert.deepStrictEqual(diffs[0].d.rules, ['redeem_eligible']);
  }
  ok('policy: the pricing path makes no gate-reader read; the shadow diagnostic compares only an ALREADY-cached gate result — agreement is silent, a difference is logged once (rate-limited)');

  // ═══ RTDB round-trip of nulls / empty containers; payload size + write timing measured ═══════════════
  {
    const { persistedNode, rawFromNode } = require('../catalog/context-writer');
    const structure = { a: null, b: [], c: {}, d: [null, [], {}], e: '', f: 0, g: false, 'k.with/odd#chars': 1 };
    const node = persistedNode({ rid: 'rt', versionId: 'v', record: { version: 'v', seq: 1, content_hash: 'h' }, items: [{ id: 'x', data: { key: 'K', price: 1, display: { n: null, l: [] } } }], extras: [], structure,
      fk: { generation: 1, revision: 0, updateTime: { seconds: 5, nanoseconds: 0 } } });
    await rtdb.ref(`${CONTEXT_PATH}/rt_probe`).set({ ...node, at: 1 });
    const back = await ctxNode('rt_probe');
    assert.strictEqual(back.payload, node.payload, 'the payload string round-trips byte-for-byte');
    assert.deepStrictEqual(rawFromNode(back).structure, structure, 'nulls, empty arrays/objects and odd keys survive');
    assert.deepStrictEqual(back.head.fk, node.head.fk, 'a zero nanoseconds survives (RTDB keeps 0)');
    await rtdb.ref(`${CONTEXT_PATH}/rt_probe`).remove();
    const sizes = {};
    for (const rid of ['x_pizza', 'la_musa']) sizes[rid] = Buffer.byteLength(JSON.stringify(await ctxNode(rid)));
    await rtdb.ref(`${CONTEXT_PATH}/la_musa`).remove();
    const t0 = Date.now(); await W().writeActiveContext('la_musa'); const dt = Date.now() - t0;
    ok(`RTDB round-trip of nulls / empty containers / odd keys is exact (payload kept as one canonical string); measured node size x_pizza ${sizes.x_pizza} B, la_musa ${sizes.la_musa} B; a full la_musa write ${dt}ms on the emulator`);
  }

  FINISHED = true;
  console.log(`catalog-context(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('catalog-context(emulator) FAILED:', e); process.exit(1); });
