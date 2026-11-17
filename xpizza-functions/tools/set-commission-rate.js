#!/usr/bin/env node
'use strict';
// LEDGER S4 — the OWNER's commission-rate CLI. DRY RUN unless --apply.
//
//   node tools/set-commission-rate.js --project xpizza-delivery --scope _default --bp 1000 --effective-from 2026-11-20        ← plan only
//   node tools/set-commission-rate.js --project xpizza-delivery --scope _default --bp 1000 --effective-from 2026-11-20 --apply
//
// APPEND-ONLY at ledger_settings/commission/{_default | rid}: ONE new {bp, effective_from} entry under a new push key; nothing is edited or
// deleted. NEVER RETRO: a past effective_from is refused (no override). bp = basis points of the food the customer paid, ISV included
// (owner 11-16: 1000 = 10 %); per-restaurant rates are Sherpa-set. --project must be the explicit flag (an inherited project variable is
// refused). The Admin SDK bypasses the rules (the node has none: server-only).
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // the project guard FIRST, before any client
const { parseArgs, planRate, appendRate } = require('./set-commission-rate-core');
const { NODE } = require('../ledger/commission-rate');
const req = parseArgs(process.argv.slice(2));               // then the arguments (pure) — still before any credential or client
if (req.error) { console.error(`set-commission-rate: REFUSED — ${req.error}`); process.exit(2); }
const admin = require('firebase-admin');
const { RTDB_URL } = require('../catalog/mirror-rtdb');

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const db = admin.database();

(async () => {
  const now = Date.now();
  const existing = (await db.ref(NODE).once('value')).val();
  const { entry, refusals, notes } = planRate(existing, req, now);
  const scoped = (existing && existing[req.scope]) || {};
  console.log(`set-commission-rate ${req.apply ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID} — ${NODE}/${req.scope}: ${Object.keys(scoped).length} existing entr${Object.keys(scoped).length === 1 ? 'y' : 'ies'}`);
  const iso = (t) => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toISOString() : 'invalid'; };
  for (const [k, e] of Object.entries(scoped).sort()) console.log(`  ${k}: ${JSON.stringify(e)}  (from ${iso(e && e.effective_from)})`);
  console.log(`  NEW: ${JSON.stringify(entry)}  (from ${iso(entry.effective_from)})`);
  for (const nt of notes) console.log(`  · ${nt}`);
  if (refusals.length) { for (const r of refusals) console.error(`set-commission-rate: REFUSED — ${r}`); process.exit(1); }
  if (!req.apply) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const key = await appendRate(db, req.scope, entry, () => db.ref(`${NODE}/${req.scope}`).push().key, now);
  console.log(`set-commission-rate: appended ${NODE}/${req.scope}/${key} = ${JSON.stringify(entry)} and read it back`);
  process.exit(0);
})().catch((e) => { console.error('set-commission-rate FAILED:', e && e.message); process.exit(1); });
