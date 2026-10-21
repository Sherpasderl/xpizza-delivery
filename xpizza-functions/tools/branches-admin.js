#!/usr/bin/env node
'use strict';
// ORCHESTRATION O1a — the SHERPA-admin branches CLI (PLAN-multi-location-orchestration r3.1 §2–§4, §6). DRY RUN unless --apply.
//
//   node tools/branches-admin.js --project <id> status <brandId>                                   ← every branch's state (read-only)
//   node tools/branches-admin.js --project <id> materialize <rid> --lat N --lng N --address S [--reference S] [--radius KM] [--apply]
//   node tools/branches-admin.js --project <id> set-location <rid> --expected-version N [--lat N --lng N] [--address S] [--reference S] [--radius KM] [--apply]
//   node tools/branches-admin.js --project <id> enrich-legacy <rid> --expected-version N --location-name S --prep MIN [--address S] [--apply]
//   node tools/branches-admin.js --project <id> resume <rid> [--apply]          ← finish an unfinished op from its durable inputs
//   node tools/branches-admin.js --project <id> delete-draft <rid> [--apply]
//   node tools/branches-admin.js --project <id> activate-brand <brandId> [--open rid,rid] [--apply]   ← a NEW brand off → on (legacy cutover: O3)
//   node tools/branches-admin.js --project <id> deactivate-brand <brandId> [--apply]                  ← on → off (rollback)
//   node tools/branches-admin.js --project <id> resync-projection <rid> [--apply]   ← version-only bump + fenced publish (one-time catch-up)
//
// RTDB only. No brand literal: ids are arguments. --project must be the explicit flag: an inherited GOOGLE_CLOUD_PROJECT is refused.
const admin = require('firebase-admin');
const crypto = require('crypto');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { runBranchesAdmin, parseOpts } = require('../branches/branches-admin-core');

const argv = process.argv.slice(2);
const pi = argv.indexOf('--project');
const rest = argv.filter((a, i) => a !== '--apply' && !(pi >= 0 && (i === pi || i === pi + 1)) && !a.startsWith('--project='));
const [op, id, ...flags] = rest;

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });

(async () => {
  console.log(`branches-admin — project ${PROJECT_ID}`);
  const code = await runBranchesAdmin({ rtdb: admin.database(), op, id, opts: parseOpts(flags), apply: argv.includes('--apply'), nowMs: Date.now(),
    callId: `cli_${crypto.randomBytes(6).toString('hex')}`, log: (l) => console.log(l) });
  process.exit(code);
})().catch((e) => { console.error('branches-admin FAILED:', e && e.message); process.exit(1); });
