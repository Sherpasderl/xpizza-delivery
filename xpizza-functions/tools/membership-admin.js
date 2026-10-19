#!/usr/bin/env node
'use strict';
// PLAN-portal-membership r3 §7 — the OWNER's one-time membership cutover CLI (replaces tools/seed-owner.js). DRY RUN unless --apply.
//
//   node tools/membership-admin.js --project <id> census                ← READ-ONLY; refuses (exit 3) unless prod is the known shape
//   node tools/membership-admin.js --project <id> backfill [--apply]    ← bootstrap_owner for each census-verified owner (new paths only)
//   node tools/membership-admin.js --project <id> reconcile [--apply]   ← member_of vs the forward rosters; --apply repairs the INDEX only
//   node tools/membership-admin.js --project <id> compare               ← old vs new decisions + lists; refuses (exit 6) on any difference
//   node tools/membership-admin.js --project <id> transfer-owner <brandId> <uid> [--apply]  ← the ONLY way to change a brand's single owner
//
// The runbook (PLAN §7): freeze on → census → backfill → reconcile → compare → deploy → rules verify → smoke → owner acceptance → freeze off.
// --project must be the explicit flag: an inherited GOOGLE_CLOUD_PROJECT is refused. RTDB only. No brand literal: everything is read.
const admin = require('firebase-admin');
const os = require('os');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { runMembershipAdmin } = require('../access/membership-admin-core');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project') && a !== PROJECT_ID);
const [op, ...opArgs] = args.filter((a) => !a.startsWith('--'));

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });

(async () => {
  console.log(`membership-admin — project ${PROJECT_ID}`);
  const code = await runMembershipAdmin({ db: admin.database(), op, args: opArgs, apply: args.includes('--apply'), operator: os.userInfo().username || 'operator',
    now: () => Date.now(), log: (l) => console.log(l) });
  process.exit(code);
})().catch((e) => { console.error('membership-admin FAILED:', e && e.message); process.exit(1); });
