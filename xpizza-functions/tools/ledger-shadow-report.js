#!/usr/bin/env node
'use strict';
// LEDGER S6 — the OWNER's READ-ONLY shadow-ledger report (names / counts / cents only; it never writes).
//
//   node tools/ledger-shadow-report.js --project xpizza-delivery --start 2026-11-20T10:00 --from 2026-11-21 --to 2026-11-27 [--json]
//
// --start = the ledger start (the S1 deploy time; Honduras time when no zone). --from / --to = COMPLETED HN service dates (at most 62), the
// first AFTER the start day. Each row: stats_daily (minus the validated pre-cohort sales) vs the ledger's PERSISTED journals, with explicit
// bridges ⇒ match / MISMATCH / not comparable (stats missing or not yet published for the day, or no nightly run after it — then NO
// difference is printed). Every read is bounded (MAX_RECORDS) and the run is time-capped (MAX_MS): over either ⇒ «report incomplete:
// budget exceeded». The core is tools/ledger-shadow-report-core.js.
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // the project guard FIRST (the platform's CLI contract: endpoint-census / project-guard)
const C = require('./ledger-shadow-report-core');
const req = C.parseArgs(process.argv.slice(2));             // then the arguments (pure) — still before any credential or client
if (req.error) { console.error(`ledger-shadow-report: REFUSED — ${req.error}`); process.exit(2); }
const t0 = Date.now();
const rangeErr = C.rangeError(req, t0);
if (rangeErr) { console.error(`ledger-shadow-report: REFUSED — ${rangeErr}`); process.exit(2); }
const admin = require('firebase-admin');
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const ST = require('../stats/stats-time');
const SB = require('../stats/stats-build');
const { readDailies } = require('../stats/stats-store');
const { readSources } = require('../ledger/rebuild');
const DL = require('../driver-ledger/ledger-core');

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const db = admin.database(); const fs = admin.firestore();
class Budget extends Error {}
const check = (records) => { const why = C.overBudget({ records, elapsedMs: Date.now() - t0 }); if (why) throw new Budget(why); };
const read = async (ref) => { const v = (await ref.once('value')).val(); check(v && typeof v === 'object' ? Object.keys(v).length : 0); return v; };
const ms = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : Number.isSafeInteger(x) ? x : null);   // a Firestore Timestamp

(async () => {
  const lo = ST.dayStartMs(req.from) - ST.READ_PAD_MS; const hi = ST.dayEndMs(req.to);
  const orders = (await read(db.ref('orders').orderByChild('created_at').startAt(lo).endAt(hi).limitToFirst(C.MAX_RECORDS + 1))) || {};
  const open = (await read(db.ref('ledger/open').orderByKey().limitToFirst(C.MAX_RECORDS + 1))) || {};
  const stale = (await read(db.ref('ledger/stale').orderByKey().limitToFirst(C.MAX_RECORDS + 1))) || {};
  for (const id of [...Object.keys(open), ...Object.keys(stale)]) if (!orders[id]) { const o = await read(db.ref(`orders/${id}`)); if (o) orders[id] = o; }
  const projections = {}; const snapshots = {}; const sdk = {};
  for (const id of Object.keys(orders)) {
    const p = await read(db.ref(`ledger/orders/${id}`));
    if (p) projections[id] = p;
    if (p && orders[id].created_at >= req.start) { const s = await readSources(db, id); snapshots[id] = s.alloc; if (s.sdk) sdk[id] = s.sdk; check(0); }
  }
  const runs = (await read(db.ref('ledger/run').orderByKey().startAt(req.from).endAt(ST.dateOf(Date.now())).limitToFirst(C.MAX_RECORDS + 1))) || {};
  const weeks = (await read(db.ref('driver_ledger_weeks').orderByKey().startAt(DL.weekOf(ST.dayStartMs(req.from))).endAt(DL.weekOf(hi - 1)).limitToFirst(C.MAX_RECORDS + 1))) || {};
  const rids = [...new Set(Object.values(orders).map((o) => SB.ridOf(o)))].sort();
  const dates = ST.datesBetween(req.from, req.to);
  const stats = {};
  for (const rid of rids) {
    const docs = Object.fromEntries(await readDailies(fs, rid, dates));
    stats[rid] = {}; for (const [d, doc] of Object.entries(docs)) stats[rid][d] = { ...doc, computed_at: ms(doc.computed_at) };
    check(0);
  }
  const r = C.buildReport({ start: req.start, from: req.from, to: req.to, now: Date.now(), orders, snapshots, sdk, projections, open, stale, runs, stats, weeks });
  if (req.json) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  const L = (x) => (x / 100).toFixed(2);
  console.log(`LEDGER SHADOW REPORT — project ${PROJECT_ID} — cohort from ${new Date(r.cohort.start).toISOString()} — service dates ${r.cohort.from} … ${r.cohort.to}`);
  for (const d of r.days) {
    const head = `${d.rid} ${d.date}: stats ${d.stats.orders} / L ${L(d.stats.cents)} (raw ${d.stats_raw.orders}, pre-cohort ${d.pre_cohort.orders}); ledger ${d.ledger.orders} / L ${L(d.ledger.cents)} (cash bridged ${d.cash_bridged.orders}); bridges: cash awaiting ${d.bridges.cash_awaiting_fulfilment.orders}, sdk not captured ${d.bridges.sdk_authorized_not_captured.orders}`;
    const tail = d.status === 'not_comparable' ? `NOT COMPARABLE (${d.not_comparable.join(', ')}) — no difference shown`
      : d.status === 'match' ? 'match' : `MISMATCH: ${d.diff.orders} orders / L ${L(d.diff.cents)}${Object.keys(d.journal_faults).length ? `; journal faults ${JSON.stringify(d.journal_faults)}` : ''}`;
    console.log(`${head} ⇒ ${tail}`);
  }
  console.log(`cash: ${r.cash.cash_sales} cash sales, ${r.cash.accrual_only} accrual only, ${r.cash.awaiting_fulfilment} awaiting fulfilment; card_delivery (not cash): ${r.cash.card_delivery_sales}`);
  for (const w of r.driver) console.log(`driver week ${w.week}: ${w.drivers} drivers, ${w.deliveries} deliveries, L ${L(w.net_cents)} net, ${w.payable} payable, ${w.paid} paid`);
  const c = r.in_range;
  console.log(`IN RANGE: not projected ${c.not_projected}, no snapshot ${c.no_snapshot}; quarantined ${JSON.stringify(c.quarantined)}; unresolved ${JSON.stringify(c.unresolved)}; journal faults ${JSON.stringify(c.journal_faults)}`);
  console.log(`GLOBAL BACKLOG: open set by status ${JSON.stringify(r.global.open_status)}, by age ${JSON.stringify(r.global.open_by_age)}; STALE holds (a person must resolve) ${JSON.stringify(r.global.stale_hold)}`);
  for (const x of r.coverage.runs) console.log(`run ${x.date}: ${x.finished ? 'finished' : `NOT finished (${x.stopped})`}, attempt ${x.attempt}, ${JSON.stringify(x.counts)}`);
  if (r.coverage.missing_run_dates.length) console.log(`no run record: ${r.coverage.missing_run_dates.join(', ')}`);
  process.exit(0);
})().catch((e) => {
  if (e instanceof Budget) { console.error(`ledger-shadow-report: ${e.message}`); process.exit(3); }
  console.error('ledger-shadow-report FAILED:', (e && e.code) || 'error'); process.exit(1);
});
