#!/usr/bin/env node
'use strict';
// PORTAL SPEED (PLAN-portal-speed rev 3 §5) — the OWNER-RUN latency probe, before and after the Phase 1 deploy.
// READ endpoints only (getMyRestaurants, getEditableCatalog, getSalesStats): this probe never writes anything.
//
//   PORTAL_PROBE_ID_TOKEN=<a portal owner's Firebase ID token>   (read from the env; NEVER printed or written)
//   node tools/portal-latency-probe.js --label before --mode cold --samples 10 --rid x_pizza --stats-day 2026-10-05 [--wait-min 20] [--out f.jsonl]
//   node tools/portal-latency-probe.js --label before --mode warm --samples 50 --rid x_pizza --stats-day 2026-10-05
//   node tools/portal-latency-probe.js --summarize f.jsonl --logs [--evidence f.attributed.json]   (≥ 5 min after the run)
//   node tools/portal-latency-probe.js --warm-guard before.attributed.json after.attributed.json
//
// THE PRIMARY INTERVAL (§5): from the start of an UNCACHED preflight to the completion of the successful response —
// Node's fetch keeps no preflight cache, so the probe sends the OPTIONS itself, exactly as a browser's first call would,
// and the interval therefore includes any instance startup. Preflight and request legs are recorded separately as
// COMPONENTS, never added on top of the primary interval.
//
// THE FIXED WORKLOAD (codex build r1 SF2). It is resolved ONCE per run — restaurant, an EXPLICIT settled stats day
// (required; never derived from the clock, so a run crossing midnight or a before/after pair on different days cannot
// silently change the query), destination base URL and each endpoint's exact path + query — and every sample records
// it with its `workloadId` (sha256 of the canonical workload; nothing secret is in it). A file holds ONE workload (an
// append with a different one is refused) and the warm guard REFUSES to compare different workloads.
//
// COLD ATTRIBUTION (codex build r1 SF1). Every leg (preflight, GET) carries its OWN client-generated trace id
// (`traceparent` + `X-Cloud-Trace-Context`, which Cloud Run records on its request log). `--summarize --logs` reads, READ-ONLY
// (`gcloud logging read`, project pinned to xpizza-delivery), each leg's request log by that trace → its revision and
// instance → THAT instance's "Starting new instance" log. A sample is:
//   cold       — both legs correlated, on the SAME instance, whose startup log lies inside the sample's own window;
//   warm       — both legs correlated and neither leg's instance started inside the window;
//   ambiguous  — legs on different instances where either started in the window, or a leg with several request logs;
//   uncorrelated — a leg with no request log / no instance id (e.g. logs not yet ingested).
// Only cold and warm samples enter statistics (each in its own mode); ambiguous and uncorrelated ones are EXCLUDED and
// counted, never guessed. A startup of some OTHER instance in the window is irrelevant by construction. Every request-log
// hit of a leg is validated and the leg is identified by its (revision, instance) PAIR: two pairs for one trace →
// ambiguous (codex build r2 #3).
//
// ELIGIBILITY (codex build r2 #4): a sample is a measurement only if its preflight SUCCEEDED as a browser requires
// (2xx + Access-Control-Allow-Origin == the portal origin) AND its GET answered 200; anything else is excluded and counted.
//
// THE EVIDENCE ARTIFACT (codex build r2 #1): `--summarize --logs` WRITES `<file>.attributed.json` (or --evidence): the
// workload, when the logs were read, and EVERY row — excluded ones included — with its eligibility and its attribution
// (class, reason, and per leg: trace, revision, instance, request time, startup time).
//
// WARM GUARD (§5; codex build r2 #2): it reads TWO evidence artifacts (never the raw sample files), counts ONLY eligible,
// attributed-WARM samples of warm runs, prints every exclusion per endpoint BEFORE enforcing ≥ 50 per endpoint, and PASSES
// iff p95_after ≤ p95_before + min(0.10 × p95_before, 50 ms) — over the SAME workload.
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROJECT = 'xpizza-delivery';
const REGION = 'us-central1';
const ORIGIN = 'https://sherpa-portal.netlify.app';
const ENDPOINTS = ['getMyRestaurants', 'getEditableCatalog', 'getSalesStats'];
const DAY_MS = 86400000;
const SKEW_MS = 2000;   // tolerated clock skew between this machine and Cloud Logging when placing a startup in a window

const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

