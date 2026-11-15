'use strict';
// STRUCTURE S2 (PLAN-portal-structure-S2-ui r3 §3.4; LEDGER R-A) — the removal CLAIM end to end, the PORTAL's own code against the REAL
// cores on the emulator, la_musa CERTIFIED exactly as 5f's s2core.emulator.test.js seeds it (bootstrapIdentityStamps):
//   the portal's editor.js builds the draft and removes an extra (applyExposureOps → 5f's writer), decides whether the draft carries a
//   claim (mergeDeletionClaim — the ONE namer, R-A), and api.js editCatalog builds the request (deleted_ids_loaded_base) — its fetch is
//   routed to editCatalogCore; the base is the one getEditableCatalogCore SERVES (deletionBase).
//   C1  remove A → save (base sent) → 200, A claimed; the portal adopts the saved source
//   C2  remove B on the adopted draft → save (base sent) → 200, BOTH claimed
//   C3  the same removal WITHOUT the base → refused (nothing written)
//   C4  the published menu moves (another publish) → a save with the OLD base is refused deleted_ids_base_moved (nothing written)
// Run: npm run test:s2claim
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { pathToFileURL } = require('url');

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 's2claim-edit-secret-'.padEnd(48, 'x');

const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
// the server's S2 switch ON (as s2core.emulator.test.js) — the state S2 ships under
stub('../catalog/platform-structure', (r) => ({ ...r, structureCapabilities: () => ({ ...r.structureCapabilities(), extrasCatalog: true }) }));

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const rtdb = admin.database();
const db = admin.firestore();
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishVersion, previewVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { bootstrapIdentityStamps } = require('../catalog/identity-bootstrap');
const { getEditableCatalogCore } = require('../catalog/portal-reads');
const { publishEditedCore } = require('../catalog/publish-edited-handler');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2-portal-claim(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'la_musa';
const toPrecondition = (v) => {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new admin.firestore.Timestamp(Number(sec), Number(nanos));
};
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'owner@x.hn' });
const io = addProductIo({ fs: db, rtdb });
const readActiveBuilt = (rid) => async () => {
  const versionId = await getActiveVersionId(db, rid);
  const p = await previewVersion(db, rid, versionId);
  const extras = {}; for (const e of p.extras) extras[e.key] = e.price;
  return { built: { items: p.items, structure: p.structure, extras }, versionId, extraRecords: p.extras };
};
const editable = async () => { const r = await getEditableCatalogCore({ db: rtdb, fsdb: db, authorize: owner, readActiveVersionId: (f, r2) => getActiveVersionId(f, r2), readActiveBuilt: readActiveBuilt(RID) }, { method: 'GET', query: { restaurantId: RID } });
  assert.strictEqual(r.status, 200, `premise: the editable read (${JSON.stringify(r.body).slice(0, 160)})`); return r.body; };
const storedDraft = async () => (await sourceRefOf(db, RID).get()).data();

// the portal's api.js fetch → the REAL editCatalogCore (the body is exactly what the portal builds)
const SENT = [];
global.fetch = async (url, opts) => {
  const fn = String(url).split('cloudfunctions.net/')[1].split('?')[0];
  assert.strictEqual(fn, 'editCatalog', `only the save is routed (${fn})`);
  const body = JSON.parse(opts.body); SENT.push(body);
  const r = await editCatalogCore({ db, authorize: owner, readActiveBuilt: readActiveBuilt(RID), toPrecondition, addProduct: io }, body, {});
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};

async function seed() {
  await db.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'id', active: true, schema_version: 2 });
  await sourceRefOf(db, RID).set(canonicalize(buildSourceFromCode(RID)));
  const { input } = require('../tools/publish-version').buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'seed' });
  await publishVersion(db, RID, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, RID, catalogSnapshot(RID), { captured: await getActivePointer(db, RID) });
  const b = await bootstrapIdentityStamps(db, RID); assert.ok(b.stamped, `certified baseline ${JSON.stringify(b)}`);
}

