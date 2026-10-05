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

module.exports = { aggregateLive, windowHours, reportWindow, aggregateHistory, headerlessLogFilter, countHeaderless };