// ── the workload: resolved once ─────────────────────────────────────────────────────────────────────────────────
function resolveWorkload({ rid, statsDay, base, nowMs }) {
  if (typeof rid !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(rid)) throw new Error('--rid <restaurant id> is required');
  const parsed = typeof statsDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(statsDay) ? Date.parse(`${statsDay}T00:00:00Z`) : NaN;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== statsDay) {   // round trip: 2026-02-30 is not a day
    throw new Error('--stats-day YYYY-MM-DD is required (an explicit, real, settled calendar day — never derived from the clock)');
  }
  // settled: the whole day ended ≥ 1 day ago in every timezone the platform serves (UTC-6 + a margin)
  if (Date.parse(`${statsDay}T00:00:00Z`) + 2 * DAY_MS > nowMs) throw new Error(`--stats-day ${statsDay} is not settled yet (pick a day at least 2 days ago)`);
  const dest = base || `https://${REGION}-${PROJECT}.cloudfunctions.net`;
  if (!/^https?:\/\/[^/?#]+$/.test(dest)) throw new Error('--base must be an origin (scheme://host[:port]) with no path');
  const r = encodeURIComponent(rid);
  const paths = {
    getMyRestaurants: '/getMyRestaurants',
    getEditableCatalog: `/getEditableCatalog?restaurantId=${r}`,
    getSalesStats: `/getSalesStats?restaurantId=${r}&from=${statsDay}&to=${statsDay}&compare=none`,
  };
  const w = { rid, statsDay, destination: dest, paths, origin: ORIGIN };
  return { ...w, workloadId: crypto.createHash('sha256').update(JSON.stringify(canon(w))).digest('hex').slice(0, 16) };
}

// ── one sample: two legs, each with its own trace id ───────────────────────────────────────────────────────────
const traceIds = () => ({ trace: crypto.randomBytes(16).toString('hex'), span: crypto.randomBytes(8).toString('hex') });
const traceHeaders = ({ trace, span }) => ({ traceparent: `00-${trace}-${span}-00`, 'X-Cloud-Trace-Context': `${trace}/${BigInt(`0x${span}`).toString()};o=0` });

async function sample(fn, workload, token, label, mode, round) {
  const url = `${workload.destination}${workload.paths[fn]}`;
  const pfT = traceIds(); const getT = traceIds();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const pf = await fetch(url, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization', ...traceHeaders(pfT) } });
  await pf.arrayBuffer();
  const t1 = performance.now();
  const r = await fetch(url, { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, ...traceHeaders(getT) } });
  await r.arrayBuffer();
  const t2 = performance.now();
  return {
    label, mode, round, fn, workloadId: workload.workloadId, rid: workload.rid, statsDay: workload.statsDay,
    destination: workload.destination, path: workload.paths[fn],
    startedAt, endedAt: new Date().toISOString(),
    preflightTrace: pfT.trace, getTrace: getT.trace,
    preflightStatus: pf.status, preflightAllowOrigin: pf.headers.get('access-control-allow-origin'), preflightMaxAge: pf.headers.get('access-control-max-age'), status: r.status,
    primaryMs: +(t2 - t0).toFixed(1), preflightMs: +(t1 - t0).toFixed(1), requestMs: +(t2 - t1).toFixed(1),
  };
}

// ── cold attribution (pure; the log fetch is separate) ──────────────────────────────────────────────────────────
// requestLogs: [{ trace, revision, instance, timestamp }]  (trace = the bare 32-hex id)
// startupLogs: [{ instance, revision, timestamp }]
function classifySample(row, requestLogs, startupLogs, { skewMs = SKEW_MS } = {}) {
  const leg = (trace) => {
    const hits = requestLogs.filter((l) => l.trace === trace);
    if (hits.length === 0) return { ok: false, reason: 'no_request_log' };
    if (hits.some((h) => !h.instance || !h.revision)) return { ok: false, reason: 'request_log_without_instance' };   // EVERY hit validated
    const pairs = [...new Set(hits.map((h) => `${h.revision}\u0000${h.instance}`))];
    if (pairs.length > 1) return { ok: false, ambiguous: true, reason: 'several_instances_for_one_trace', pairs: pairs.map((x) => x.split('\u0000')) };
    const h = hits[0];
    return { ok: true, trace, revision: h.revision, instance: h.instance, at: h.timestamp };
  };
  const pf = leg(row.preflightTrace); const get = leg(row.getTrace);
  const evidence = { preflight: pf, get };
  if (!pf.ok || !get.ok) {
    const amb = pf.ambiguous || get.ambiguous;
    return { cls: amb ? 'ambiguous' : 'uncorrelated', reason: amb ? 'several_instances_for_one_trace' : (!pf.ok ? `preflight_${pf.reason}` : `get_${get.reason}`), evidence };
  }
  const from = Date.parse(row.startedAt) - skewMs; const to = Date.parse(row.endedAt) + skewMs;
  const startedInWindow = (l) => {
    const s = startupLogs.filter((x) => x.instance === l.instance && x.revision === l.revision);
    const inWin = s.filter((x) => { const t = Date.parse(x.timestamp); return t >= from && t <= to; });
    return inWin.length ? inWin[0] : null;
  };
  const pfStart = startedInWindow(pf); const getStart = startedInWindow(get);
  evidence.preflight.startup = pfStart && pfStart.timestamp; evidence.get.startup = getStart && getStart.timestamp;
  if (pf.instance === get.instance && pf.revision === get.revision) {
    return pfStart ? { cls: 'cold', reason: 'instance_started_in_window', evidence } : { cls: 'warm', reason: 'no_startup_in_window', evidence };
  }
  if (pfStart || getStart) return { cls: 'ambiguous', reason: 'legs_on_different_instances_one_started', evidence };
  return { cls: 'warm', reason: 'no_startup_in_window', evidence };
}

// READ-ONLY log fetch. Request logs by the legs' own trace ids; startup logs by the instance ids those logs name.
function gcloudRead(filter) {
  const out = execFileSync('gcloud', ['logging', 'read', filter, `--project=${PROJECT}`, '--format=json', '--limit=5000'], { encoding: 'utf8' });
  return JSON.parse(out || '[]');
}
function fetchLogs(rows, read = gcloudRead) {
  const traces = rows.flatMap((r) => [r.preflightTrace, r.getTrace]);
  const from = new Date(Math.min(...rows.map((r) => Date.parse(r.startedAt))) - 60000).toISOString();
  const to = new Date(Math.max(...rows.map((r) => Date.parse(r.endedAt))) + 60000).toISOString();
  const requestLogs = [];
  for (let i = 0; i < traces.length; i += 20) {
    const chunk = traces.slice(i, i + 20).map((t) => `"projects/${PROJECT}/traces/${t}"`).join(' OR ');
    for (const e of read(`resource.type="cloud_run_revision" AND log_id("run.googleapis.com/requests") AND trace=(${chunk}) AND timestamp>="${from}" AND timestamp<="${to}"`)) {
      requestLogs.push({ trace: String(e.trace || '').split('/').pop(), revision: e.resource && e.resource.labels && e.resource.labels.revision_name, instance: e.labels && e.labels.instanceId, timestamp: e.timestamp });
    }
  }
  const instances = [...new Set(requestLogs.map((l) => l.instance).filter(Boolean))];
  const startupLogs = [];
  for (let i = 0; i < instances.length; i += 20) {
    const chunk = instances.slice(i, i + 20).map((x) => `"${x}"`).join(' OR ');
    for (const e of read(`resource.type="cloud_run_revision" AND textPayload:"Starting new instance" AND labels.instanceId=(${chunk}) AND timestamp>="${from}" AND timestamp<="${to}"`)) {
      startupLogs.push({ instance: e.labels && e.labels.instanceId, revision: e.resource && e.resource.labels && e.resource.labels.revision_name, timestamp: e.timestamp });
    }
  }
  return { requestLogs, startupLogs };
}

// ── eligibility: what a browser would have completed ──────────────────────────────────────────────────────────
function eligibility(row) {
  if (!(row.preflightStatus >= 200 && row.preflightStatus < 300)) return { eligible: false, reason: `preflight_status_${row.preflightStatus}` };
  if (row.preflightAllowOrigin !== ORIGIN) return { eligible: false, reason: 'preflight_origin_not_allowed' };
  if (row.status !== 200) return { eligible: false, reason: `get_status_${row.status}` };
  return { eligible: true };
}

// ── files ──────────────────────────────────────────────────────────────────────────────────────────────────────
function loadRows(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function singleWorkload(rows, file) {
  const ids = [...new Set(rows.map((r) => r.workloadId))];
  if (ids.length !== 1 || !ids[0]) throw new Error(`${file}: ${ids.length === 0 || !ids[0] ? 'rows carry no workloadId (pre-revision file?)' : `mixes ${ids.length} workloads (${ids.join(', ')})`} — refusing`);
  return ids[0];
}

function summarize(file, { logs = false, read = gcloudRead, nowMs = Date.now(), print = console.log, evidenceOut } = {}) {
  const rows = loadRows(file);
  const wid = singleWorkload(rows, file);
  for (const r of rows) r.eligibility = eligibility(r);
  const eligible = rows.filter((r) => r.eligibility.eligible);
  if (logs) {
    const last = Math.max(...rows.map((r) => Date.parse(r.endedAt)));
    if (nowMs - last < 5 * 60000) throw new Error('run --logs at least 5 minutes after the last sample (log ingestion delay); an un-ingested log would read as uncorrelated');
    const { requestLogs, startupLogs } = fetchLogs(rows, read);
    for (const r of rows) r.attribution = classifySample(r, requestLogs, startupLogs);   // EVERY row, excluded ones too
  }
  const groups = {}; const excluded = {};
  const exclude = (k) => { excluded[k] = (excluded[k] || 0) + 1; };
  for (const r of rows) {
    if (!r.eligibility.eligible) { exclude(`${r.mode} run → ineligible (${r.eligibility.reason})`); continue; }
    let bucket = r.mode;
    if (r.attribution) {
      if (r.attribution.cls !== r.mode) { exclude(`${r.mode} run → ${r.attribution.cls}`); continue; }   // only matching cold/warm count
    } else if (r.mode === 'cold') bucket = 'cold (UNATTRIBUTED: run with --logs; not evidence of a cold start)';
    (groups[`${r.label} ${bucket} ${r.fn}`] = groups[`${r.label} ${bucket} ${r.fn}`] || []).push(r);
  }
  print(`workload ${wid}: rid=${rows[0].rid} statsDay=${rows[0].statsDay} destination=${rows[0].destination}`);
  for (const [k, rs] of Object.entries(groups).sort()) {
    const p = rs.map((r) => r.primaryMs);
    print(`${k}: n=${rs.length} median ${quantile(p, 0.5)} ms p95 ${quantile(p, 0.95)} ms | preflight median ${quantile(rs.map((r) => r.preflightMs), 0.5)} ms, request median ${quantile(rs.map((r) => r.requestMs), 0.5)} ms`);
  }
  for (const [k, n] of Object.entries(excluded).sort()) print(`EXCLUDED ${k}: ${n}`);
  let evidencePath = null;
  if (logs) {
    evidencePath = evidenceOut || file.replace(/\.jsonl$/, '') + '.attributed.json';
    const artifact = { kind: 'portal-probe-evidence', version: 1, source: file, workloadId: wid, logsReadAt: new Date(nowMs).toISOString(),
      counts: { rows: rows.length, eligible: eligible.length, excluded }, rows };
    fs.writeFileSync(evidencePath, JSON.stringify(artifact, null, 1));
    print(`wrote evidence ${evidencePath} (${rows.length} rows, every one with its eligibility and attribution)`);
  }
  return { rows, groups, excluded, workloadId: wid, evidencePath };
}

function loadEvidence(file) {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* a raw .jsonl sample file is not one JSON document */ }
  if (!a || a.kind !== 'portal-probe-evidence' || !Array.isArray(a.rows)) throw new Error(`${file}: not a probe evidence artifact — run --summarize <samples.jsonl> --logs first (raw sample files are refused)`);
  for (const r of a.rows) if (!r.attribution || !r.eligibility) throw new Error(`${file}: a row carries no attribution/eligibility — refusing`);
  if (singleWorkload(a.rows, file) !== a.workloadId) throw new Error(`${file}: rows disagree with the artifact's workload`);
  return a;
}

// §5 WARM GUARD: per endpoint, PASS iff p95_after ≤ p95_before + min(0.10 × p95_before, 50 ms) (the stricter bound) —
// only over the SAME workload, and only over ELIGIBLE, attributed-WARM samples of warm runs (from the evidence artifacts).
function warmGuard(beforeFile, afterFile, print = console.log) {
  const B = loadEvidence(beforeFile); const A = loadEvidence(afterFile);
  if (B.workloadId !== A.workloadId) {
    const b = B.rows[0]; const a = A.rows[0];
    const d = (k) => `${k}: ${JSON.stringify(b[k])} vs ${JSON.stringify(a[k])}`;
    throw new Error(`REFUSED: before and after measured DIFFERENT workloads (${B.workloadId} vs ${A.workloadId}; ${['rid', 'statsDay', 'destination'].filter((k) => b[k] !== a[k]).map(d).join('; ') || 'paths differ'})`);
  }
  const split = (art, fn) => {
    const counted = []; const excl = {};
    for (const r of art.rows.filter((x) => x.fn === fn)) {
      const why = r.mode !== 'warm' ? `mode_${r.mode}` : !r.eligibility.eligible ? r.eligibility.reason : r.attribution.cls !== 'warm' ? `attributed_${r.attribution.cls}` : null;
      if (why) excl[why] = (excl[why] || 0) + 1; else counted.push(r.primaryMs);
    }
    return { counted, excl };
  };
  let fail = 0; const results = {};
  for (const fn of ENDPOINTS) {
    const sb = split(B, fn); const sa = split(A, fn);
    print(`${fn}: counted ${sb.counted.length} before / ${sa.counted.length} after; excluded before ${JSON.stringify(sb.excl)}, after ${JSON.stringify(sa.excl)}`);
    if (sb.counted.length < 50 || sa.counted.length < 50) { print(`${fn}: INSUFFICIENT attributed-warm samples (need ≥ 50 each)`); results[fn] = 'INSUFFICIENT'; fail++; continue; }
    const before = quantile(sb.counted, 0.95); const after = quantile(sa.counted, 0.95); const limit = before + Math.min(0.10 * before, 50);
    const pass = after <= limit; if (!pass) fail++;
    results[fn] = pass ? 'PASS' : 'FAIL';
    print(`${fn}: p95 before ${before} ms, after ${after} ms, limit ${limit.toFixed(1)} ms → ${results[fn]}`);
  }
  return { pass: fail === 0, results, workloadId: B.workloadId };
}

async function probe(argv, env = process.env, print = console.log) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
  const token = env.PORTAL_PROBE_ID_TOKEN;
  if (!token) throw new Error('set PORTAL_PROBE_ID_TOKEN (a portal owner ID token; it is never printed)');
  const label = arg('--label'); const mode = arg('--mode', 'warm');
  if (!label || !['cold', 'warm'].includes(mode)) throw new Error('need --label and --mode cold|warm');
  const workload = resolveWorkload({ rid: arg('--rid'), statsDay: arg('--stats-day'), base: arg('--base'), nowMs: Date.now() });   // ONCE
  const samples = Number(arg('--samples', mode === 'cold' ? 10 : 50));
  const waitMin = Number(arg('--wait-min', 20));
  const out = arg('--out', `portal-probe-${label}-${mode}.jsonl`);
  if (fs.existsSync(out)) singleWorkload([...loadRows(out), { workloadId: workload.workloadId }], out);   // never mix workloads in a file
  print(`workload ${workload.workloadId}: rid=${workload.rid} statsDay=${workload.statsDay} destination=${workload.destination}`);
  for (let round = 0; round < samples; round++) {
    if (mode === 'cold' && round > 0) { print(`waiting ${waitMin} min for scale-to-zero…`); await new Promise((r) => setTimeout(r, waitMin * 60000)); }
    for (const fn of ENDPOINTS) {
      const row = await sample(fn, workload, token, label, mode, round);
      fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
      print(`${mode} r${round} ${fn}: ${row.status} primary ${row.primaryMs} ms (preflight ${row.preflightMs}, request ${row.requestMs})`);
      const el = eligibility(row);
      if (!el.eligible) print(`  ⚠ ${fn}: ${el.reason} — not a measurement (excluded from statistics)`);
    }
  }
  print(`wrote ${out}`);
  return out;
}

module.exports = { resolveWorkload, classifySample, eligibility, fetchLogs, summarize, loadEvidence, warmGuard, probe, traceHeaders, SKEW_MS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
  (async () => {
    if (arg('--warm-guard')) { const r = warmGuard(arg('--warm-guard'), argv[argv.indexOf('--warm-guard') + 2]); process.exitCode = r.pass ? 0 : 1; return; }
    if (arg('--summarize')) { summarize(arg('--summarize'), { logs: argv.includes('--logs'), evidenceOut: arg('--evidence') }); return; }
    await probe(argv);
  })().catch((e) => { console.error(e && e.message); process.exitCode = 2; });
}
