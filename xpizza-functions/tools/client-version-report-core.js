'use strict';
// P-SELFUPDATE §4/§6 — the owner's version report, as pure functions (tools/client-version-report.js wraps them).
//
// Three measurements, each stated with its own limits:
//   LIVE        client_versions/{app}/{instance} with last_seen in the last 30 min, grouped app × deployment × build × compat.
//   HISTORICAL  client_version_stats/{hour}/{deployment}/{context}/{compat} over a window of complete UTC hours. COVERAGE is
//               per manifest deployment × context × hour: an hour with NO report is UNKNOWN — never "zero stale".
//               Below-required = reports whose compat is lower than the REQUIRED generation for that app.
//   HEADER-LESS identity requests (pre-module pages) are counted from Cloud Logging's `client_version` lines (advisor
//               ruling R3.1 — never a database counter on the money path). Logs are kept 30 days.
const { hourKey, LIVE_WINDOW_MS } = require('../client-version');

function aggregateLive(byApp, now, liveMs = LIVE_WINDOW_MS) {
  const rows = new Map();
  for (const [app, instances] of Object.entries(byApp || {})) {
    for (const rec of Object.values(instances || {})) {
      if (!rec || typeof rec.last_seen !== 'number' || rec.last_seen < now - liveMs) continue;
      const k = JSON.stringify([app, rec.deployment, rec.build, rec.compat]);
      rows.set(k, (rows.get(k) || 0) + 1);
    }
  }
  return [...rows.entries()].map(([k, live]) => { const [app, deployment, build, compat] = JSON.parse(k); return { app, deployment, build, compat, live }; })
    .sort((a, b) => (a.app + a.deployment).localeCompare(b.app + b.deployment) || a.compat - b.compat);
}

// The complete UTC hours of a window ending at the last COMPLETE hour before `now`.
function windowHours(now, hours) {
  const out = [];
  const lastComplete = Math.floor(now / 3600000) * 3600000 - 3600000;
  for (let i = hours - 1; i >= 0; i -= 1) out.push(hourKey(lastComplete - i * 3600000));
  return out;
}

// ONE explicit observation window [startMs, endMs) — complete UTC hours — applied to BOTH sources (codex CP1 B2): the
// hourly heartbeat counters AND the Cloud Logging header-less query. A rolling `--freshness` would start mid-hour and
// silently miss the first partial hour of the window.
function reportWindow(now, hours) {
  if (!Number.isInteger(hours) || hours < 1) throw new Error('reportWindow: hours must be a positive INTEGER (whole UTC hours) — a fractional window would split an hourly counter bucket');
  const endMs = Math.floor(now / 3600000) * 3600000;           // the start of the current (incomplete) hour, exclusive
  const startMs = endMs - hours * 3600000;
  return { startMs, endMs, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(), hours: windowHours(now, hours) };
}

// stats: the client_version_stats subtree; deployments: the manifest's; required: { app: generation }
function aggregateHistory(stats, deployments, hours, required = {}) {
  const coverage = []; const below = []; const totals = [];
  for (const d of deployments) {
    const missing = [];
    let reports = 0; let belowN = 0;
    for (const h of hours) {
      const byCompat = (((stats || {})[h] || {})[d.id] || {})[d.context] || {};
      const n = Object.values(byCompat).reduce((a, v) => a + (Number(v) || 0), 0);
      if (!n) missing.push(h);
      reports += n;
      const req = required[d.app];
      if (Number.isInteger(req)) for (const [c, v] of Object.entries(byCompat)) if (Number(c) < req) belowN += Number(v) || 0;
    }
    totals.push({ deployment: d.id, context: d.context, app: d.app, reports });
    coverage.push({ deployment: d.id, context: d.context, app: d.app, hours: hours.length, unknown_hours: missing });
    if (Number.isInteger(required[d.app])) below.push({ deployment: d.id, context: d.context, app: d.app, required: required[d.app], below: belowN });
  }
  return { totals, coverage, below };
}