(async () => {
  // the portal's shared rules + writer, as the page loads them (classic scripts defining globals)
  const PORTAL = path.join(__dirname, '../../xpizza-portal');
  for (const f of ['extras-eligibility.js', 'exposure-transitions.js']) vm.runInThisContext(fs.readFileSync(path.join(PORTAL, f), 'utf8'));
  const E = await import(pathToFileURL(path.join(PORTAL, 'editor.js')).href);
  const API = await import(pathToFileURL(path.join(PORTAL, 'api.js')).href);
  const XL = await import(pathToFileURL(path.join(PORTAL, 'extras-logic.js')).href);
  const token = async () => 'tok';
  await seed();
  // the portal's baseFor (app.js): the SERVED baseline rides the save whenever the draft carries a claim — mergeDeletionClaim names it
  const baseFor = (src, served) => (E.mergeDeletionClaim(src, null) && served ? { version: served.version, generation: served.generation } : null);

  // C1 — remove A, save with the served base
  let ed = await editable();
  assert.ok(ed.deletionBase && Number.isInteger(ed.deletionBase.generation), `premise: the served base ${JSON.stringify(ed.deletionBase)}`);
  const d = E.createDraft(ed.source);
  const [A, B] = E.draftSource(d).extras.filter((x) => x.display.cat === 'Acompañamientos' && typeof x.key === 'string');
  assert.ok(A && B, 'premise: two published extras in one group');
  assert.strictEqual(E.applyExposureOps(d, [{ op: 'extra.remove', key: A.key }], { extrasCatalog: true }).ok, true);
  const base1 = baseFor(E.draftSource(d), ed.deletionBase);
  assert.ok(base1, 'the draft carries a claim: the base rides');
  let r = await API.editCatalog({ rid: RID, source: E.draftSource(d), baseSourceUpdateTime: ed.sourceUpdateTime, token, loadedBase: base1 });
  assert.deepStrictEqual(SENT[SENT.length - 1].deleted_ids_loaded_base, base1, 'the portal sent the served base');
  ed = await editable();
  assert.ok(ed.deletionClaim.ids.length === 1, `A is claimed (${JSON.stringify(ed.deletionClaim)})`);
  E.adopt(d, r.source);
  ok('C1 remove A → save with the served base → 200; A claimed; the portal adopts the saved source');

  // C2 — remove B on the adopted draft, save again with the (unchanged) served base
  assert.strictEqual(E.applyExposureOps(d, [{ op: 'extra.remove', key: B.key }], { extrasCatalog: true }).ok, true);
  const base2 = baseFor(E.draftSource(d), ed.deletionBase);
  r = await API.editCatalog({ rid: RID, source: E.draftSource(d), baseSourceUpdateTime: ed.sourceUpdateTime, token, loadedBase: base2 });
  assert.deepStrictEqual(SENT[SENT.length - 1].deleted_ids_loaded_base, base2, 'the base rides the second save too');
  ed = await editable();
  assert.strictEqual(ed.deletionClaim.ids.length, 2, `BOTH claimed (${JSON.stringify(ed.deletionClaim)})`);
  const saved2 = r;
  E.adopt(d, r.source);
  ok('C2 remove B on the adopted draft → save → 200; BOTH claimed');

  // C5 — REVIEW-DELETIONS names the served claim from CERTIFIED rows (display.identity_id): the portal's deletionRows over the real ids
  const rows = XL.deletionRows(d, ed.deletionClaim.ids);
  assert.deepStrictEqual(rows.map((x) => [x.name, x.group, x.gone]).sort(), [[A.display.name, 'Acompañamientos', false], [B.display.name, 'Acompañamientos', false]].sort(),
    `the full list by name (${JSON.stringify(rows)})`);
  ok('C5 REVIEW-DELETIONS: the served claim\u2019s identity ids are named from the certified rows (extra · group)');

  // C3 — a removal WITHOUT the base is refused, nothing written
  const before = JSON.stringify(await storedDraft());
  const d3 = E.createDraft((await editable()).source);
  const [C] = E.draftSource(d3).extras.filter((x) => x.display.cat === 'Salsas' && typeof x.key === 'string');
  assert.strictEqual(E.applyExposureOps(d3, [{ op: 'extra.remove', key: C.key }], { extrasCatalog: true }).ok, true);
  await assert.rejects(API.editCatalog({ rid: RID, source: E.draftSource(d3), baseSourceUpdateTime: (await editable()).sourceUpdateTime, token, loadedBase: null }),
    (e) => e && e.status === 409 && e.body && /deleted_ids_unbound|existing_extra_removed/.test(e.body.error), 'refused without the base');
  assert.strictEqual(JSON.stringify(await storedDraft()), before, 'nothing written');
  ok('C3 a claim WITHOUT the served base → refused; nothing written');

  // C4 — the published menu moves (the claimed removals PUBLISH through the real reviewed path, consuming the claim); a later save that
  // still carries the OLD base is refused deleted_ids_base_moved
  const oldBase = { ...ed.deletionBase };
  const readDraft = async () => { const s = await sourceRefOf(db, RID).get(); return { source: s.data(), updateTime: encodeUpdateTime(s.updateTime) }; };
  const pub = await publishEditedCore({ db, authorize: owner, readActiveBuilt: readActiveBuilt(RID), readDraft, publishVersion, mirror: makeRtdbMirror(rtdb), sourceSha: 's2claim', addProduct: io },
    { restaurantId: RID, token: saved2.token, acknowledgedChanges: saved2.diff.largeChangeSet, fiscalAck: true }, {});
  assert.strictEqual(pub.status, 200, `premise: the claimed removals publish (${JSON.stringify(pub.body).slice(0, 200)})`);
  assert.deepStrictEqual((await editable()).deletionClaim.ids, [], 'the publish consumed the claim');
  // the stale tab: its draft still carries a removal of a still-published extra, with the OLD base
  const dOld = E.createDraft((await editable()).source);
  const [D] = E.draftSource(dOld).extras.filter((x) => x.display.cat === 'Salsas' && typeof x.key === 'string');
  assert.strictEqual(E.applyExposureOps(dOld, [{ op: 'extra.remove', key: D.key }], { extrasCatalog: true }).ok, true);
  const moved = await getActivePointer(db, RID);
  assert.ok(moved.version !== oldBase.version || moved.generation !== oldBase.generation, 'premise: the pointer moved');
  const before4 = JSON.stringify(await storedDraft());
  await assert.rejects(API.editCatalog({ rid: RID, source: E.draftSource(dOld), baseSourceUpdateTime: (await editable()).sourceUpdateTime, token, loadedBase: oldBase }),
    (e) => e && e.status === 409 && e.body && e.body.error === 'deleted_ids_base_moved', 'refused deleted_ids_base_moved');
  assert.strictEqual(JSON.stringify(await storedDraft()), before4, 'nothing written');
  ok('C4 the published menu moved → a save with the OLD base is refused deleted_ids_base_moved; nothing written');

  FINISHED = true;
  console.log(`s2-portal-claim(emulator): ${n} cells ✓`);
  process.exit(0);
})().catch((e) => { console.error('s2-portal-claim(emulator) FAILED:', e); process.exit(1); });
