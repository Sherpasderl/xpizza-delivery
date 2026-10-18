#!/usr/bin/env node
'use strict';
// PLATFORM F2 Q1 (PLAN-F2-query-rules §1.2) — the OWNER's access census. READ-ONLY: writes nothing anywhere.
//
//   node tools/access-census.js --project <id> --mapping <kitchen-mapping.json>          ← every section gates (Q4)
//   node tools/access-census.js --project <id> --sections a,b [--mapping <file>]       ← only a+b gate (the Q3 KDS deploy)
//   sections: a ownership/membership · b KDS parity · c kitchen roster (needs --mapping) · e task keys; others → not_gating
//
// Prints one JSON report {blocking:[…], info:{attribution, history, scanned}}; exit 0 = clean, 1 = a blocking finding or a read
// failure (fail closed), 2 = usage / an invalid mapping. --project must be the explicit flag (an inherited project is refused).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { runAccessCensus } = require('../access/access-census-core');

const argv = process.argv.slice(2);
const mi = argv.indexOf('--mapping');
const mappingPath = mi >= 0 ? argv[mi + 1] : null;
const si = argv.indexOf('--sections');
const sections = si >= 0 ? String(argv[si + 1] || '').split(',').map((x) => x.trim()).filter(Boolean) : null;
if (!mappingPath && !(sections && !sections.includes('c'))) { console.error('usage: access-census.js --project <id> (--mapping <kitchen-mapping.json> | --sections <subset of a,b,c,e without c> [--mapping <file>])'); process.exit(2); }
let mapping = null;
if (mappingPath) { try { mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')); } catch (e) { console.error(`access-census: REFUSED — mapping unreadable: ${e.message}`); process.exit(2); } }
const sites = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'platform', 'sites.json'), 'utf8'));

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
(async () => {
  const filters = await import(pathToFileURL(path.join(__dirname, '..', 'access', 'kds-filter-pre-f2.mjs')).href);
  const { code, report } = await runAccessCensus({ rtdb: admin.database(), mapping, sites, filters, nowMs: Date.now(), sections });
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
})().catch((e) => { console.error('access-census FAILED (fail closed):', e && e.message); process.exit(1); });
