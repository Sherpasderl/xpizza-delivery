#!/usr/bin/env node
'use strict';
// offer-audience (PLAN-5f-offer-audience r4.1 §5, r2 §9 go-live step 3) — the OWNER's marker backfill CLI. DRY RUN unless --apply.
//
//   AUDIENCE_KEY_V1="$(firebase functions:secrets:access AUDIENCE_KEY_V1 --project <id>)" node tools/audience-backfill.js --project <id>
//   … same … --apply
//
// The key is read from the environment and never printed (rule 24: the command's output holds no secret). Marks every delivered /
// completed order's brand at the order's OWN fulfilment month (tools/audience-backfill-core.js); set-only + monotonic, so a re-run is a
// no-op and it commutes with the live writer. Output: counts per brand only. --project must be the explicit flag.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { runBackfill } = require('./audience-backfill-core');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project') && a !== PROJECT_ID);
const APPLY = args.includes('--apply');
if (args.some((a) => a !== '--apply')) { console.error('usage: audience-backfill.js --project <id> [--apply]   (AUDIENCE_KEY_V1 in the environment)'); process.exit(1); }
const KEY = process.env.AUDIENCE_KEY_V1 || '';
if (KEY.length < 32) { console.error('audience-backfill: AUDIENCE_KEY_V1 missing or too short — set it from the secret (never printed)'); process.exit(1); }

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });

(async () => {
  console.log(`audience-backfill ${APPLY ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}`);
  const r = await runBackfill(admin.database(), { key: KEY, nowMs: Date.now(), apply: APPLY, log: { log() {}, warn() {}, error() {} } });
  console.log(`orders scanned ${r.scanned}, fulfilled ${r.fulfilled}, ${APPLY ? 'marked' : 'would mark'} ${r.marked}`);
  console.log(`skipped: before the 24-month window ${r.skipped.pre_cutoff}, no verified identity ${r.skipped.no_identity}, brand unresolved ${r.skipped.brand_unresolved}`);
  for (const [b, k] of Object.entries(r.byBrand).sort()) console.log(`  brand ${b}: ${k}`);
  if (!APPLY) console.log('(dry run — nothing written; add --apply)');
  process.exit(0);
})().catch((e) => { console.error('audience-backfill FAILED:', e && e.message); process.exit(1); });
