'use strict';
require('./_emulator-required')('firestore');
/**
 * 1D D4-c2a — the §2b READER ADDRESSING CONTRACT, proven against evidence written by the REAL writers (PLAN-D4c2a rev 12 §2b,
 * §6 "§2b addressing harness"). TEST-ONLY: no c2b reader ships in c2a; the three queries below are the contract c2b will
 * implement, exercised here so the id scheme and the one kept `vid` index are shown to answer them.
 *   audit         direct get of g{G20(g)} for g in checkpoint+1 … current pointer generation — WITHOUT any version id
 *   certification document-name range [c{G20(gen)}_, c{G20(gen)}_), limit(8)
 *   origin        where('vid','==',H(v)) + document-name range ['g','g') + orderBy(__name__) + limit(1) → binding iff
 *                 intent==='publish' && certified===true; else the same on ['c','c') → the earliest certification;
 *                 else history_unknown.
 * Real-writer history: several DIFFERENT versions activated between two checkpoints, rollbacks, mixed certification (incl.
 * publish V uncertified → bootstrap V → publish W → rollback to V), a version whose original publish is pre-c2a, and a
 * MISSING intermediate generation doc (an old-CLI activation). Run: npm run test:c2a-addressing
 * 🔴 STATED LIMIT: the Firestore EMULATOR does not enforce index requirements, so this proves the queries' SEMANTICS, not that
 * the single kept `vid` index serves them in production — that is verified at deploy (plan §5: `gcloud firestore indexes
 * fields describe`) and by codex's review of the index contract.
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { FieldPath } = require('firebase-admin/firestore');
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { sourceToBuildInputs, encodeUpdateTime, sourceRefOf } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { bootstrapIdentityStamps } = require('../catalog/identity-bootstrap');
const E = require('../catalog/identity-evidence');
const { H } = require('../catalog/evidence-encoding');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('c2a-addressing: FAILED — exited without completing'); process.exitCode = 1; } });
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza' });
const db = admin.firestore();
const RID = `synth_addr_${Date.now() % 100000}`;
const col = () => db.collection('restaurants').doc(RID).collection(E.EVIDENCE_COL);
const ID = FieldPath.documentId();

// ── the §2b contract (test-only reader) ──────────────────────────────────────────────────────────────────────────
async function audit(fromGen, toGen) {
  const out = [];
  for (let g = fromGen; g <= toGen; g += 1) {
    const s = await col().doc(E.activationDocId(g)).get();
    out.push({ generation: g, doc: s.exists ? s.data() : null });
  }
  return out;
}
async function certificationsAt(gen) {
  const pre = `c${E.G20(gen)}_`;
  const q = await col().where(ID, '>=', pre).where(ID, '<', `${pre}`).orderBy(ID).limit(8).get();
  return q.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function origin(versionId) {
  const vid = H(versionId);
  const first = await col().where('vid', '==', vid).where(ID, '>=', 'g').where(ID, '<', 'g').orderBy(ID).limit(1).get();
  if (first.docs.length) {
    const d = first.docs[0].data();
    if (d.intent === 'publish' && d.certified === true) return { kind: 'publish', id: first.docs[0].id };
  }
  const cert = await col().where('vid', '==', vid).where(ID, '>=', 'c').where(ID, '<', 'c').orderBy(ID).limit(1).get();
  if (cert.docs.length) return { kind: 'certification', id: cert.docs[0].id };
  return { kind: 'history_unknown' };
}

// ── real writers ─────────────────────────────────────────────────────────────────────────────────────────────────
function zeroExtrasSource() {
  const t = JSON.parse(JSON.stringify(buildSourceFromCode('x_pizza')));
  t.extras = [];
  t.structure = { ...t.structure, extra_categories: [], extras_by_category: Object.fromEntries(Object.keys(t.structure.extras_by_category || {}).map((k) => [k, []])),
    exposure: { ...(t.structure.exposure || {}), category_allow: Object.fromEntries(Object.keys((t.structure.exposure || {}).category_allow || {}).map((k) => [k, []])), item_overrides: {} } };
  for (const it of t.items) { if (it.display) delete it.display.identity_id; }
  return t;
}
async function publish(expected, tag, bumpPrice = 0) {
  const snap = await sourceRefOf(db, RID).get();
  const src = snap.data();
  if (bumpPrice) { src.items[0].price += bumpPrice; if (src.items[0].display) src.items[0].display.price = src.items[0].price; await sourceRefOf(db, RID).set(src); }
  const s2 = await sourceRefOf(db, RID).get();
  const i = sourceToBuildInputs(s2.data());
  const b = buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable });
  const r = await publishVersion(db, RID, { items: b.items, structure: b.structure, extras: i.extras, extraRecords: [], source_sha: tag },
    { expected: { activeVersionId: expected, draftRevision: encodeUpdateTime(s2.updateTime) } });
  return r.versionId || r.version_id || r;
}
const rollback = async (to) => { const cur = await getActivePointer(db, RID); await rollbackVersion(db, RID, to, { expected: { activeVersionId: cur.version } }); };

(async () => {
  await sourceRefOf(db, RID).set(zeroExtrasSource());
  const truth = [];                                   // ground truth, kept by the TEST only: [generation, versionId]
  const note = async () => { const p = await getActivePointer(db, RID); truth.push([p.generation, p.version]); return p; };

  // a version whose original publish is PRE-c2a: published certified, then its evidence removed as if it predated c2a
  const Z0 = await publish(null, 'z0'); await note();                                 // g1 uncertified (minimal)
  await bootstrapIdentityStamps(db, RID);                                               // c{1}_1 certifies Z0
  const Z = await publish(Z0, 'z', 1); const pz = await note();                       // g2 certified publish of Z
  await col().doc(E.activationDocId(pz.generation)).delete();                          // ← Z's origin "predates c2a"
  // checkpoint A
  const checkpointA = (await getActivePointer(db, RID)).generation;

  // rev 12 §2b's mixed-certification case, with V = Z0 and W = Z: publish Z0 UNCERTIFIED (g1, minimal) → bootstrap Z0 (c{1}_1)
  // → publish Z (g2) → ROLLBACK to Z0 (g3, now certified → full record). Z0's origin must be its CERTIFICATION, not the minimal g1.
  await rollback(Z0); await note();                                                    // g3 rollback to Z0
  const W = await publish(Z0, 'w', 1); await note();                                   // g4 certified publish of W
  const X = await publish(W, 'x', 1); await note();                                    // g5 certified publish of X
  await rollback(W); await note();                                                     // g6 rollback to W
  const Y = await publish(W, 'y', 1); const py = await note();                         // g7 certified publish of Y
  await rollback(Z); const pzr = await note();                                         // g8 rollback to Z (its original publish evidence is gone)
  // a MISSING intermediate generation: g7's evidence absent, as an old-CLI activation would leave it
  await col().doc(E.activationDocId(py.generation)).delete();
  const checkpointB = (await getActivePointer(db, RID)).generation;
  assert.ok(checkpointB - checkpointA >= 5, 'premise — several activations between the two checkpoints');

  // ── 1. AUDIT: direct generation discovery WITHOUT historical version ids ──────────────────────────────────────
  {
    const rows = await audit(checkpointA + 1, checkpointB);
    const want = truth.filter(([g]) => g > checkpointA && g <= checkpointB);
    assert.deepStrictEqual(rows.map((r) => r.generation), want.map(([g]) => g), 'every generation in the window is addressed');
    for (const r of rows) {
      const v = want.find(([g]) => g === r.generation)[1];
      if (r.generation === py.generation) { assert.strictEqual(r.doc, null, 'the missing intermediate generation reads as MISSING (an old-CLI activation)'); continue; }
      assert.ok(r.doc, `generation ${r.generation} has its evidence`);
      assert.strictEqual(r.doc.vid, H(v), `generation ${r.generation} names the version that was live (vid = H(versionId))`);
      assert.strictEqual(r.doc.generation, r.generation);
    }
    const distinct = new Set(rows.filter((r) => r.doc).map((r) => r.doc.vid));
    assert.ok(distinct.size >= 4, 'several DIFFERENT versions between the checkpoints');
    ok(`audit g${checkpointA + 1}…g${checkpointB} by DIRECT get of g{G20(g)} (no version id supplied): ${rows.length} generations, ${distinct.size} different versions, intents ${rows.filter((r) => r.doc).map((r) => r.doc.intent[0]).join('')}, and the missing intermediate g${py.generation} reported MISSING`);
  }

  // ── 2. the bounded certification range lookup ───────────────────────────────────────────────────────────────
  {
    const at1 = await certificationsAt(1);
    assert.deepStrictEqual(at1.map((c) => c.id), [E.certificationDocId(1, 1)], 'the certification observed at generation 1');
    assert.strictEqual(at1[0].vid, H(Z0)); assert.strictEqual(at1[0].kind, 'certify');
    for (const g of [0, 2, 10, 11, checkpointB]) assert.deepStrictEqual(await certificationsAt(g), [], `no certification at generation ${g} (prefix ranges do not bleed: 1 vs 10/11)`);
    // more certifications than the limit at one generation: the query stays bounded at 8
    for (let r = 2; r <= 12; r += 1) await col().doc(E.certificationDocId(5, r)).set({ v: 1, kind: 'certify', certified: true, vid: 'synthetic' });
    const at5 = await certificationsAt(5);
    assert.strictEqual(at5.length, 8, 'limit(8)');
    assert.deepStrictEqual(at5.map((c) => c.id), Array.from({ length: 8 }, (_, i) => E.certificationDocId(5, i + 2)), 'in revision order (zero-padded)');
    for (let r = 2; r <= 12; r += 1) await col().doc(E.certificationDocId(5, r)).delete();
    ok('certification range [c{G20(gen)}_, …\\uf8ff) limit(8): finds the real bootstrap certification at g1, nothing at g0/2/10/11 (no prefix bleed), and stays bounded at 8 in revision order when more exist');
  }

  // ── 3. ORIGIN, all three branches ─────────────────────────────────────────────────────────────────────────────
  {
    const oW = await origin(W);
    assert.deepStrictEqual(oW.kind, 'publish', 'W: earliest activation is its certified publish → the binding origin');
    assert.strictEqual(oW.id, E.activationDocId(truth.find(([, v]) => v === W)[0]));
    const oZ0 = await origin(Z0);
    assert.deepStrictEqual(oZ0, { kind: 'certification', id: E.certificationDocId(1, 1) },
      'Z0: published UNCERTIFIED (minimal, certified:false) then bootstrapped → the origin is the earliest certification, never the minimal record');
    const oZ = await origin(Z);
    assert.deepStrictEqual(oZ, { kind: 'history_unknown' },
      'Z: its original publish evidence predates c2a and its earliest remaining evidence is a ROLLBACK, which is never its own origin; no certification → history_unknown');
    assert.strictEqual(pzr.version, Z, 'premise — Z was reactivated by rollback');
    const oX = await origin(X);
    assert.strictEqual(oX.kind, 'publish');
    ok('origin: W → its certified publish (binding); Z0 (uncertified publish → bootstrap → later rollback) → its earliest CERTIFICATION; Z (publish pre-c2a, reactivated by rollback) → history_unknown; every query has an explicit limit');
  }

  FINISHED = true;
  console.log(`c2a-addressing: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('c2a-addressing FAILED:', e); process.exit(1); });
