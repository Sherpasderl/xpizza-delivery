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

function fixture({ db, rtdb, now, sleep } = {}) {
  const versionsColOf = (rid) => db.collection('restaurants').doc(rid).collection('versions');
  async function candidateFromSource(rid) {
    const src = (await sourceRefOf(db, rid).get()).data();
    const inputs = sourceToBuildInputs(src);
    const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
    return { items: built.items, structure: built.structure, extras: inputs.extras,
      extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
  }
  async function seed(rid, source = buildSourceFromCode(rid)) { await sourceRefOf(db, rid).set(source); }
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
  const nodeOf = async (rid) => (await rtdb.ref(`${INTEGRITY_PATH}/${rid}`).get()).val();
  const setNode = (rid, v) => rtdb.ref(`${INTEGRITY_PATH}/${rid}`).set(v);
  const openFindings = (node) => Object.entries((node && node.findings) || {}).filter(([, f]) => f.status === 'open');
  return { candidateFromSource, seed, publish, rollback, bootstrap, addDish, monitor, runFor, nodeOf, setNode, openFindings, versionsColOf };
}
function initEmulatorApp() {
  if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza-default-rtdb` });
  return { db: admin.firestore(), rtdb: admin.database() };
}
module.exports = { fixture, initEmulatorApp, buildSourceFromCode };