// Cloud Logging filter for the header-less identity requests (the log line is `client_version {json}`), bounded to the
// SAME [start, end) as the counters — explicit timestamp terms, no rolling freshness.
function headerlessLogFilter(win) {
  if (!win || !win.startIso || !win.endIso) throw new Error('headerlessLogFilter needs the explicit report window');
  return `textPayload:"client_version" AND textPayload:"\\"headerless\\":true" AND timestamp>="${win.startIso}" AND timestamp<"${win.endIso}"`;
}
// entries: gcloud logging read --format=json output → { counts: per endpoint × UTC hour, truncated, entries }.
// Only entries INSIDE [startMs, endMs) count. `truncated` when the read returned `limit` entries: the counts are then a
// LOWER BOUND and must never be presented as complete.
function countHeaderless(entries, { startMs = -Infinity, endMs = Infinity, limit = Infinity } = {}) {
  const out = {};
  const list = entries || [];
  for (const e of list) {
    const t = (e && e.textPayload) || '';
    const i = t.indexOf('{');
    if (!t.startsWith('client_version') || i < 0) continue;
    let j; try { j = JSON.parse(t.slice(i)); } catch (_) { continue; }
    if (j.headerless !== true || typeof j.endpoint !== 'string') continue;
    const ts = Date.parse(e.timestamp || '');
    if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) continue;   // outside the window (or untimed) — not counted
    const h = hourKey(ts);
    out[j.endpoint] = out[j.endpoint] || {};
    out[j.endpoint][h] = (out[j.endpoint][h] || 0) + 1;
  }
  return { counts: out, entries: list.length, truncated: list.length >= limit };
}

// STRICT CLI parsing (advisor FINAL ruling, codex CP1 r5) — Node's own util.parseArgs in STRICT mode, no positionals:
// an unknown flag, a surplus value (`--hours 2 3`, `--require a=1 b=2`), a value on a boolean (`--logs=false`) and the `--`
// trick are refused BY CONSTRUCTION. The supported options are exactly the CLI's own: --project (the project guard reads
// it), --hours, --require, --logs. Each at most ONCE (parseArgs alone would let the last one win silently). Then the value
// validators: --hours a whole number in [1,720]; --require app=<safe integer>[,…] with no empty entry and no app twice.
// → { ok, hours, required, logs } | { ok:false, error }. Called BEFORE any database access.
const { parseArgs } = require('util');
const REPORT_OPTIONS = {
  project: { type: 'string', multiple: true },
  hours: { type: 'string', multiple: true },
  require: { type: 'string', multiple: true },
  logs: { type: 'boolean', multiple: true },
};
function parseReportArgs(argv) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: REPORT_OPTIONS, strict: true, allowPositionals: false })); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  for (const k of Object.keys(REPORT_OPTIONS)) if (values[k] && values[k].length > 1) return { ok: false, error: `--${k} given more than once — pass it exactly once` };
  let hours = 24;
  if (values.hours) {
    const h = values.hours[0];
    if (!/^[0-9]+$/.test(h)) return { ok: false, error: `--hours must be a whole number of hours (got ${JSON.stringify(h)}); fractional windows are refused because the counters are hourly` };
    hours = Number(h);
    if (hours < 1 || hours > 720) return { ok: false, error: `--hours must be between 1 and 720 (got ${hours})` };
  }
  const required = {};
  if (values.require) {
    const r = values.require[0];
    if (r === '' || r.startsWith('-')) return { ok: false, error: '--require needs app=<integer generation>[,app=<integer>…] (no value given)' };
    for (const kv of r.split(',')) {
      if (kv === '') return { ok: false, error: `--require has an empty entry (${JSON.stringify(r)})` };
      const m = kv.match(/^([a-z0-9-]+)=([0-9]+)$/);
      if (!m) return { ok: false, error: `--require entries are app=<integer generation> (got ${JSON.stringify(kv)})` };
      const n = Number(m[2]);
      if (!Number.isSafeInteger(n)) return { ok: false, error: `--require generation for ${m[1]} is not a safe integer (got ${m[2]})` };
      if (Object.prototype.hasOwnProperty.call(required, m[1])) return { ok: false, error: `--require names ${m[1]} more than once (${JSON.stringify(r)})` };   // a TIGHTENING: was last-wins
      required[m[1]] = n;
    }
  }
  return { ok: true, hours, required, logs: !!(values.logs && values.logs[0]) };
}

module.exports = { aggregateLive, windowHours, reportWindow, parseReportArgs, aggregateHistory, headerlessLogFilter, countHeaderless };
