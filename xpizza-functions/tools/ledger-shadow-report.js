#!/usr/bin/env node
'use strict';
// LEDGER S6 — the OWNER's READ-ONLY shadow-ledger report (names / counts / cents only; it never writes).
//
//   node tools/ledger-shadow-report.js --project xpizza-delivery --start 2026-11-20T10:00 --from 2026-11-21 --to 2026-11-27 [--json]
//
// --start = the ledger start (the S1 deploy time; Honduras time when no zone): both sides are compared on orders created at or after it.
// --from / --to = HN service dates (at most 62), the first one AFTER the start day. Reads (all bounded, all indexed): orders by created_at
// over the range (+ the stats read pad, for scheduled orders), the ledger projection and S1 snapshot of each, the open set, the nightly
// run records, the S8 driver weeks, and restaurants/{rid}/stats_daily/{date} by id. The core is tools/ledger-shadow-report-core.js.
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // the project guard FIRST (the platform's CLI contract: endpoint-census / project-guard)
const { parseArgs, buildReport } = require('./ledger-shadow-report-core');
const req = parseArgs(process.argv.slice(2));               // then the arguments (pure) — still before any credential or client
if (req.error) { console.error(`ledger-shadow-report: REFUSED — ${req.error}`); process.exit(2); }
const admin = require('firebase-admin');
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const ST = require('../stats/stats-time');
const SB = require('../stats/stats-build');
const { readDailies } = require('../stats/stats-store');
const { readSources } = require('../ledger/rebuild');
const DL = require('../driver-ledger/ledger-core');

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const db = admin.database(); const fs = admin.firestore();
const val = async (q) => (await q.once('value')).val() || {};

(async () => {
  const now = Date.now();
  const lo = ST.dayStartMs(req.from) - ST.READ_PAD_MS; const hi = ST.dayEndMs(req.to);
  const orders = await val(db.ref('orders').orderByChild('created_at').startAt(lo).endAt(hi));
  const open = await val(db.ref('ledger/open'));
  const stale = await val(db.ref('ledger/stale'));
  for (const id of [...Object.keys(open), ...Object.keys(stale)]) if (!orders[id]) { const o = (await db.ref(`orders/${id}`).once('value')).val(); if (o) orders[id] = o; }
  const projections = {}; const snapshots = {};
  for (const id of Object.keys(orders)) {
    const p = (await db.ref(`ledger/orders/${id}`).once('value')).val();
    if (p) projections[id] = { status: p.status, reasons: p.reasons || [] };
    if (p && orders[id].created_at >= req.start) snapshots[id] = (await readSources(db, id)).alloc;
  }
  const runs = await val(db.ref('ledger/run').orderByKey().startAt(req.from).endAt(req.to));
  const weeks = await val(db.ref('driver_ledger_weeks').orderByKey().startAt(DL.weekOf(ST.dayStartMs(req.from))).endAt(DL.weekOf(hi - 1)));
  const rids = [...new Set(Object.values(orders).map((o) => SB.ridOf(o)))].sort();
  const dates = ST.datesBetween(req.from, req.to);
  const stats = {};
  for (const rid of rids) stats[rid] = Object.fromEntries(await readDailies(fs, rid, dates));
  const r = buildReport({ start: req.start, from: req.from, to: req.to, now, orders, snapshots, projections, open, runs, stats, weeks, stale });
  if (req.json) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  const L = (x) => (x / 100).toFixed(2);
  console.log(`LEDGER SHADOW REPORT — project ${PROJECT_ID} — cohort from ${new Date(r.cohort.start).toISOString()} — service dates ${r.cohort.from} … ${r.cohort.to}`);
  console.log('restaurant  date        stats(orders / L)    ledger(orders / L)   diff(orders / L)   pre-cohort   sdk placed, not captured');
  for (const d of r.days) console.log(`${d.rid.padEnd(11)} ${d.date}  ${String(d.stats.orders).padStart(4)} / ${L(d.stats.cents).padStart(10)}   ${String(d.ledger.orders).padStart(4)} / ${L(d.ledger.cents).padStart(10)}   ${String(d.diff.orders).padStart(3)} / ${L(d.diff.cents).padStart(9)}   ${String(d.pre_cohort.orders).padStart(3)}          ${d.sdk_placed_not_captured}`);
  console.log(`cash: ${r.cash.cash_sales} cash sales, ${r.cash.accrual_only} accrual only (no collection evidence); card_delivery (not cash): ${r.cash.card_delivery_sales}`);
  for (const w of r.driver) console.log(`driver week ${w.week}: ${w.drivers} drivers, ${w.deliveries} deliveries, L ${L(w.net_cents)} net, ${w.payable} payable, ${w.paid} paid`);
  const c = r.completeness;
  console.log(`completeness: not projected ${c.not_projected}, no snapshot ${c.no_snapshot}; quarantined ${JSON.stringify(c.quarantined)}; unresolved ${JSON.stringify(c.unresolved)}; pending by age ${JSON.stringify(c.pending_age)}; STALE holds (a person must resolve) ${JSON.stringify(c.stale_hold)}`);
  for (const x of r.coverage.runs) console.log(`run ${x.date}: ${x.finished ? 'finished' : `NOT finished (${x.stopped})`}, attempt ${x.attempt}, ${JSON.stringify(x.counts)}`);
  if (r.coverage.missing_run_dates.length) console.log(`no run record: ${r.coverage.missing_run_dates.join(', ')}`);
  process.exit(0);
})().catch((e) => { console.error('ledger-shadow-report FAILED:', (e && e.code) || 'error'); process.exit(1); });
