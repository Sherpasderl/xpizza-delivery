#!/usr/bin/env node
'use strict';
// TRACKER FIXES — the OWNER-run flag-transition tool (BUILD-tracker-fixes r1.5 §0; logic in tracking/reconcile-core.js).
//
//   node tools/tracker-reconcile.js --project xpizza-delivery --mode on|off [--apply]
//
// DRY RUN (read-only) unless --apply. --mode on --apply needs MAKE_SECRET in the environment (owner-provided; never printed). --project must be the explicit flag (pinned before any client is constructed).
//   OFF → ON:  set config/tracker_fixes_enabled = true; wait 10 min; --mode on (dry run, then --apply); run --mode on --apply AGAIN →
//              it must report 0 customer-visible changes.
//   ON → OFF:  set the flag false; wait 10 min; --mode off (dry run, then --apply); run --mode off AGAIN → 0 nodes carrying mx.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { runReconcile } = require('../tracking/reconcile-core');

const argv = process.argv.slice(2);
const mi = argv.indexOf('--mode');
const mode = mi >= 0 ? argv[mi + 1] : null;
if (mode !== 'on' && mode !== 'off') { console.error('usage: tracker-reconcile.js --project <id> --mode on|off [--apply]'); process.exit(2); }
const apply = argv.includes('--apply');
// --mode on recomputes, which needs the tag secret the functions use (MAKE_SECRET, provided by the owner in the environment —
// never printed). Fail closed BEFORE any read rather than half-way through the window.
if (mode === 'on' && apply && !process.env.MAKE_SECRET) { console.error('tracker-reconcile: REFUSED — --mode on --apply needs MAKE_SECRET in the environment'); process.exit(2); }

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
(async () => {
  console.log(`tracker-reconcile — project ${PROJECT_ID} — mode ${mode}${apply ? ' — APPLY' : ' — dry run'}`);
  const { recomputeOrderTracker } = require('../tracking/recompute');
  const s = await runReconcile({ db: admin.database(), mode, apply, log: (l) => console.log(l), recompute: recomputeOrderTracker });
  console.log(JSON.stringify({ window: s.window, outForDelivery: s.outForDelivery, terminal24h: s.terminal24h, visibleChanges: s.visibleChanges, mxPresent: s.mxPresent, mxRemoved: s.mxRemoved }));
  process.exit(0);
})().catch((e) => { console.error('tracker-reconcile FAILED:', e && e.message); process.exit(1); });
