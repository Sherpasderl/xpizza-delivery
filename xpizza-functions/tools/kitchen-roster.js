#!/usr/bin/env node
'use strict';
// PLATFORM F2 Q1 (PLAN-F2-query-rules §1.3) — the OWNER's kitchen-roster migration: the reviewed mapping → restaurants/*/kitchen_staff.
//
//   node tools/kitchen-roster.js --project <id> --mapping <kitchen-mapping.json> [--apply]
//
// DRY RUN unless --apply (prints the exact add/remove diff). Apply = one multi-path update, read back. Verify afterwards with
// tools/access-census.js (roster findings = 0). --project must be the explicit flag.
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { runKitchenRoster } = require('../access/kitchen-roster-core');

const argv = process.argv.slice(2);
const mi = argv.indexOf('--mapping');
const mappingPath = mi >= 0 ? argv[mi + 1] : null;
if (!mappingPath) { console.error('usage: kitchen-roster.js --project <id> --mapping <kitchen-mapping.json> [--apply]'); process.exit(2); }
let mapping;
try { mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')); } catch (e) { console.error(`kitchen-roster: REFUSED — mapping unreadable: ${e.message}`); process.exit(2); }
const sites = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'platform', 'sites.json'), 'utf8'));
const kitchenDeployments = new Set(sites.deployments.filter((d) => d.app === 'kitchen').map((d) => d.id));

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
(async () => {
  console.log(`kitchen-roster — project ${PROJECT_ID}${argv.includes('--apply') ? ' — APPLY' : ' — dry run'}`);
  const brands = (await admin.database().ref('brands').once('value')).val() || {};
  const locations = new Set(Object.values(brands).flatMap((b) => Object.keys((b && b.locations) || {})));
  const code = await runKitchenRoster({ rtdb: admin.database(), mapping, locations, kitchenDeployments, apply: argv.includes('--apply'), log: (l) => console.log(l) });
  process.exit(code);
})().catch((e) => { console.error('kitchen-roster FAILED:', e && e.message); process.exit(1); });
