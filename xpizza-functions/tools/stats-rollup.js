#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — BACKFILL and TARGETED REPAIR (PLAN-stats rev 4 §S1.3). OWNER-RUN; never run by an
// executor against production.
//
//   DRY-RUN (default — reads only, writes NOTHING; prints what would be published + the size headroom):
//     node tools/stats-rollup.js backfill --project xpizza-delivery
//     node tools/stats-rollup.js repair   --project xpizza-delivery --restaurant <rid> --from 2026-09-01 --to 2026-09-03
//   COMMIT (same, plus --commit):
//     node tools/stats-rollup.js backfill --project xpizza-delivery --commit
//
// backfill: every business date from the first order (or --from) to YESTERDAY, in bounded batches of
//           --batch-days (default 31) — each batch is the SAME code path as the nightly job
//           (stats-job.js runStatsRollup, mode 'range'): its own lease, one bounded read, coherent publish.
// repair:   rebuilds exactly --from..--to for --restaurant, AND (by construction of the re-derived index)
//           every customer appearing in those dates. Use it for a late refund or a manual resolution older
//           than the nightly 7-day window.
//
// --project xpizza-delivery is MANDATORY as a flag (tools/require-project.js requireFlag): an inherited
// env var is not accepted. STATS_HMAC_SECRET must be set (the job fails CLOSED without it); never print it.
// ---------------------------------------------------------------------------
const T = require('../stats/stats-time');

function parseArgs(argv) {
  const out = { cmd: argv[0], restaurants: [], commit: false, batchDays: 31, from: null, to: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') out.commit = true;
    else if (a === '--project') i++;                                   // consumed by requireProject
    else if (a === '--restaurant') out.restaurants.push(argv[++i]);
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--batch-days') out.batchDays = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['backfill', 'repair'].includes(out.cmd)) throw new Error('usage: stats-rollup.js <backfill|repair> --project <id> [--restaurant r] [--from D] [--to D] [--batch-days N] [--commit]');
  for (const k of ['from', 'to']) if (out[k] != null && !T.isDate(out[k])) throw new Error(`--${k} must be YYYY-MM-DD`);
  if (out.cmd === 'repair' && (out.restaurants.length !== 1 || !out.from || !out.to)) throw new Error('repair needs exactly one --restaurant, --from and --to');
  if (!(Number.isInteger(out.batchDays) && out.batchDays >= 1 && out.batchDays <= 400)) throw new Error('--batch-days must be 1..400');
  return out;
}

// Date windows [from..to] split into batches of n days.
function batches(from, to, n) {
  const out = [];
  for (let d = from; d <= to; d = T.addDays(d, n)) {
    const end = T.addDays(d, n - 1);
    out.push({ from: d, to: end < to ? end : to });
  }
  return out;
}

async function earliestOrderDate(rtdb) {
  // ONE record, bounded: the smallest positive created_at (records with no created_at sort first under
  // orderByChild, so the range starts at 1 to skip them).
  const snap = await rtdb.ref('orders').orderByChild('created_at').startAt(1).limitToFirst(1).once('value');
  let ms = null;
  snap.forEach((c) => { const v = c.val(); ms = v && Number(v.created_at); });
  return Number.isFinite(ms) ? T.dateOf(ms) : null;
}

// The job's own wall-clock bound (index.js rollupDailyStats timeoutSeconds: 540), applied per window, so
// a CLI run can never outlive the lease it holds (LEASE_MS 600 s) — the same invariant the function has.
const WINDOW_TIMEOUT_MS = 540000;
const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`stats_cli_timeout: ${what} exceeded ${ms / 1000}s — its lease will lapse and any later publish is refused; re-run (pending_repair resumes)`), { code: 'stats_cli_timeout' })), ms); })]).finally(() => clearTimeout(t));
};

async function main(argv = process.argv.slice(2)) {
  // 🔴 THE PROJECT GUARD FIRST — before usage parsing, exactly as every other prod CLI: a missing or
  // wrong project is refused with tools/require-project.js's own message and EXIT 2 (catalog/
  // project-guard.test.js spawns this file and requires it). Usage errors come after and exit 1, so the
  // two stay distinguishable.
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });   // before ANY client exists
  const args = parseArgs(argv);
  try { require('dotenv').config(); } catch (_) { /* devDependency */ }
  const { loadStatsSecret, makeCustomerKeyer } = require('../stats/stats-identity');
  const keyer = makeCustomerKeyer(loadStatsSecret());       // fails CLOSED before any read
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const rtdb = admin.database();
  const fsdb = admin.firestore();
  const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
  const { runStatsRollup } = require('../stats/stats-job');

  const nowMs = Date.now();
  const yesterday = T.addDays(T.dateOf(nowMs), -1);
  const to = args.to || yesterday;
  const from = args.from || (await earliestOrderDate(rtdb));
  if (!from) { console.log('no orders found — nothing to do'); return 0; }
  if (to > yesterday) throw new Error(`--to ${to} is today or later; today is live-only`);
  console.log(`${args.cmd}: ${from} → ${to}  restaurants: ${args.restaurants.length ? args.restaurants.join(',') : '(all registered)'}  ${args.commit ? '🔴 COMMIT' : 'DRY-RUN (no writes)'}`);

  const deps = { rtdb, fsdb, listRestaurants: makeFirestoreRegistryReader(fsdb), keyer, log: () => {} };
  const windows = args.cmd === 'repair' ? [{ from, to }] : batches(from, to, args.batchDays);
  for (const w of windows) {
    const rep = await withTimeout(runStatsRollup(deps, { nowMs, mode: 'range', from: w.from, to: w.to, restaurants: args.restaurants.length ? args.restaurants : undefined, commit: args.commit, strictLease: true }), WINDOW_TIMEOUT_MS, `window ${w.from}..${w.to}`);
    for (const [rid, r] of Object.entries(rep.restaurants)) {
      const m = (r.measures || []).reduce((a, x) => ({ writes: Math.max(a.writes, x.writes), bytes: Math.max(a.bytes, x.commit_bytes), doc: Math.max(a.doc, x.max_doc_bytes) }), { writes: 0, bytes: 0, doc: 0 });
      console.log(`  ${w.from}..${w.to} ${rid}: ${r.sale_orders} sales, L ${(r.sale_cents / 100).toFixed(2)}; max tx ${m.writes} writes / ${m.bytes} B; max doc ${m.doc} B${r.epochs && r.epochs.length ? `; published epochs ${r.epochs.join(',')}` : ''}`);
    }
    console.log(`  read: ${rep.read ? `${rep.read.records} orders, ${rep.read.bytes} B, ${rep.read.chunks} chunk(s)` : '-'}`);
  }
  console.log(args.commit ? 'done (committed)' : 'dry-run complete — nothing was written. Re-run with --commit to publish.');
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error('stats-rollup failed:', (e && e.message) || e); process.exit(1); });
}

module.exports = { parseArgs, batches, earliestOrderDate, main, withTimeout, WINDOW_TIMEOUT_MS };
