'use strict';
// Portal 1D · D4-c1 — CONTENT-ADDRESSED IDENTITY RECORDS, against the Firestore + RTDB EMULATORS.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:identity-records
//
// On the REAL writers (publishVersion, rollbackVersion, bootstrapIdentityStamps, makeRtdbMirror, the D4-a context
// writer) and the DEPLOYED function objects (writeIdentityRecordOnMirror / reconcileIdentityRecords /
// verifyIdentityRecords, driven through their own `.run`). Expected values come from Firestore and the plan, never from
// the code under test. PLAN-D4c1 rev 7 §6 "Plus new" + codex c1 r7 S1 (named cursor / head scenarios).
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
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
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { keysColOf, encodeKey } = require('../catalog/identity-registry');
const { CONTEXT_PATH } = require('../catalog/context-writer');
const { canonicalJson } = require('../catalog/canonical-json');
const R = require('../catalog/identity-record');
const W = require('../catalog/identity-record-writer');
const V = require('../catalog/identity-record-verifier');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-records(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
const capture = (k, d) => logs.push({ k, d });
const vrefOf = (rid, v) => fs.collection('restaurants').doc(rid).collection('versions').doc(v);
const nodeOf = async (rid, v) => (await rtdb.ref(`${R.IDENTITY_PATH}/${rid}/${v}`).get()).val();
const writer = (extra = {}) => W.createIdentityRecordWriter({ db: fs, rtdb, log: capture, ...extra });
const mirrorEvent = (rid, value) => ({ params: { rid }, data: { before: null, after: { val: () => value } } });

// ── Fixtures through the real writers (the D4-a recipe) ───────────────────────────────────────────────
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
  const { input } = buildPublishCandidate(dataFrom, { activeVersionId: null }, { source_sha: `idr-${rid}` });
  const res = await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await vrefOf(rid, res.versionId).update({ identity_activation: admin.firestore.FieldValue.delete() });
  await backfillIdentities(fs, rid, catalogSnapshot(dataFrom), { captured: await getActivePointer(fs, rid) });
  await asPreP1(rid, res.versionId);
  return res.versionId;
}
// A publish from the STORED SOURCE (what production does once certified — it carries the stamps; D4-a's recipe).
async function republish(rid, dataFrom, sha) {
  const src = (await sourceRefOf(fs, rid).get()).data();
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(dataFrom, { formData: inputs.formData, priceTable: inputs.priceTable });
  const input = { items: built.items, structure: built.structure, extras: inputs.extras,
    extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })), source_sha: sha };
  const cur = await getActivePointer(fs, rid);
  return publishVersion(fs, rid, input, { expected: { activeVersionId: cur.version }, mirror: makeRtdbMirror(rtdb) });
}
const mirrorVal = async (rid) => (await rtdb.ref(`catalog_snapshot/${rid}`).get()).val();

