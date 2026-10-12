#!/usr/bin/env node
'use strict';
// 1D add-product B — READ-ONLY verifier of a published required-choice group, against an EXPECTED spec (JSON file).
//
//   node tools/verify-first-group.js --project <id> --rid <rid> --spec <file.json>
//   e.g. --rid x_pizza --spec tools/group-specs/ny-plain-slice.json   (the first use, after the owner publishes)
//
// Reads the LIVE active catalog, public menu and KDS manifest through production's own readers
// (tools/verify-first-group-core.js) and prints every check. Exit 0 = all pass, 1 = any fails, 2 = bad arguments.
// 🔴 WRITES NOTHING: the Firestore and RTDB handles are wrapped so every write method throws.
// --project must be the explicit FLAG (an inherited GOOGLE_CLOUD_PROJECT is refused), checked before any client exists.
const fs = require('fs');
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { verifyFirstGroup, validateSpec } = require('./verify-first-group-core');

const argOf = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const rid = argOf('--rid'); const specPath = argOf('--spec');
const usage = (why) => { console.error(`verify-first-group: ${why}\nusage: verify-first-group.js --project <id> --rid <rid> --spec <file.json>`); process.exit(2); };
if (!rid || !/^[a-z0-9_]{1,40}$/.test(rid)) usage('a valid --rid is required');
if (!specPath) usage('--spec <file.json> is required');
let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch (e) { usage(`cannot read the spec: ${e.message}`); }
const specErrs = validateSpec(spec);
if (specErrs.length) usage(`invalid spec — ${specErrs.join('; ')}`);

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });

(async () => {
  const r = await verifyFirstGroup({ fs: admin.firestore(), rtdb: admin.database(), rid, spec });
  console.log(`verify-first-group — project ${PROJECT_ID}, ${rid}, active version ${r.versionId || '—'}`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  [${c.surface}] ${c.what}${c.ok ? '' : `  — got ${JSON.stringify(c.detail)}`}`);
  console.log(r.ok ? `ALL ${r.checks.length} CHECKS PASS` : `${r.checks.filter((c) => !c.ok).length} of ${r.checks.length} checks FAIL`);
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('verify-first-group FAILED:', e && e.message); process.exit(1); });
