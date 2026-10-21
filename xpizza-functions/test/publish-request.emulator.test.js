'use strict';
// PLAN-portal-team-invites r2.1 §2 G3 (codex build r1 P2) — «Enviar al dueño para publicar» through the REAL catalog writers on
// the emulator (no hand-set pointers or drafts): the manager's real save (editCatalogCore) → requestPublishCore → the owner's
// getEditableCatalog; then the real publish (publishEditedCore), rollback (rollbackVersion) and reset (resetDraftToLiveCore)
// retire it; and a REAL concurrent draft save / publish between requestPublish's verify and its transaction → raced, nothing
// written. Membership is the real resolver over RTDB. Run: npm run test:publish-request
require('./_emulator-required')('firestore', 'database');
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'publish-request-secret-'.padEnd(48, 'x');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.firestore();
const rtdb = admin.database();
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { getEditableCatalogCore } = require('../catalog/portal-reads');
const { resetDraftToLiveCore } = require('../catalog/reset-draft');
const { publishVersion, previewVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
const PR = require('../catalog/publish-request');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('publish-request(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'x_pizza';   // a platform-factura location (data: factura/eligibility) — the only kind the flow applies to
const toPrecondition = (v) => {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  return /^\d+$/.test(sec || '') && /^\d+$/.test(nanos || '') ? new admin.firestore.Timestamp(Number(sec), Number(nanos)) : v;
};
const req = { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer t' : undefined) };
const authAs = (uid) => (rid) => authorizeCatalogEdit({ db: rtdb, verifyIdToken: async () => ({ uid }) }, req, rid);
const io = addProductIo({ fs: db, rtdb });
const readActiveBuilt = (rid) => PR.readActiveBuiltFrom(db, rid);
const readDraft = (rid) => PR.readDraftFrom(db, rid);
const rev = async () => encodeUpdateTime((await sourceRefOf(db, RID).get()).updateTime);
const draft = async () => (await sourceRefOf(db, RID).get()).data();
const priced = (src, delta = 1, i = 0) => { const s = JSON.parse(JSON.stringify(src)); s.items[i].price += delta; s.items[i].display.price = s.items[i].price; return s; };
const save = async (uid, source) => editCatalogCore({ db, authorize: authAs(uid), readActiveBuilt, toPrecondition, addProduct: io },
  { restaurantId: RID, source, baseSourceUpdateTime: await rev() }, req);
const publish = (uid, saved) => publishEditedCore({ db, authorize: authAs(uid), readActiveBuilt, readDraft, publishVersion, mirror: makeRtdbMirror(rtdb), sourceSha: 'pr', addProduct: io },
  { restaurantId: RID, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, req);
const request = (deps, token) => PR.requestPublishCore({ fs: db, db: rtdb, readActiveBuilt, readDraft, ...deps }, { uid: 'mgrOn01', token: { email: 'm@x.hn', email_verified: true } }, { restaurantId: RID, token });
const ownerView = async () => (await getEditableCatalogCore({ db: rtdb, fsdb: db, authorize: authAs('ownerA'), readActiveVersionId: (f, r) => getActiveVersionId(f, r), readActiveBuilt },
  { method: 'GET', query: { restaurantId: RID } })).body.publish_request;
const slot = async () => { const s = await PR.requestRefOf(db, RID).get(); return s.exists ? s.data() : null; };

(async () => {
  await db.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, RID).set(canonicalize(buildSourceFromCode(RID)));
  const { input } = require('../tools/publish-version').buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'seed' });
  await publishVersion(db, RID, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, RID, catalogSnapshot(RID), { captured: await getActivePointer(db, RID) });
  await rtdb.ref().update({
    [`brands/${RID}`]: { name: RID, active: true, locations: { [RID]: 'member' }, activation: { state: 'legacy', since: 1 } },
    [`brand_members/${RID}`]: { owners: { ownerA: { granted_at: 1 } }, managers: { [RID]: { mgrOn01: { granted_at: 1 } } },
      manager_perms: { mgrOn01: { can_edit_menu: true } }, profiles: { mgrOn01: { name: 'Dania Reyes', email: 'm@x.hn' } } },
    'platform_config/membership_writes_enabled': true,
  });
  const A = await getActivePointer(db, RID);

  // 1. the manager saves a real edit and sends it → the owner sees it fresh, named from the SERVER profile
  const s1 = await save('mgrOn01', priced(await draft(), 1));
  assert.strictEqual(s1.status, 200, `manager save: ${JSON.stringify(s1.body).slice(0, 200)}`);
  assert.strictEqual((await request({}, s1.body.token)).status, 200);
  const v1 = await ownerView();
  assert.ok(v1 && v1.state === 'fresh' && v1.by_name === 'Dania Reyes', JSON.stringify(v1));
  assert.strictEqual((await slot()).base_generation, A.generation, 'the generation bound in the transaction');
  ok('a real manager save → requestPublish → the owner sees it fresh, named from the server profile');

  // 2. the owner publishes it (the real publish) → retired; a real ROLLBACK to A (same version id A, newer generation) never revives it
  const pub = await publish('ownerA', s1);
  assert.strictEqual(pub.status, 200, `owner publish: ${JSON.stringify(pub.body).slice(0, 200)}`);
  assert.strictEqual(await ownerView(), undefined, 'published → hidden');
  const B = await getActivePointer(db, RID);
  await rollbackVersion(db, RID, A.version, { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: B.version, activeGeneration: B.generation } });
  const back = await getActivePointer(db, RID);
  assert.ok(back.version === A.version && back.generation > B.generation, `premise: rolled back to A at a newer generation (${JSON.stringify(back)})`);
  assert.strictEqual(await ownerView(), undefined, '🔴 rollback to A: the old request is NOT fresh again (ABA)');
  ok('real publish → hidden; real rollback to the same version id A → still hidden (generation)');

  // 3. a new request, then a real publish, then a real RESET (the draft already equals live → a no-op reset) → still hidden
  const s2 = await save('mgrOn01', priced(await draft(), 2, 1));
  assert.strictEqual(s2.status, 200);
  assert.strictEqual((await request({}, s2.body.token)).status, 200);
  assert.strictEqual((await ownerView()).state, 'fresh');
  assert.strictEqual((await publish('ownerA', s2)).status, 200);
  const r = await resetDraftToLiveCore({ db, authorize: authAs('ownerA'), readActiveVersionId: (f, x) => getActiveVersionId(f, x), previewVersion, toPrecondition },
    { restaurantId: RID, expectedRevision: await rev() }, req);
  assert.strictEqual(r.status, 200, `reset: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.strictEqual(await ownerView(), undefined, 'publish → reset never revives the request');
  // and with the draft equal to live, a new request is refused outright
  const same = await save('mgrOn01', await draft());
  assert.strictEqual((await request({}, same.body.token)).status, 409, 'draft == active → nothing_to_publish');
  ok('real publish → real (no-op) reset: still hidden; draft == active → nothing_to_publish');

  // 4. CONCURRENCY: a real draft save, or a real publish, lands between requestPublish's verify and its transaction → raced
  const s3 = await save('mgrOn01', priced(await draft(), 3));
  const before = await slot();
  const racedDraft = await request({ readDraft: async (rid) => { const out = await readDraft(rid); const x = await save('ownerA', priced(await draft(), 1, 2)); assert.strictEqual(x.status, 200); return out; } }, s3.body.token);
  assert.deepStrictEqual(racedDraft, { status: 409, body: { error: 'edit_superseded', reason: 'raced' } }, 'a concurrent real draft save');
  const s4 = await save('mgrOn01', priced(await draft(), 4));
  const racedFlip = await request({ readDraft: async (rid) => { const out = await readDraft(rid); const p = await publish('ownerA', s4); assert.strictEqual(p.status, 200); return out; } }, s4.body.token);
  assert.deepStrictEqual(racedFlip, { status: 409, body: { error: 'edit_superseded', reason: 'raced' } }, 'a concurrent real publish');
  assert.deepStrictEqual(await slot(), before, 'neither race wrote the slot');
  ok('a concurrent real draft save or real publish during requestPublish → 409 raced, the slot untouched');

  FINISHED = true;
  console.log(`publish-request(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('publish-request(emulator): FAILED\n', e); process.exit(1); });