(async () => {
  // ═══ SETUP ═══════════════════════════════════════════════════════════════════════════════════════════
  const xV1 = await seedPreP1('x_pizza');
  const lV1 = await seedPreP1('la_musa');
  const sV1 = await seedPreP1('synthetic_3', { dataFrom: 'x_pizza' });
  const uV1 = await seedPreP1('synthetic_uncert', { dataFrom: 'x_pizza' });
  // revision 0 → 1 discovery: record the PRE-certification state FIRST, then certify through the real bootstrap
  const w0 = writer();
  const pre = await w0.writeVersion('x_pizza', xV1, { source: 'test' });
  assert.ok(pre.committed && pre.outcomes.includes('inserted') && pre.outcomes.includes('head_advanced'), JSON.stringify(pre));
  const preHead = (await nodeOf('x_pizza', xV1)).head;
  assert.strictEqual(preHead.ck.revision, 0, 'premise — the pre-P1 version is revision 0');
  for (const rid of ['x_pizza', 'synthetic_3']) assert.strictEqual((await bootstrapIdentityStamps(fs, rid)).stamped, true, `premise — ${rid} certified by the REAL bootstrap`);
  assert.strictEqual((await vrefOf('x_pizza', xV1).get()).data().identity_revision, 1);
  assert.strictEqual((await vrefOf('la_musa', lV1).get()).data().identity_certified, undefined, 'premise — la_musa uncertified (as in production)');
  ok('fixtures through the real writers: x_pizza / synthetic_3 certified (revision 1); la_musa + synthetic_uncert uncertified; the x_pizza revision-0 record was written BEFORE certification');

  // ═══ §3b MEASUREMENT (UTF-8 bytes of the serialized RTDB value, incl. escaping) + the pinned constant ═══
  const measure = async (rid, v) => R.buildIdentityRecord(await W.readVersionSnapshot(fs, rid, v));
  // la_musa is uncertified in production (and its keys are rid-bound, so its data cannot be published under another
  // id): its CERTIFIED shape is measured from its own snapshot carrying exactly what the bootstrap writes — each
  // object's display.identity_id from the registry, identity_certified, identity_revision 1.
  const certifiedShape = async (rid, v) => {
    const s = await W.readVersionSnapshot(fs, rid, v);
    for (const [rows, kind] of [[s.items, 'dish'], [s.extras, 'extra']]) {
      for (const r of rows) {
        const row = (await keysColOf(fs, rid, kind).doc(encodeKey(r.data.key)).get()).data();
        assert.ok(row && row.canonical_id, `premise — ${rid} ${kind} ${r.data.key} is registered`);
        r.data = { ...r.data, display: { ...r.data.display, identity_id: row.canonical_id } };
      }
    }
    s.record = { ...s.record, identity_certified: true, identity_revision: 1 };
    return R.buildIdentityRecord(s);
  };
  const m = {
    x_pizza_certified: await measure('x_pizza', xV1), la_musa_uncertified: await measure('la_musa', lV1), la_musa_certified: await certifiedShape('la_musa', lV1),
  };
  assert.ok(m.la_musa_certified.ok && m.la_musa_certified.context.complete === true, 'la_musa\'s certified shape is complete (every object stamped)');
  for (const [k, r] of Object.entries(m)) assert.ok(r.ok, `${k}: ${r.reason}`);
  const bytes = Object.fromEntries(Object.entries(m).map(([k, r]) => [k, r.bytes]));
  for (const [k, r] of Object.entries(m)) assert.strictEqual(r.bytes, Buffer.byteLength(JSON.stringify(r.record), 'utf8'), `${k}: bytes = UTF-8 of the serialized value`);
  const largest = Math.max(bytes.x_pizza_certified, bytes.la_musa_certified, bytes.la_musa_uncertified);
  console.log(`    §3b measured record bytes: ${JSON.stringify(bytes)} → 4 × ${largest} = ${4 * largest}; RECORD_BOUND_BYTES = ${R.RECORD_BOUND_BYTES}; node cap ${R.NODE_CAP_BYTES}`);
  // 🔴 PINNED: the measured numbers (any catalog growth that moves them fails here and forces a re-measure) and the
  // constant derived from them (4 × the larger, rounded UP to the next KiB).
  const MEASURED = { x_pizza_certified: 12211, la_musa_uncertified: 19949, la_musa_certified: 21787 };
  assert.deepStrictEqual(bytes, MEASURED, '🔴 the §3b measurement moved — re-measure and re-pin RECORD_BOUND_BYTES');
  assert.strictEqual(R.RECORD_BOUND_BYTES, Math.ceil((4 * largest) / 1024) * 1024, 'RECORD_BOUND_BYTES = 4 × the larger record, rounded up to a KiB');
  assert.strictEqual(R.NODE_CAP_BYTES, 8 * R.RECORD_BOUND_BYTES + 4096);
  ok(`§3b: records measured from the real writers ${JSON.stringify(bytes)} bytes; RECORD_BOUND_BYTES = ${R.RECORD_BOUND_BYTES} (4 × ${largest}, KiB-rounded), node cap = 8 × bound + 4 KB — both pinned`);

  // ═══ THE DEPLOYED TRIGGER: the version NAMED in the mirror value; trigger ≡ reconciler bytes; real-RTDB round trip ═══
  {
    const mv = await mirrorVal('x_pizza');
    assert.strictEqual(mv.version, xV1);
    await app.writeIdentityRecordOnMirror.run(mirrorEvent('x_pizza', mv));
    const node = await nodeOf('x_pizza', xV1);
    assert.strictEqual(Object.keys(node.records).length, 2, 'revision 0 AND revision 1 records (content-addressed: a changed input is a NEW record)');
    assert.strictEqual(node.head.ck.revision, 1, 'revision 0 → 1 discovered by reading head');
    assert.notStrictEqual(node.head.digest, preHead.digest);
    assert.deepStrictEqual(R.nodeInvariantProblems(node, { rid: 'x_pizza', versionId: xV1 }), [], 'invariants (i)–(iv) hold on the committed node');
    // trigger-vs-reconciler byte equality: the record the trigger committed == the one constructor's output now
    const again = await measure('x_pizza', xV1);
    assert.strictEqual(canonicalJson(node.records[node.head.digest]), canonicalJson(again.record), 'trigger and reconciler build the SAME bytes (one constructor)');
    // real-RTDB round trip: every record still validates (RTDB stripping did not reshape the canonical string)
    for (const [d, rec] of Object.entries(node.records)) assert.ok(R.validateRecord(d, rec, { rid: 'x_pizza', versionId: xV1 }).ok, `${d.slice(0, 8)} survives RTDB`);
    // a NAMED older version: the trigger records exactly that version, never the active one
    const named = await republish('x_pizza', 'x_pizza', 'idr-x2');
    const before = await nodeOf('x_pizza', named.versionId);
    assert.strictEqual(before, null, 'premise — the new version has no record yet');
    await app.writeIdentityRecordOnMirror.run(mirrorEvent('x_pizza', { version: xV1, seq: mv.seq }));
    assert.strictEqual(await nodeOf('x_pizza', named.versionId), null, '🔴 the trigger covers ONLY the event\'s named version');
    await app.writeIdentityRecordOnMirror.run(mirrorEvent('x_pizza', await mirrorVal('x_pizza')));
    assert.ok((await nodeOf('x_pizza', named.versionId)).head, 'the mirror\'s (new) version recorded by its own event');
    globalThis.__xV2 = named.versionId;
  }
  ok('deployed trigger: records the version NAMED in the mirror value (and only it); revision 0 → 1 discovered (2 records, head at revision 1); trigger bytes == the one constructor\'s; every record survives a real-RTDB round trip; invariants hold');

  // ═══ TRIGGER EDGE CASES: deleted / malformed / repeated / burst, and isolation from the D4-a trigger ═══
  {
    for (const bad of [null, 'x', 42, {}, { version: '' }, { version: 'a/b' }, { version: 7 }]) {
      const r = await writer().onMirrorWritten('la_musa', bad);
      assert.ok(['deleted_noop', 'malformed_noop'].includes(r.outcomes[0]), `${JSON.stringify(bad)} → ${r.outcomes}`);
    }
    assert.strictEqual(await nodeOf('la_musa', lV1), null, 'no node from a deleted/malformed event');
    const lm = await mirrorVal('la_musa');
    const first = await writer().onMirrorWritten('la_musa', lm);
    assert.ok(first.committed && first.outcomes.includes('inserted'));
    const snapA = canonicalJson(await nodeOf('la_musa', lV1));
    for (let i = 0; i < 3; i++) {
      const rep = await writer().onMirrorWritten('la_musa', lm);
      assert.deepStrictEqual([rep.committed, rep.outcomes.sort()], [false, ['exists', 'head_unchanged']], 'a repeated event is a no-op');
    }
    assert.strictEqual(canonicalJson(await nodeOf('la_musa', lV1)), snapA, 'byte-identical after repeats');
    // burst: 24 concurrent identity events + the D4-a trigger concurrently — everything settles; D4-a's node is written
    await rtdb.ref(`${CONTEXT_PATH}/la_musa`).remove();
    const burst = await Promise.all([
      ...Array.from({ length: 24 }, () => app.writeIdentityRecordOnMirror.run(mirrorEvent('la_musa', lm))),
      app.writeCatalogContextOnMirror.run(mirrorEvent('la_musa', lm)),
    ]);
    assert.strictEqual(burst.length, 25);
    assert.strictEqual((await rtdb.ref(`${CONTEXT_PATH}/la_musa`).get()).val().head.versionId, lV1, 'the D4-a trigger is unaffected by the burst');
    assert.strictEqual(canonicalJson(await nodeOf('la_musa', lV1)), snapA, 'the burst left the identity node byte-identical (idempotent)');
    // a HUNG identity invocation: the D4-a trigger's result and a publish are unaffected (separate invocations)
    const never = () => new Promise(() => {});
    const hungDb = { collection: () => ({ doc: () => ({ collection: () => ({}) }) }), runTransaction: never };
    const hung = W.createIdentityRecordWriter({ db: hungDb, rtdb, log: capture });
    const t0 = Date.now();
    const pending = hung.writeVersion('la_musa', lV1, { deadlineMs: 400, source: 'test' });
    await rtdb.ref(`${CONTEXT_PATH}/la_musa`).remove();
    await app.writeCatalogContextOnMirror.run(mirrorEvent('la_musa', lm));
    assert.strictEqual((await rtdb.ref(`${CONTEXT_PATH}/la_musa`).get()).val().head.versionId, lV1, 'the D4-a trigger completes while an identity invocation hangs');
    const pub = await republish('synthetic_uncert', 'x_pizza', 'idr-u2');
    assert.ok(pub.versionId && pub.ok !== false, 'a publish completes while an identity invocation hangs');
    const hr = await pending;
    assert.deepStrictEqual([hr.outcomes, hr.settled], [['timeout'], false]);
    assert.ok(Date.now() - t0 < 5000, 'the hung identity write is bounded by its deadline');
  }
  ok('trigger edges: deleted/malformed payloads → logged no-op; repeated events → exists/head_unchanged, no write; a 24-event burst + the D4-a trigger all settle (D4-a written, identity node byte-identical); a HUNG identity invocation is bounded (timeout) and leaves the D4-a trigger and a publish unaffected');

  // ═══ PARTIAL OLD-EXECUTABLE CERTIFICATION: ck_conflict → recovery by the final certification's greater CK ═══
  {
    const rid = 'oldexec';
    const v = await seedPreP1(rid, { dataFrom: 'x_pizza' });
    const r0 = await writer().writeVersion(rid, v, { source: 'test' });
    assert.ok(r0.committed);
    const h0 = (await nodeOf(rid, v)).head;
    // the old executable writes stamps ONE AT A TIME (no revision bump; the version record is untouched until the end)
    const vref = vrefOf(rid, v);
    const docs = (await vref.collection('menu_items').get()).docs;
    const stampOne = async (doc) => {
      const row = (await keysColOf(fs, rid, 'dish').doc(encodeKey(doc.data().key)).get()).data();
      await doc.ref.update({ 'display.identity_id': row.canonical_id });
    };
    await stampOne(docs[0]);   // captured MID-WRITE: same record updateTime → equal CK, different content
    const mid = await writer().writeVersion(rid, v, { source: 'test' });
    assert.ok(mid.outcomes.includes('ck_conflict'), `equal CK + different digest → ck_conflict (${mid.outcomes})`);
    const hMid = (await nodeOf(rid, v)).head;
    assert.deepStrictEqual(hMid, h0, 'head unchanged by the conflicting capture');
    assert.ok(mid.outcomes.includes('inserted'), 'its historical record is still inserted (content-addressed)');
    for (const d of docs.slice(1)) await stampOne(d);
    for (const d of (await vref.collection('extras').get()).docs) {
      const row = (await keysColOf(fs, rid, 'extra').doc(encodeKey(d.data().key)).get()).data();
      await d.ref.update({ 'display.identity_id': row.canonical_id });
    }
    await vref.update({ identity_certified: true });   // the final certification: the record's updateTime advances
    assert.strictEqual((await vref.get()).data().identity_revision, undefined, 'premise — NO revision bump (old executable)');
    const fin = await writer().writeVersion(rid, v, { source: 'test' });
    assert.ok(fin.outcomes.includes('head_advanced'), `recovered by the greater CK (${fin.outcomes})`);
    const node = await nodeOf(rid, v);
    assert.strictEqual(node.head.ck.revision, 0);
    assert.ok(node.records[node.head.digest].certified === true, 'the head is the certified content');
    assert.deepStrictEqual(R.nodeInvariantProblems(node, { rid, versionId: v }), []);
    assert.strictEqual(Object.keys(node.records).length, 3, 'pre, mid-write and final records — none overwritten');
  }
  ok('partial old-executable certification (no revision bump): a mid-write capture has an EQUAL CK and a different digest → ck_conflict, head unchanged, its record kept; the final certification\'s greater CK recovers (head_advanced to the certified record)');

  // ═══ ROLLBACK to a lower seq: the mirror names the older version; its record is head-valid ═══
  {
    const back = await rollbackVersion(fs, 'x_pizza', xV1, { expected: { activeVersionId: globalThis.__xV2 }, mirror: makeRtdbMirror(rtdb) });
    assert.ok(back && back.ok !== false, JSON.stringify(back));
    const mv = await mirrorVal('x_pizza');
    assert.strictEqual(mv.version, xV1, 'premise — the mirror re-emits the lower-seq target');
    const r = await writer().onMirrorWritten('x_pizza', mv);
    assert.deepStrictEqual([r.committed, r.outcomes.sort()], [false, ['exists', 'head_unchanged']], 'its record already exists and is head-valid');
    const res = R.identityFromVersionNode(await nodeOf('x_pizza', xV1), { rid: 'x_pizza', versionId: mv.version, seq: mv.seq, prices: { menu: mv.menu, extras: mv.extras } }, { rid: 'x_pizza', versionId: xV1 });
    assert.deepStrictEqual([res.availability, res.certified, res.complete, res.attached, res.usableForWriting], ['available', true, true, true, true]);
  }
  ok('rollback to a lower seq: the mirror names the older version, whose record exists and attaches to the mirror\'s own version/seq/tables (usableForWriting)');

  // ═══ THE DEPLOYED RECONCILER + retained paging across several runs, a stalled run, stability ═══
  {
    const rid = 'many';
    const v1 = await seedPreP1(rid, { dataFrom: 'x_pizza' });
    // 23 retained versions: copies of v1 under new ids + seqs (direct Firestore writes — fast; the content is real)
    const src = vrefOf(rid, v1);
    const rec = (await src.get()).data();
    const sub = {};
    for (const col of ['menu_items', 'extras']) sub[col] = (await src.collection(col).get()).docs.map((d) => [d.id, d.data()]);
    const structure = (await src.collection('meta').doc('menu_structure').get()).data();
    const ids = [];
    for (let i = 0; i < 22; i++) {
      const id = `${v1}-c${String(i).padStart(2, '0')}`;
      const ref = vrefOf(rid, id);
      await ref.set({ ...rec, version: id, seq: (rec.seq || 1) + 1 + i });
      for (const col of ['menu_items', 'extras']) for (const [did, d] of sub[col]) await ref.collection(col).doc(did).set(d);
      await ref.collection('meta').doc('menu_structure').set(structure);
      ids.push(id);
    }
    const all = [v1, ...ids];
    const w = writer();
    const readers = { ...w.readers };
    // run 1..k with a page of 5: each run checkpoints a contiguous prefix; generations wrap after the last page
    const runOnce = () => w.reconcile({ listIds: async () => [rid], pageSize: 5, r: readers });
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      runs.push(await runOnce());
      const r0 = runs[runs.length - 1].results[0];
      console.log(`    §3 measured: run ${i + 1} settled ${r0.versions.filter((x) => x.settled).length} retained versions + ${Object.keys(r0.rungs).length} rungs in ${Date.now() - t0} ms (emulator; page 5)`);
    }
    const recorded = [];
    for (const v of all) if (await nodeOf(rid, v)) recorded.push(v);
    assert.strictEqual(recorded.length, all.length, `every retained version recorded across runs (${recorded.length}/${all.length})`);
    const cur = (await rtdb.ref(`${W.VERSION_CURSOR_PATH}/${rid}`).get()).val();
    assert.ok(cur.generation >= 1, `the version cursor wrapped (generation ${cur.generation})`);
    // a cursor ALREADY past the last version (e.g. versions pruned since its checkpoint): the run wraps to the NEXT generation
    const cref = rtdb.ref(`${W.VERSION_CURSOR_PATH}/${rid}`);
    await cref.set({ generation: 7, position: { seq: -5, versionId: 'zzzz' } });
    await runOnce();
    assert.deepStrictEqual(W.normCursor((await cref.get()).val()), { generation: 8, position: null }, 'past-the-end → generation + 1, from the top');
    // stability: a further pass commits nothing
    const quiet = await runOnce();
    const vouts = quiet.results[0].versions.concat(Object.values(quiet.results[0].rungs));
    assert.ok(vouts.every((x) => !x.outcomes.includes('inserted') && !x.outcomes.includes('head_advanced')), 'a repeated pass is idempotent');
    // a STALLED run: a hung version read → the restaurant budget expires, nothing settles, the cursor does NOT move
    const before = (await rtdb.ref(`${W.VERSION_CURSOR_PATH}/${rid}`).get()).val();
    const never = () => new Promise(() => {});
    const stalled = W.createIdentityRecordWriter({ db: { collection: (...a) => fs.collection(...a), runTransaction: never }, rtdb, log: capture });
    const t0 = Date.now();
    const sr = await stalled.reconcile({ listIds: async () => [rid], pageSize: 5, restaurantBudgetMs: 1500, runBudgetMs: 3000,
      r: { ...stalled.readers, mirrorVersionId: async () => null, activeVersionId: async () => null } });
    assert.ok(Date.now() - t0 < 6000, 'the stalled run is bounded');
    assert.strictEqual(sr.results[0].cursor && sr.results[0].cursor.advanced, false, 'nothing settled → no checkpoint');
    assert.deepStrictEqual((await rtdb.ref(`${W.VERSION_CURSOR_PATH}/${rid}`).get()).val(), before, 'the cursor did not move');
    // the deployed scheduled function runs end-to-end over the Firestore registry
    await app.reconcileIdentityRecords.run({});
    globalThis.__many = { rid, all };
  }
  ok('reconciler: 23 retained versions recorded across several runs (page 5, contiguous-prefix checkpoints, the cursor wraps to the next generation); a repeated pass is idempotent; a STALLED run (hung read) is bounded, checkpoints nothing and leaves the cursor unmoved; the deployed reconcileIdentityRecords runs over the Firestore registry');

  // ═══ codex c1 r7 S1 — CURSOR overlap + wraparound, on BOTH cursors ═══
  {
    for (const path of [`${W.VERSION_CURSOR_PATH}/cas_probe`, W.RESTAURANT_CURSOR_PATH]) {
      const ref = rtdb.ref(path);
      await ref.set({ generation: 4, position: path.includes('probe') ? { seq: 30, versionId: 'v30' } : 'aaa' });
      const observed = await W.readCursor(ref);   // two runs observe the SAME cursor
      const farther = path.includes('probe') ? { generation: 4, position: { seq: 10, versionId: 'v10' } } : { generation: 4, position: 'mmm' };
      const partial = path.includes('probe') ? { generation: 4, position: { seq: 25, versionId: 'v25' } } : { generation: 4, position: 'ccc' };
      assert.strictEqual(await W.casCursor(ref, observed, farther), true, 'the faster run commits the farther checkpoint');
      assert.strictEqual(await W.casCursor(ref, observed, partial), false, '🔴 the slower partial checkpoint cannot replace it');
      assert.deepStrictEqual(W.normCursor((await ref.get()).val()), W.normCursor(farther));
      // wraparound: a run wraps to the next generation; a stale pre-wraparound checkpoint cannot replace it
      const obs2 = await W.readCursor(ref);
      const stale = { ...obs2 };   // captured before the wrap
      assert.strictEqual(await W.casCursor(ref, obs2, { generation: 5, position: null }), true, 'wrap → generation 5');
      const lateCheckpoint = path.includes('probe') ? { generation: 4, position: { seq: 5, versionId: 'v05' } } : { generation: 4, position: 'zzz' };
      assert.strictEqual(await W.casCursor(ref, stale, lateCheckpoint), false, '🔴 a stale pre-wraparound checkpoint cannot replace the next generation');
      assert.deepStrictEqual(W.normCursor((await ref.get()).val()), { generation: 5, position: null });
    }
    // and through the real reconcile: two OVERLAPPING runs over the restaurant cursor — the slower one (fewer restaurants
    // processed, a stale observation) loses its CAS, never moving the cursor backwards
    await rtdb.ref(W.RESTAURANT_CURSOR_PATH).remove();
    const rids = ['ov_a', 'ov_b', 'ov_c', 'ov_d'];
    let releaseSlow; const slowGate = new Promise((r) => { releaseSlow = r; });
    const quick = writer();
    const slow = writer();
    const noRungs = { mirrorVersionId: async () => null, activeVersionId: async () => null, listVersions: async () => [] };
    const slowRun = slow.reconcile({ listIds: async () => rids, restaurantBudgetMs: 5000, r: { ...noRungs, listVersions: async (rid) => { if (rid === 'ov_a') await slowGate; return []; } } });
    await wait(150);   // the slow run has observed the cursor and is stuck in ov_a
    const quickRun = await quick.reconcile({ listIds: async () => rids, r: noRungs });
    assert.strictEqual(quickRun.cas, true, 'the quick run wraps the restaurant cursor');
    releaseSlow();
    const slowRes = await slowRun;
    assert.strictEqual(slowRes.cas, false, '🔴 the overlapping (stale) run loses its CAS');
    assert.deepStrictEqual(W.normCursor((await rtdb.ref(W.RESTAURANT_CURSOR_PATH).get()).val()), quickRun.cursor, 'the cursor keeps the quick run\'s value');
  }
  ok('codex r7 S1 — on BOTH the retained-version and the restaurant cursor: two runs observing the same cursor → the slower partial checkpoint cannot replace the farther one; a stale pre-wraparound checkpoint cannot replace the next generation; two overlapping real reconcile runs → the stale one loses its CAS');

  // ═══ ROUND-ROBIN: a run budget never starves later restaurants ═══
  {
    await rtdb.ref(W.RESTAURANT_CURSOR_PATH).remove();
    const rids = ['rr_1', 'rr_2', 'rr_3', 'rr_4', 'rr_5'];
    const seenRids = [];
    const slowRungs = { mirrorVersionId: async (rid) => { seenRids.push(rid); await wait(400); return null; }, activeVersionId: async () => null, listVersions: async () => [] };
    const w = writer();
    for (let i = 0; i < 4; i++) await w.reconcile({ listIds: async () => rids, runBudgetMs: 900, restaurantBudgetMs: 800, r: slowRungs });
    for (const rid of rids) assert.ok(seenRids.includes(rid), `${rid} reached by round-robin (${seenRids.join(',')})`);
  }
  ok('round-robin: with a run budget that fits ~2 restaurants, successive runs resume from the persisted restaurant cursor and reach every restaurant');

  // ═══ THE DEPLOYED VERIFIER: positive counts per restaurant and per rung-version ═══
  {
    for (const rid of ['x_pizza', 'la_musa', 'synthetic_3', 'synthetic_uncert']) {
      const r = await writer().onMirrorWritten(rid, await mirrorVal(rid));
      assert.ok(r.settled, `${rid}: ${r.outcomes}`);
    }
    await rtdb.ref(V.VERIFY_RESTAURANT_CURSOR_PATH).remove();
    const vlogs = [];
    const ver = V.createIdentityVerifier({ db: fs, rtdb, log: (k, d) => vlogs.push({ k, d }) });
    const res = await ver.verify({ listIds: async () => ['x_pizza', 'la_musa', 'synthetic_3', 'synthetic_uncert'] });
    const by = Object.fromEntries(res.results.map((r) => [r.rid, Object.fromEntries(r.rungs.map((x) => [x.rung, x]))]));
    for (const rid of ['x_pizza', 'synthetic_3']) {
      for (const rung of ['mirror', 'active']) {
        assert.strictEqual(by[rid][rung].category, 'attached_agree', `${rid}/${rung}: ${JSON.stringify(by[rid][rung])}`);
        assert.deepStrictEqual([by[rid][rung].record.usableForWriting, by[rid][rung].d4a.usable], [true, true], `${rid}/${rung} usable on both sides`);
      }
    }
    for (const rid of ['la_musa', 'synthetic_uncert']) {
      for (const rung of ['mirror', 'active']) {
        assert.strictEqual(by[rid][rung].category, 'attached_agree', `${rid}/${rung}`);
        assert.deepStrictEqual([by[rid][rung].record.certified, by[rid][rung].record.usableForWriting, by[rid][rung].d4a.usable], [false, false, false], `${rid} uncertified: certified:false, not usable — agreeing with D4-a`);
      }
    }
    const runLog = vlogs.find((l) => l.k === 'identity_record_check_run');
    assert.ok(runLog.d.totals['mirror:attached_agree'] >= 4 && runLog.d.totals['active:attached_agree'] >= 4, `POSITIVE counts per rung: ${JSON.stringify(runLog.d.totals)}`);
    assert.strictEqual(vlogs.filter((l) => l.k === 'identity_record_check').length, 4, 'one identity_record_check per restaurant');
    // a mirror whose tables differ from the served prices → not attached on BOTH sides (never inferred from the record)
    const lm = await mirrorVal('la_musa');
    const k0 = Object.keys(lm.menu)[0];
    const badServed = { rid: 'la_musa', versionId: lm.version, seq: lm.seq, prices: { menu: { ...lm.menu, [k0]: lm.menu[k0] + 1 }, extras: lm.extras } };
    const chk = await ver.checkRung('la_musa', 'mirror', badServed);
    assert.strictEqual(chk.category, 'not_attached');
    const wrongSeq = await ver.checkRung('la_musa', 'mirror', { ...badServed, seq: lm.seq + 1, prices: { menu: lm.menu, extras: lm.extras } });
    assert.strictEqual(wrongSeq.category, 'not_attached', 'a wrong seq does not attach');
    // a record removed → unavailable (never certified:false)
    await rtdb.ref(`${R.IDENTITY_PATH}/synthetic_uncert`).remove();
    const gone = await ver.checkRung('synthetic_uncert', 'active', await ver.readers.activeServed('synthetic_uncert', (await getActivePointer(fs, 'synthetic_uncert')).version));
    assert.strictEqual(gone.category, 'unavailable');
    await app.verifyIdentityRecords.run({});   // the deployed scheduled function runs end-to-end
  }
  ok('verifier: per restaurant and per rung-version POSITIVE attached_agree counts (certified → usable on both sides; uncertified → certified:false, unusable on both); wrong prices / wrong seq → not_attached; a removed record → unavailable; the deployed verifyIdentityRecords runs end-to-end');

  // ═══ COLD, FIRESTORE-INDEPENDENT LOAD (mirror rung) ═══
  {
    // a fresh RTDB handle, nothing prewarmed, and NO Firestore anywhere in the load path
    const coldApp = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT, databaseURL: admin.app().options.databaseURL }, 'cold');
    const coldRtdb = coldApp.database();
    const mv = await mirrorVal('x_pizza');
    const t0 = Date.now();
    const loaded = await V.loadVersionNode(coldRtdb, 'x_pizza', mv.version);
    assert.ok(!loaded.error && Date.now() - t0 < V.IDENTITY_LOAD_TIMEOUT_MS, `cold load within ${V.IDENTITY_LOAD_TIMEOUT_MS} ms`);
    const res = R.identityFromVersionNode(loaded.node, { rid: 'x_pizza', versionId: mv.version, seq: mv.seq, prices: { menu: mv.menu, extras: mv.extras } }, { rid: 'x_pizza', versionId: mv.version });
    assert.deepStrictEqual([res.availability, res.usableForWriting], ['available', true]);
    const hung = { ref: () => ({ get: () => new Promise(() => {}) }) };
    const t1 = Date.now();
    assert.deepStrictEqual(await V.loadVersionNode(hung, 'x_pizza', mv.version), { error: 'timeout' });
    assert.ok(Date.now() - t1 < V.IDENTITY_LOAD_TIMEOUT_MS + 500, 'a hung RTDB read is bounded at 1,500 ms');
    await coldApp.delete();
  }
  ok('cold, Firestore-independent load: a fresh RTDB handle with nothing prewarmed loads + decodes + attaches the mirror rung\'s record within 1,500 ms; a hung read times out at the bound');

  // ═══ ZERO WRITES ELSEWHERE: the D4-a node, the price mirror and Firestore versions are untouched by the identity writers ═══
  {
    const snap = async () => canonicalJson({
      ctx: (await rtdb.ref(CONTEXT_PATH).get()).val(),
      mirror: (await rtdb.ref('catalog_snapshot').get()).val(),
      ptr: (await fs.collection('restaurants').doc('x_pizza').collection('active').get()).docs.map((d) => [d.id, d.data()]),
      ver: (await vrefOf('x_pizza', xV1).get()).updateTime.toMillis(),
    });
    const before = await snap();
    const w = writer();
    await w.reconcile({ listIds: async () => ['x_pizza', 'la_musa', 'synthetic_3'] });
    await w.onMirrorWritten('x_pizza', await mirrorVal('x_pizza'));
    await V.createIdentityVerifier({ db: fs, rtdb, log: () => {} }).verify({ listIds: async () => ['x_pizza', 'la_musa'] });
    assert.strictEqual(await snap(), before, '🔴 catalog_snapshot_ctx, catalog_snapshot, the pointer and the version record are byte-identical');
  }
  ok('zero writes elsewhere: after the identity trigger, reconciler and verifier ran, catalog_snapshot_ctx (D4-a), catalog_snapshot (the price mirror), the active pointer and the version record are byte-identical');

  FINISHED = true;
  console.log(`identity-records(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('identity-records(emulator) FAILED:', e); process.exit(1); });
