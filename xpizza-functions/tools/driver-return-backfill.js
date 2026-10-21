#!/usr/bin/env node
'use strict';
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §B) — the OWNER's return-base backfill CLI. DRY RUN unless --apply.
//
//   node tools/driver-return-backfill.js --project <id>                         ← plan + the UNRESOLVED list (read-only)
//   node tools/driver-return-backfill.js --project <id> --apply                 ← set-if-absent per driver, then the read-back
//   node tools/driver-return-backfill.js --project <id> set-return <uid> <rid> [--apply]   ← resolve one driver by hand
//   node tools/driver-return-backfill.js --project <id> read-back               ← exit 1 while any driver is unresolved
//
// Gives every drivers/{uid} a return_restaurant_id (the restaurant a returning driver geofences at) from the live
// current_restaurant_id, else the latest delivered order (both attributions, full indexed history) whose identity exists —
// never an x_pizza default. Run it AFTER functions stage A is fully deployed (it only fills gaps). Stage B (the X1 readers)
// ships only after `read-back` exits 0. --project must be the explicit flag (an inherited GOOGLE_CLOUD_PROJECT is refused).
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { planBackfill, applyBackfill, readBack, setReturn } = require('./driver-return-backfill-core');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project') && a !== PROJECT_ID);
const APPLY = args.includes('--apply');
const pos = args.filter((a) => !a.startsWith('--'));
const usage = () => { console.error('usage: driver-return-backfill.js --project <id> [read-back | set-return <uid> <rid>] [--apply]'); process.exit(2); };
if (pos.length && !['read-back', 'set-return'].includes(pos[0])) usage();
if (pos[0] === 'set-return' && (!pos[1] || !pos[2])) usage();

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const rtdb = admin.database();

const report = (problems) => {
  if (!problems.length) { console.log('driver-return-backfill: READ-BACK OK — every driver has a return_restaurant_id naming an existing identity'); return 0; }
  console.error(`driver-return-backfill: READ-BACK FAILED (${problems.length}) — stage B stays BLOCKED`);
  for (const p of problems) console.error(`  ${p}`);
  return 1;
};

(async () => {
  if (pos[0] === 'read-back') process.exit(report(await readBack(rtdb)));
  if (pos[0] === 'set-return') {
    const [, uid, rid] = pos;
    console.log(`driver-return-backfill ${APPLY ? 'APPLY' : 'DRY RUN'} set-return — project ${PROJECT_ID}: drivers/${uid}/return_restaurant_id ← ${JSON.stringify(rid)}`);
    const r = await setReturn(rtdb, uid, rid, { dryRun: !APPLY });
    if (!r.ok) { console.error(`driver-return-backfill: REFUSED — ${r.error}`); process.exit(1); }
    console.log(r.noop ? 'already set to this value — no-op' : r.dryRun ? '(dry run — nothing written; add --apply)' : `applied and read back (${JSON.stringify(r.back)})`);
    process.exit(0);
  }
  const plan = await planBackfill(rtdb);
  console.log(`driver-return-backfill ${APPLY ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}: ${plan.rows.length} to fill, ${plan.present.length} already set, ${plan.unresolved.length} UNRESOLVED`);
  for (const r of plan.rows) console.log(`  ${r.uid} (${r.name || 'no name'}) ← ${r.rid}  [${r.source}]`);
  for (const u of plan.unresolved) console.log(`  UNRESOLVED ${u.uid} (${u.name || 'no name'}) — ${u.reason}`);
  if (!APPLY) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const res = await applyBackfill(rtdb, plan.rows);
  console.log(`driver-return-backfill: written ${res.written.length}, kept (set meanwhile) ${res.kept.length}`);
  process.exit(report(await readBack(rtdb)));
})().catch((e) => { console.error('driver-return-backfill FAILED:', e && e.message); process.exit(1); });
