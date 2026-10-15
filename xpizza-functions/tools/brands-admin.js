#!/usr/bin/env node
'use strict';
// PLATFORM F1 — the OWNER's brands CLI (PLAN-multi-location §1.2). DRY RUN unless --apply.
//
//   node tools/brands-admin.js --project <id> status                      ← every brand: validity + membership findings (read-only)
//   node tools/brands-admin.js --project <id> seed-legacy <rid> [--apply]  ← /brands/<rid> = legacy singleton of an existing restaurant
//   node tools/brands-admin.js --project <id> publish <brandId> [--apply]  ← /public/brands/<brandId> from the brand + member identities
//
// Writes ONLY brands/<rid> (create-only) or public/brands/<brandId>, each read back. RTDB only. No brand literal: ids are arguments.
// --project must be the explicit flag: an inherited GOOGLE_CLOUD_PROJECT is refused, for status and writes alike.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { runBrandsAdmin } = require('../brands/brands-admin-core');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project') && a !== PROJECT_ID);
const [op, id] = args.filter((a) => !a.startsWith('--'));

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });

(async () => {
  console.log(`brands-admin — project ${PROJECT_ID}`);
  const code = await runBrandsAdmin({ rtdb: admin.database(), op, id, apply: args.includes('--apply'), nowMs: Date.now(), log: (l) => console.log(l) });
  process.exit(code);
})().catch((e) => { console.error('brands-admin FAILED:', e && e.message); process.exit(1); });
