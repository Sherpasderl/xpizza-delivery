#!/usr/bin/env node
'use strict';
// P-SELFUPDATE §4/§6 — the owner's VERSION REPORT (read-only). The D4-c go/no-go evidence:
//
//   node tools/client-version-report.js --project <id> [--hours 24] [--require orders=2,kitchen=2] [--logs]
//
//   • LIVE instances (last 30 min) per app × deployment × build × compat;
//   • HISTORICAL hourly coverage per manifest deployment × context over the window's complete UTC hours — an hour with
//     no report is listed as UNKNOWN (never "zero stale");
//   • reports BELOW the required generation per app (--require);
//   • HEADER-LESS identity requests from Cloud Logging (--logs runs `gcloud logging read`; without it, the exact command
//     is printed and the header-less count is reported as UNKNOWN). Advisor ruling R3.1.
// Reads only. Writes nothing anywhere.
const { execFileSync } = require('child_process');
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject();
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { PLATFORM } = require('../platform-manifest');
const R = require('./client-version-report-core');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const HOURS = Math.max(1, Math.min(24 * 30, Number(opt('--hours', '24')) || 24));
const REQUIRED = Object.fromEntries(String(opt('--require', '')).split(',').filter(Boolean).map((kv) => { const [a, v] = kv.split('='); return [a, Number(v)]; }));

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const rtdb = admin.database();

(async () => {
  const now = Date.now();
  const live = R.aggregateLive((await rtdb.ref('client_versions').once('value')).val() || {}, now);
  // ONE explicit [start, end) of complete UTC hours, applied to the counters AND the log query (codex CP1 B2)
  const win = R.reportWindow(now, HOURS);
  const hours = win.hours;
  const stats = (await rtdb.ref('client_version_stats').orderByKey().startAt(hours[0]).endAt(hours[hours.length - 1]).once('value')).val() || {};
  const hist = R.aggregateHistory(stats, PLATFORM.sites.deployments, hours, REQUIRED);
  const filter = R.headerlessLogFilter(win);
  const LIMIT = 100000;
  const cmd = ['logging', 'read', filter, `--project=${PROJECT_ID}`, '--format=json', `--limit=${LIMIT}`];
  let headerless = 'UNKNOWN (run with --logs, or: gcloud ' + cmd.map((c) => (/\s/.test(c) ? `'${c}'` : c)).join(' ') + ')';
  if (argv.includes('--logs')) {
    try {
      const r = R.countHeaderless(JSON.parse(execFileSync('gcloud', cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })), { startMs: win.startMs, endMs: win.endMs, limit: LIMIT });
      // a capped read is a LOWER BOUND — reported as TRUNCATED, never as a complete count
      headerless = r.truncated ? { status: `TRUNCATED — the read hit --limit=${LIMIT}; counts below are a LOWER BOUND, not complete`, lower_bound: r.counts }
        : { status: 'complete', counts: r.counts, entries: r.entries };
    } catch (e) { headerless = `UNKNOWN (gcloud failed: ${e.message.slice(0, 120)})`; }
  }
  console.log(JSON.stringify({ project: PROJECT_ID, window: { hours: HOURS, from: hours[0], to: hours[hours.length - 1], start: win.startIso, end_exclusive: win.endIso }, required: REQUIRED,
    live, coverage: hist.coverage, totals: hist.totals, below_required: hist.below, headerless }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('client-version-report FAILED:', e && e.message); process.exit(1); });
