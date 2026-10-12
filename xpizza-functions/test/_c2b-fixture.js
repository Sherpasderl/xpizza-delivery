'use strict';
/* 1D D4-c2b — shared emulator fixture: the REAL writers (publishVersion / rollbackVersion / bootstrapIdentityStamps, which write
   c2a's evidence themselves) and a monitor bound to the emulators. Test-only. */
const admin = require('firebase-admin');
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { sourceToBuildInputs, encodeUpdateTime, sourceRefOf } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { bootstrapIdentityStamps } = require('../catalog/identity-bootstrap');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { createIdentityIntegrityMonitor, INTEGRITY_PATH } = require('../catalog/identity-integrity-monitor');

// a merchant with NO extras (a synthetic rid has no code-side extras price table — pre-existing finding #3), optionally n dishes
function zeroExtras(src) {
  const t = JSON.parse(JSON.stringify(src)); t.extras = [];
  t.structure = { ...t.structure, extra_categories: [], extras_by_category: Object.fromEntries(Object.keys(t.structure.extras_by_category || {}).map((k) => [k, []])),
    exposure: { ...(t.structure.exposure || {}), category_allow: Object.fromEntries(Object.keys((t.structure.exposure || {}).category_allow || {}).map((k) => [k, []])), item_overrides: {} } };
  for (const it of t.items) { if (it.display) delete it.display.identity_id; }
  return t;
}
function synthSource(rid, dishes = null) {
  const t = zeroExtras(buildSourceFromCode('x_pizza'));
  if (dishes) {
    const proto = t.items[0]; const cats = (t.structure.categories || []).map((c) => c.id);
    t.items = Array.from({ length: dishes }, (_, i) => { const key = `Synth Dish ${String(i).padStart(4, '0')}`; return { ...JSON.parse(JSON.stringify(proto)), key, price: 100 + (i % 50), display: { ...(proto.display || {}), id: 10000 + i, name: key, price: 100 + (i % 50), cat: cats[i % cats.length] } }; });
    t.structure.item_order = t.items.map((x) => x.key);
  }
  return { ...t, restaurant_id: rid };
}
function fixture({ db, rtdb, now, sleep } = {}) {
  const versionsColOf = (rid) => db.collection('restaurants').doc(rid).collection('versions');
  async function candidateFromSource(rid) {
    const src = (await sourceRefOf(db, rid).get()).data();
    const inputs = sourceToBuildInputs(src);
    const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
    return { items: built.items, structure: built.structure, extras: inputs.extras,
      extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
  }
  // onboarding creates the restaurant's own document (restaurants/{rid}) — the monitor's bounded reader enumerates DOCUMENTS (rail (ii))
  async function seed(rid, source = buildSourceFromCode(rid)) { await db.collection('restaurants').doc(rid).set({ name: rid }, { merge: true }); await sourceRefOf(db, rid).set(source); }
  async function publish(rid, tag = 'c2b') {
    const p = await getActivePointer(db, rid).catch(() => ({ version: null }));
    const snap = await sourceRefOf(db, rid).get();
    const r = await publishVersion(db, rid, { ...(await candidateFromSource(rid)), source_sha: tag },
      { expected: { activeVersionId: p.version || null, draftRevision: encodeUpdateTime(snap.updateTime) } });
    return r.versionId || r.version_id || r;
  }
  async function rollback(rid, target) {
    const p = await getActivePointer(db, rid);
    await rollbackVersion(db, rid, target, { expected: { activeVersionId: p.version } });
  }
  async function bootstrap(rid) { return bootstrapIdentityStamps(db, rid); }
  async function addDish(rid, name) {
    const src = (await sourceRefOf(db, rid).get()).data();
    const first = (src.items || [])[0];
    const used = new Set((src.items || []).map((o) => String(o && o.display && o.display.id)));
    let uiId = 9000; while (used.has(String(uiId))) uiId += 1;
    const row = { ...first, key: name, name, display: { ...(first.display || {}), id: uiId, name } };
    delete row.display.identity_id;
    await sourceRefOf(db, rid).update({ items: (src.items || []).concat([row]),
      structure: { ...src.structure, item_order: (src.structure.item_order || []).concat([name]) } });
  }
  const monitor = (opts = {}) => createIdentityIntegrityMonitor({ db, rtdb, now, sleep, log: opts.log || (() => {}), runId: opts.runId });
  async function runFor(rids, opts = {}) {
    const lines = [];
    const m = createIdentityIntegrityMonitor({ db, rtdb, now, sleep, log: (k, d) => lines.push({ k, d }), runId: opts.runId });
    const out = await m.run({ listIds: async () => rids, quietMs: 0, ...opts });   // the quiet period is exercised by its own cells
    return { ...out, logged: lines };
  }
  const evidenceCol = (rid) => db.collection('restaurants').doc(rid).collection('identity_evidence');
  const evidenceIds = async (rid) => (await evidenceCol(rid).get()).docs.map((d) => d.id).sort();
  const pointerRef = (rid) => db.collection('restaurants').doc(rid).collection('meta').doc('active_version');
  async function merchant(rid, { dishes = null, certify = true } = {}) {
    await seed(rid, synthSource(rid, dishes));
    const v1 = await publish(rid, `${rid}-v1`);
    if (certify) {
      // the D1 backfill registers every object first (bootstrap mints nothing), as the cutover runbook does
      const { backfillIdentities } = require('../catalog/identity-backfill');
      const { getRestaurantMenu } = require('../catalog/catalog-menu');
      await backfillIdentities(db, rid, await getRestaurantMenu(db, rid), { captured: await getActivePointer(db, rid) });
      await bootstrap(rid);
    }
    return v1;
  }
  /* the MERCHANT'S REAL PATH: save through editCatalogCore (issues the edit token, owns the deletion claim) → publishEditedCore */
  const { editCatalogCore } = require('../catalog/edit-catalog-handler');
  const { publishEditedCore } = require('../catalog/publish-edited-handler');
  const { getRestaurantMenu } = require('../catalog/catalog-menu');
  const owner = async () => ({ ok: true, uid: 'u_o', role: 'owner', actor: 'o@x.hn' });
  const toPrecondition = (v) => { if (typeof v !== 'string') return v; const [sec, nanos] = v.split('.'); return new admin.firestore.Timestamp(Number(sec), Number(nanos)); };
  const PORTAL_READ_DRAFT = (rid) => async () => { const snap = await sourceRefOf(db, rid).get(); return { source: snap.data(), updateTime: encodeUpdateTime(snap.updateTime) }; };
  // the LIVE version exactly as production reads it for an edit (portal/functions.js readActiveBuiltForEdit), incl. the extras'
  // records that 1D add-product A's structural comparison needs
  const PORTAL_READ_ACTIVE = (rid) => async () => {
    const { previewVersion } = require('../catalog/catalog-publish');
    const { readVersionDocs, getActiveVersionId } = require('../catalog/catalog-firestore');
    const { buildTablesFromDocs } = require('../catalog/catalog-transform');
    const versionId = await getActiveVersionId(db, rid);
    const [preview, docs] = await Promise.all([previewVersion(db, rid, versionId), readVersionDocs(db, rid, versionId)]);
    const { extras } = buildTablesFromDocs(docs.itemDocs, docs.extraDocs);
    return { built: { items: preview.items, structure: preview.structure, extras }, versionId, extraRecords: preview.extras };
  };
  /* the save alone (no throw): main's add-only rules refuse some draft shapes AT SAVE, and a cell asserts which */
  async function portalSave(rid, mutate) {
    const readActiveBuilt = PORTAL_READ_ACTIVE(rid);
    const snap = await sourceRefOf(db, rid).get();
    const base = await getActivePointer(db, rid);   // the baseline the merchant LOADED (a deletion claim is bound to it)
    const next = mutate(JSON.parse(JSON.stringify(snap.data())), { version: base.version, generation: base.generation });
    // the deletion claim's baseline is a REQUEST field (edit-catalog-handler.js:216), not part of the draft
    const loadedBase = next.deleted_ids_loaded_base; delete next.deleted_ids_loaded_base;
    // 1D add-product A: the deployed editCatalog / publishEdited receive the add-product io (portal/functions.js addProductIoForEdit)
    const addProduct = require('../catalog/add-product-io').addProductIo({ fs: db, rtdb });
    const saved = await editCatalogCore({ db, authorize: owner, readActiveBuilt, toPrecondition, addProduct }, { restaurantId: rid, source: next, baseSourceUpdateTime: encodeUpdateTime(snap.updateTime),
      ...(loadedBase ? { deleted_ids_loaded_base: loadedBase } : {}) }, {});
    return saved;
  }
  async function portalSaveAndPublish(rid, mutate, tag = 'portal') {
    const readActiveBuilt = PORTAL_READ_ACTIVE(rid); const readDraft = PORTAL_READ_DRAFT(rid);
    const addProduct = require('../catalog/add-product-io').addProductIo({ fs: db, rtdb });
    const saved = await portalSave(rid, mutate);
    if (saved.status !== 200) throw new Error(`portal save refused ${saved.status}: ${JSON.stringify(saved.body).slice(0, 300)}`);
    // the merchant confirms EXACTLY the large-change set the save reported (as the portal's confirmation dialog does)
    const ack = ((saved.body.diff && saved.body.diff.largeChangeSet) || []).map((l) => ({ key: l.key, surface: l.surface }));
    const pub = await publishEditedCore({ db, authorize: owner, readActiveBuilt, readDraft, publishVersion, sourceSha: tag, addProduct },
      { restaurantId: rid, token: saved.body.token, fiscalAck: true, ...(ack.length ? { acknowledgedChanges: ack } : {}) }, {});
    if (pub.status !== 200) throw new Error(`portal publish refused ${pub.status}: ${JSON.stringify(pub.body).slice(0, 300)}`);
    return (await getActivePointer(db, rid)).version;
  }
  const nodeOf = async (rid) => (await rtdb.ref(`${INTEGRITY_PATH}/${rid}`).get()).val();
  const setNode = (rid, v) => rtdb.ref(`${INTEGRITY_PATH}/${rid}`).set(v);
  const openFindings = (node) => Object.entries((node && node.findings) || {}).filter(([, f]) => f.status === 'open');
  return { candidateFromSource, seed, publish, rollback, bootstrap, addDish, monitor, runFor, nodeOf, setNode, openFindings, versionsColOf, evidenceCol, evidenceIds, pointerRef, merchant, portalSave, portalSaveAndPublish };
}
module.exports = { fixture, buildSourceFromCode, synthSource, zeroExtras };
