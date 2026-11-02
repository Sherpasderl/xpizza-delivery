#!/usr/bin/env node
'use strict';
// CONVERGENCE §1 — the OWNER's platform-config CLI (portal source ↔ RTDB projection). DRY RUN unless --apply. Names + states only.
//   node tools/platform-config-admin.js seed     --project <id> --rid <rid> [--apply]   ← BREAK-GLASS: founding legacy fields, no overwrite
//   node tools/platform-config-admin.js generate --project <id> --rid <rid> [--apply]   ← portal source → projection
//   node tools/platform-config-admin.js drift    --project <id> (--rid <rid> | --all)   ← read-only
// --project must be the explicit flag. `--rid=` (equals form) / a missing rid ⇒ exit 2 (never a fan-out).
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const { parseArgs, seed, generate } = require('../platform-config/admin-core');
const { checkDrift } = require('../platform-config/drift');

const args = parseArgs(process.argv.slice(2));
if (!args.ok) { console.error(`platform-config-admin: REFUSED — ${args.why}`); process.exit(2); }
const PROJECT_ID = requireProject({ requireFlag: true });
const { RTDB_URL } = require('../catalog/mirror-rtdb');
admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const fs = admin.firestore(); const db = admin.database();

(async () => {
  const mode = args.sub === 'drift' ? 'READ-ONLY' : args.apply ? 'APPLY' : 'DRY RUN';
  console.log(`platform-config-admin ${args.sub} ${mode} — project ${PROJECT_ID}`);
  let rids = args.rid ? [args.rid] : [];
  if (args.all) { const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry'); rids = (await makeFirestoreRegistryReader(fs)()).sort(); }
  let bad = 0;
  for (const rid of rids) {
    const r = args.sub === 'seed' ? await seed({ fs, apply: args.apply, now: Date.now() }, rid)
      : args.sub === 'generate' ? await generate({ fs, db, apply: args.apply, now: Date.now() }, rid) : await checkDrift({ fs, db }, rid);
    console.log(`  ${r.rid}: ${r.state}${r.version ? ` (v${r.version})` : ''}${r.source_version ? ` (source v${r.source_version})` : ''}`);
    if (/refused|conflict|stale|drift|invalid|orphan/.test(r.state)) bad += 1;
  }
  if (!args.apply && args.sub !== 'drift') console.log('(dry run — nothing written; add --apply)');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('platform-config-admin FAILED:', e && e.message); process.exit(1); });
