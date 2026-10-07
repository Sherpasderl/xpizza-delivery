#!/usr/bin/env node
'use strict';
// PORTAL SPEED (PLAN-portal-speed rev 3 §5) — the OWNER-RUN latency probe, before and after the Phase 1 deploy.
// READ endpoints only (getMyRestaurants, getEditableCatalog, getSalesStats): this probe never writes anything.
//
//   PORTAL_PROBE_ID_TOKEN=<a portal owner's Firebase ID token>   (read from the env; NEVER printed or written)
//   node tools/portal-latency-probe.js --label before --mode cold --samples 10 --rid x_pizza [--wait-min 20] [--out probe.jsonl]
//   node tools/portal-latency-probe.js --label before --mode warm --samples 50 --rid x_pizza
//   node tools/portal-latency-probe.js --summarize probe.jsonl [--logs]
//   node tools/portal-latency-probe.js --warm-guard before-warm.jsonl after-warm.jsonl
//
// THE PRIMARY INTERVAL (§5): from the start of an UNCACHED preflight to the completion of the successful response —
// Node's fetch keeps no preflight cache, so the probe sends the OPTIONS itself, exactly as a browser's first call
// would, and the interval therefore includes any instance startup. Preflight and request legs are recorded
// separately as components, never added on top of the primary interval.
//
// COLD SAMPLES: --mode cold waits --wait-min minutes between rounds so instances can scale to zero, then calls each
// endpoint once. A sample COUNTS as cold only when it is correlated with a "Starting new instance" log for the same
// service in its time window — `--summarize … --logs` runs a READ-ONLY `gcloud logging read` (project pinned to
// xpizza-delivery) and tags each sample cold/warm with the revision + instance id; untagged samples are excluded from
// the cold statistics, never guessed. Elapsed time alone is not evidence of a cold start.
//
// WARM GUARD (§5): ≥ 50 warm samples per endpoint; PASS iff p95_after ≤ p95_before + min(0.10 × p95_before, 50 ms).
const fs = require('fs');
const { execFileSync } = require('child_process');

const PROJECT = 'xpizza-delivery';
const REGION = 'us-central1';
const ORIGIN = 'https://sherpa-portal.netlify.app';
const ENDPOINTS = ['getMyRestaurants', 'getEditableCatalog', 'getSalesStats'];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(k);

const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };

function urlFor(fn, rid) {
  const base = arg('--base', `https://${REGION}-${PROJECT}.cloudfunctions.net`);
  if (fn === 'getMyRestaurants') return `${base}/${fn}`;
  if (fn === 'getEditableCatalog') return `${base}/${fn}?restaurantId=${encodeURIComponent(rid)}`;
  const d = arg('--stats-day', null) || new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);   // a FIXED settled day per run
  return `${base}/${fn}?restaurantId=${encodeURIComponent(rid)}&from=${d}&to=${d}&compare=none`;
}

async function sample(fn, rid, token, label, mode, round) {
  const url = urlFor(fn, rid);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const pf = await fetch(url, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  await pf.arrayBuffer();
  const t1 = performance.now();
  const r = await fetch(url, { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } });
  await r.arrayBuffer();
  const t2 = performance.now();
  return {
    label, mode, round, fn, startedAt, endedAt: new Date().toISOString(),
    preflightStatus: pf.status, preflightMaxAge: pf.headers.get('access-control-max-age'), status: r.status,
    primaryMs: +(t2 - t0).toFixed(1), preflightMs: +(t1 - t0).toFixed(1), requestMs: +(t2 - t1).toFixed(1),
    trace: r.headers.get('x-cloud-trace-context'),
  };
}

