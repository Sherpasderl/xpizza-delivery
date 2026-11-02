#!/usr/bin/env node
'use strict';
// PLAN-photos-public-bucket-config r5 §4 step 2 — the owner's READ-ONLY photos-config census (no writes; prints COUNTS and DISTINCT bucket
// NAMES only), then the decision table (tools/photos-config-census-core.js decide) over step 1's printed tokens:
//   node tools/photos-config-census.js --project xpizza-delivery \
//     --storage-bucket <name|<absent>> --legacy-private <<unset>|<present:…>> --legacy-public <<unset>|<present:…>>
// Exit: 0 = a commit plan (printed; the executor commits exactly it) · 3 = STOP (the row and reason printed; commit nothing) ·
// 2 = REFUSED (no project, a storage/firestore emulator variable, or a malformed argument — nothing read).
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // before any client
const { decide, census, parseDeployed } = require('./photos-config-census-core');

const refuse = (why) => { console.error(`photos-config-census: REFUSED — ${why}`); process.exit(2); };
for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST']) if (process.env[k]) refuse(`${k} is set — this census reads the real project`);
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project') { i++; continue; }
  if (a.startsWith('--project=')) continue;
  const m = /^--(storage-bucket|legacy-private|legacy-public)$/.exec(a);
  if (m && argv[i + 1] !== undefined) { flags[m[1]] = argv[++i]; continue; }
  refuse(`unknown or malformed argument ${JSON.stringify(a)}`);
}
let deployed;
try { deployed = parseDeployed({ storageBucket: flags['storage-bucket'], legacyPrivate: flags['legacy-private'], legacyPublic: flags['legacy-public'] }); } catch (e) { refuse(e.message); }

const admin = require('firebase-admin');
admin.initializeApp({ projectId: PROJECT_ID });
(async () => {
  const committed = require('../photos/photos-config').loadPhotosConfig();
  const committedPublic = committed.ok && Object.prototype.hasOwnProperty.call(committed.config.public_bucket, PROJECT_ID) ? committed.config.public_bucket[PROJECT_ID] : '';
  const c = await census(admin.firestore());
  const d = decide({ deployed, census: c, committedPublic });
  console.log(JSON.stringify({ project: PROJECT_ID, counts: c.counts, publicHosts: c.publicHosts, decision: d }, null, 1));
  process.exit(d.stop ? 3 : 0);
})().catch((e) => { console.error(`photos-config-census: ERROR — ${String((e && e.message) || e).slice(0, 200)}`); process.exit(1); });
