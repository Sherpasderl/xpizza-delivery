#!/usr/bin/env node
'use strict';
// 1D add-product PHASE A — the READ-ONLY draft-drift report (advisor ruling 2026-10-09). Run against production BEFORE
// the add-product deploy: from then on every save is structurally compared with the active catalog, so a saved draft
// that ALREADY drifts would make the merchant's next price edit fail. This says, per brand, whether the saved source is
// publishable against what is serving — with the SAME checks a save runs (catalog/draft-assess.js) — so nothing starts
// failing unannounced.
//   node tools/draft-drift-report.js --project xpizza-delivery [--rid <rid>]
// 🔴 WRITES NOTHING. Firestore is wrapped so that every write method THROWS.
const { assessDraft } = require('../catalog/draft-assess');
const { sourceRefOf } = require('../catalog/source-store');

const WRITE_METHODS = new Set(['set', 'update', 'delete', 'create', 'add', 'batch', 'runTransaction', 'bulkWriter', 'recursiveDelete']);
// A deep read-only proxy: any write method anywhere in the chain throws; everything returned is wrapped again.
function readOnly(target, label = 'firestore') {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;
  return new Proxy(target, {
    get(t, prop) {
      if (WRITE_METHODS.has(prop)) return () => { throw new Error(`draft-drift-report: refused ${label}.${String(prop)} — this tool is read-only`); };
      const v = Reflect.get(t, prop, t);
      if (typeof v !== 'function') return v;
      return (...args) => {
        const out = v.apply(t, args);
        if (out && typeof out.then === 'function') return out;   // results (snapshots) are data, not handles
        return readOnly(out, `${label}.${String(prop)}`);
      };
    },
  });
}

/* rids                — the restaurants to check
   readSource(rid)     → the saved source, or null when there is none
   readActive(rid)     → { built: {items, structure}, extraRecords } of the active version, or null when nothing is live
   Returns one row per rid: { rid, status: 'publishable'|'drift'|'no_source'|'no_active'|'unreadable', … } */
async function driftReport({ rids, readSource, readActive }) {
  const rows = [];
  for (const rid of rids) {
    try {
      const source = await readSource(rid);
      if (!source) { rows.push({ rid, status: 'no_source' }); continue; }
      const active = await readActive(rid);
      if (!active) { rows.push({ rid, status: 'no_active' }); continue; }
      const a = assessDraft(rid, source, active);
      rows.push(a.publishable
        ? { rid, status: 'publishable', additions: a.additions, removals: a.removals }
        : { rid, status: 'drift', code: a.code, detail: a.detail, ...(a.key ? { key: a.key } : {}) });
    } catch (e) {
      rows.push({ rid, status: 'unreadable', detail: String((e && e.message) || e).slice(0, 200) });
    }
  }
  return rows;
}

function firestoreReaders(db) {
  const { previewVersion } = require('../catalog/catalog-publish');
  const { getActiveVersionId } = require('../catalog/catalog-firestore');
  return {
    readSource: async (rid) => { const s = await sourceRefOf(db, rid).get(); return s.exists ? s.data() : null; },
    readActive: async (rid) => {
      const vid = await getActiveVersionId(db, rid);
      if (vid == null) return null;
      const p = await previewVersion(db, rid, vid);
      return { built: { items: p.items, structure: p.structure }, extraRecords: p.extras, versionId: vid };
    },
  };
}

module.exports = { driftReport, readOnly, firestoreReaders };

if (require.main === module) {
  const admin = require('firebase-admin');
  const { requireProject } = require('./require-project');
  const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const i = process.argv.indexOf('--rid');
  const only = i > -1 ? process.argv[i + 1] : null;
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
  const db = readOnly(admin.firestore());
  (async () => {
    const rids = only ? [only] : await makeFirestoreRegistryReader(db)();
    const rows = await driftReport({ rids, ...firestoreReaders(db) });
    console.log(JSON.stringify({ project: PROJECT_ID, at: new Date().toISOString(), rows }, null, 2));
    const drift = rows.filter((r) => r.status === 'drift' || r.status === 'unreadable');
    console.log(drift.length ? `DRIFT: ${drift.map((r) => `${r.rid} (${r.code || r.status})`).join(', ')} — decide before enabling add-product` : 'no drift: every saved draft is publishable against its active catalog');
    process.exit(0);
  })().catch((e) => { console.error('draft-drift-report FAILED:', e && e.message); process.exit(1); });
}