function coldTags(rows) {
  // READ-ONLY: Cloud Run "Starting new instance" logs for the portal services in the probe's window.
  const from = rows.map((r) => r.startedAt).sort()[0];
  const to = rows.map((r) => r.endedAt).sort().slice(-1)[0];
  const services = [...new Set(rows.map((r) => r.fn.toLowerCase()))];
  const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name=(${services.map((s) => `"${s}"`).join(' OR ')}) AND textPayload:"Starting new instance" AND timestamp>="${from}" AND timestamp<="${to}"`;
  const out = execFileSync('gcloud', ['logging', 'read', filter, `--project=${PROJECT}`, '--format=json', '--limit=1000'], { encoding: 'utf8' });
  return JSON.parse(out || '[]').map((e) => ({ service: e.resource.labels.service_name, revision: e.resource.labels.revision_name, instance: e.labels && e.labels.instanceId, at: e.timestamp }));
}

async function probe() {
  const token = process.env.PORTAL_PROBE_ID_TOKEN;
  if (!token) { console.error('set PORTAL_PROBE_ID_TOKEN (a portal owner ID token; it is never printed)'); process.exit(2); }
  const rid = arg('--rid'); const label = arg('--label'); const mode = arg('--mode', 'warm');
  const samples = Number(arg('--samples', mode === 'cold' ? 10 : 50));
  const waitMin = Number(arg('--wait-min', 20));
  const out = arg('--out', `portal-probe-${label}-${mode}.jsonl`);
  if (!rid || !label || !['cold', 'warm'].includes(mode)) { console.error('need --rid, --label, --mode cold|warm'); process.exit(2); }
  for (let round = 0; round < samples; round++) {
    if (mode === 'cold' && round > 0) { console.log(`waiting ${waitMin} min for scale-to-zero…`); await new Promise((r) => setTimeout(r, waitMin * 60000)); }
    for (const fn of ENDPOINTS) {
      const row = await sample(fn, rid, token, label, mode, round);
      fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(`${mode} r${round} ${fn}: ${row.status} primary ${row.primaryMs} ms (preflight ${row.preflightMs}, request ${row.requestMs})`);
      if (row.status !== 200) console.warn(`  ⚠ ${fn} answered ${row.status} — excluded from statistics (only successful requests count)`);
    }
  }
  console.log(`wrote ${out}`);
}

function summarize(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200);
  if (flag('--logs')) {
    const starts = coldTags(rows);
    for (const r of rows) {
      const hit = starts.find((s) => s.service === r.fn.toLowerCase() && s.at >= new Date(Date.parse(r.startedAt) - 5000).toISOString() && s.at <= r.endedAt);
      r.observedCold = !!hit; if (hit) { r.revision = hit.revision; r.instance = hit.instance; }
    }
  }
  const groups = {};
  for (const r of rows) {
    const k = `${r.label} ${r.mode}${r.mode === 'cold' ? (r.observedCold === undefined ? ' (UNTAGGED: run with --logs)' : r.observedCold ? ' (observed cold)' : ' (NOT cold: excluded)') : ''} ${r.fn}`;
    (groups[k] = groups[k] || []).push(r);
  }
  for (const [k, rs] of Object.entries(groups).sort()) {
    const p = rs.map((r) => r.primaryMs);
    console.log(`${k}: n=${rs.length} median ${quantile(p, 0.5)} ms p95 ${quantile(p, 0.95)} ms | preflight median ${quantile(rs.map((r) => r.preflightMs), 0.5)} ms, request median ${quantile(rs.map((r) => r.requestMs), 0.5)} ms`);
  }
}

// §5 WARM GUARD: per endpoint, PASS iff p95_after ≤ p95_before + min(0.10 × p95_before, 50 ms) (the stricter bound).
function warmGuard(beforeFile, afterFile) {
  const load = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200 && r.mode === 'warm');
  const b = load(beforeFile); const a = load(afterFile); let fail = 0;
  for (const fn of ENDPOINTS) {
    const pb = b.filter((r) => r.fn === fn).map((r) => r.primaryMs); const pa = a.filter((r) => r.fn === fn).map((r) => r.primaryMs);
    if (pb.length < 50 || pa.length < 50) { console.log(`${fn}: INSUFFICIENT (${pb.length} before, ${pa.length} after; need ≥ 50 each)`); fail++; continue; }
    const before = quantile(pb, 0.95); const after = quantile(pa, 0.95); const limit = before + Math.min(0.10 * before, 50);
    const pass = after <= limit; if (!pass) fail++;
    console.log(`${fn}: p95 before ${before} ms, after ${after} ms, limit ${limit.toFixed(1)} ms → ${pass ? 'PASS' : 'FAIL'}`);
  }
  process.exitCode = fail ? 1 : 0;
}

const sumFile = arg('--summarize');
const guard = arg('--warm-guard');
(guard ? Promise.resolve(warmGuard(guard, process.argv[process.argv.indexOf('--warm-guard') + 2])) : sumFile ? Promise.resolve(summarize(sumFile)) : probe()).catch((e) => { console.error(e && e.message); process.exit(1); });
