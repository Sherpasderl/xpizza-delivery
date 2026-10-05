#!/usr/bin/env node
'use strict';
// Portal 1D · D4-b §E.4 — the READ-ONLY live-vs-proxy divergence report, for the owner. Compares each restaurant's LIVE
// version dishes [{key,label,category}] (served order) with the published /menus/{rid} (the code-proxy KDS manifest).
// 🔴 WRITES NOTHING. Both datastore handles are wrapped so that any write method THROWS — the report cannot become a
// writer by accident, and a regression that tried would fail loudly instead of touching production.
//   node tools/menus-divergence-report.js --project xpizza-delivery
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const { divergenceReport } = require('../catalog/identity-manifest');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const { RTDB_URL } = require('../catalog/mirror-rtdb');

function readOnlyRtdb(rtdb) {
  const deny = (op) => () => { throw new Error(`menus-divergence-report: refused RTDB ${op} — this tool is read-only`); };
  const wrap = (ref) => ({ get: (...a) => ref.get(...a), once: (...a) => ref.once(...a), child: (c) => wrap(ref.child(c)),
    set: deny('set'), update: deny('update'), remove: deny('remove'), push: deny('push'), transaction: deny('transaction') });
  return { ref: (p) => wrap(rtdb.ref(p)) };
}
module.exports = { readOnlyRtdb };

if (require.main === module) {
  const PROJECT_ID = requireProject();
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const db = admin.firestore();
  divergenceReport({ db, rtdb: readOnlyRtdb(admin.database()), listIds: makeFirestoreRegistryReader(db) })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error('menus-divergence-report FAILED:', e && e.message); process.exit(1); });
}
