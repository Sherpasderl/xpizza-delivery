#!/usr/bin/env node
'use strict';
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2) — the OWNER's driver pay-rate CLI. DRY RUN unless --apply.
//
//   node tools/set-driver-rate.js --project xpizza-delivery --cents 7000 --effective-from 2026-11-03            ← plan only
//   node tools/set-driver-rate.js --project xpizza-delivery --cents 7000 --effective-from 2026-11-03T06:00 --apply
//
// APPEND-ONLY: writes ONE new {cents, effective_from} entry under a new push key at platform_rates/driver_per_delivery,
// never edits or deletes an entry (a rate change is a new entry; past deliveries keep their rate). --effective-from is an
// ISO date / time; with no zone it is Honduras time (UTC-6). Refuses --cents outside 100–100000 (L 1 – L 1,000) or not an
// integer, an effective_from before 2026-01-01 or more than 366 days ahead (pay-rate.js's bounds contract), a duplicate
// effective_from, and a PAST effective_from unless --allow-past (that would re-rate every delivery since then). The Admin SDK bypasses the
// rules (clients cannot write the node). --project must be the explicit flag (an inherited GOOGLE_CLOUD_PROJECT is refused).
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // the project guard FIRST (its refusal banner), before any client
const { NODE, parseArgs, planRate, appendRate } = require('./set-driver-rate-core');
const req = parseArgs(process.argv.slice(2));               // then the arguments (pure) — still before any credential or client
if (req.error) { console.error(`set-driver-rate: REFUSED — ${req.error}`); process.exit(2); }
const admin = require('firebase-admin');
const { RTDB_URL } = require('../catalog/mirror-rtdb');

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const db = admin.database();

(async () => {
  const now = Date.now();
  const existing = (await db.ref(NODE).once('value')).val();
  const { entry, refusals, notes } = planRate(existing, req, now);
  console.log(`set-driver-rate ${req.apply ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID} — ${NODE}: ${Object.keys(existing || {}).length} existing entr${Object.keys(existing || {}).length === 1 ? 'y' : 'ies'}`);
  const iso = (t) => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toISOString() : 'invalid'; };   // a malformed stored entry must not crash the listing
  for (const [k, e] of Object.entries(existing || {}).sort()) console.log(`  ${k}: ${JSON.stringify(e)}  (from ${iso(e && e.effective_from)})`);
  console.log(`  NEW: ${JSON.stringify(entry)}  (from ${new Date(entry.effective_from).toISOString()})`);
  for (const nt of notes) console.log(`  · ${nt}`);
  if (refusals.length) { for (const r of refusals) console.error(`set-driver-rate: REFUSED — ${r}`); process.exit(1); }
  if (!req.apply) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const key = await appendRate(db, entry, () => db.ref(NODE).push().key, now);
  console.log(`set-driver-rate: appended ${NODE}/${key} = ${JSON.stringify(entry)} and read it back`);
  process.exit(0);
})().catch((e) => { console.error('set-driver-rate FAILED:', e && e.message); process.exit(1); });
