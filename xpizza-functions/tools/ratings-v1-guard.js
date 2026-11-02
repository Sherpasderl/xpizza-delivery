#!/usr/bin/env node
'use strict';
// S-A1 deploy-order guard (advisor 2026-11-01, "cheap insurance"): the v2-only rating reader is enabled ONLY when no legacy v1
// `order_ratings` record exists. Prod held ZERO at the owner's read (2026-11-01), so S-A1 ships with no migration; this READ-ONLY
// check proves it stayed that way before S-A1 / S-B deploy (RUNBOOK). It reads the order_ratings node (expected EMPTY — the Admin
// SDK has no shallow read; a non-empty node is exactly the refusal case), prints ONLY the count, and writes nothing.
//   node tools/ratings-v1-guard.js --project xpizza-delivery     → exit 0 when there are 0 v1 records; exit 1 (REFUSE) otherwise
async function countV1(rtdb) {
  const v = (await rtdb.ref('order_ratings').once('value')).val();
  return v && typeof v === 'object' ? Object.keys(v).length : 0;
}

async function guard({ rtdb }) {
  const n = await countV1(rtdb);
  return { ok: n === 0, count: n };
}

module.exports = { countV1, guard };

if (require.main === module) {
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
  (async () => {
    const r = await guard({ rtdb: admin.database() });
    console.log(r.ok ? 'ratings-v1-guard: OK — 0 legacy order_ratings records; v2-only reads may be enabled'
      : `ratings-v1-guard: REFUSE — ${r.count} legacy order_ratings record(s) exist; do NOT enable v2-only reads (migrate first)`);
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => { console.error('ratings-v1-guard: FAILED —', e && e.code ? e.code : 'error'); process.exit(2); });
}
