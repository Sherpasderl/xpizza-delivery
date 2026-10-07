'use strict';
// PORTAL SPEED §5 probe — codex build r1 SF1/SF2 and r2 #1–#5. No network beyond 127.0.0.1: the module-level cases inject
// the log reader, and the CLI cases put a FAKE `gcloud` first on PATH (fixture-driven, asserting it is called read-only
// with the project pinned), so the tool itself carries no test hook.
// Run: node tools/portal-latency-probe.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const P = require('./portal-latency-probe');

let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 portal-latency-probe: exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = Date.parse('2026-10-07T18:00:00Z');
const ORIGIN = 'https://sherpa-portal.netlify.app';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
const silent = () => {};
const f = (name) => path.join(tmp, name);

// a fake `gcloud` (first on PATH): answers `logging read <filter>` from a fixture, refuses anything else
const BIN = f('bin'); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gcloud'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] !== 'logging' || a[1] !== 'read' || !a.includes('--project=xpizza-delivery')) { console.error('fake gcloud: refused ' + a.join(' ')); process.exit(3); }
if (process.env.NODE_OPTIONS !== undefined) { console.error('fake gcloud: refused an inherited NODE_OPTIONS (the child env must be hermetic)'); process.exit(4); }
require('fs').appendFileSync(process.env.FAKE_GCLOUD_CALLS, a[2] + '\\n');
const fx = JSON.parse(require('fs').readFileSync(process.env.FAKE_GCLOUD_FIXTURE, 'utf8'));
const filter = a[2];
const req = /log_id\\("run.googleapis.com\\/requests"\\)/.test(filter);
const out = (req ? fx.requests : fx.startups).filter((e) => req ? filter.includes('"' + e.trace + '"') : filter.includes('"' + e.labels.instanceId + '"'));
process.stdout.write(JSON.stringify(out));
`);
fs.chmodSync(path.join(BIN, 'gcloud'), 0o755);

// 🔴 the child env is HERMETIC: gate-all injects tools/count-marks.js into every node process via NODE_OPTIONS, and that
// preload appends a `##CELLS n` trailer to stdout. Inherited by the probe (and through it by the node-based fake gcloud) it
// corrupts the gcloud JSON the probe parses. NODE_OPTIONS is node's only env-borne preload, so it is removed last (after
// the per-call overrides) for every CLI child; the fake gcloud refuses to run if one still reaches it.
function childEnv(extra = {}) {
  const e = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...extra };
  delete e.NODE_OPTIONS;
  return e;
}
function cli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'portal-latency-probe.js'), ...args], { env: childEnv(env) });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('close', (code) => resolve({ code, o }));
  });
}

(async () => {
  // ── the workload (r1 SF2 + r2 #5) ──────────────────────────────────────────────────────────────────────────────
  {
    const w = P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW });
    assert.strictEqual(w.paths.getSalesStats, '/getSalesStats?restaurantId=x_pizza&from=2026-10-04&to=2026-10-04&compare=none');
    assert.strictEqual(w.destination, 'https://us-central1-xpizza-delivery.cloudfunctions.net');
    assert.match(w.workloadId, /^[0-9a-f]{16}$/);
    assert.strictEqual(P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW + 3 * 86400000 }).workloadId, w.workloadId, 'the id does not depend on WHEN it is resolved');
    for (const [k, v] of [['rid', 'la_musa'], ['statsDay', '2026-10-03'], ['base', 'https://other.example']]) {
      assert.notStrictEqual(P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW, [k]: v }).workloadId, w.workloadId, `${k} is part of the workload id`);
    }
    assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', nowMs: NOW }), /--stats-day YYYY-MM-DD is required/, 'no default day');
    assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-06', nowMs: NOW }), /not settled/, 'yesterday is not settled');
    for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-05', '2026-10-04T00:00']) {
      assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', statsDay: bad, nowMs: NOW }), /required/, `🔴 ${bad} is not a real calendar day (Date.parse normalizes it)`);
    }
    assert.strictEqual(P.resolveWorkload({ rid: 'x_pizza', statsDay: '2024-02-29', nowMs: NOW }).statsDay, '2024-02-29', 'a real leap day is accepted');
    assert.throws(() => P.resolveWorkload({ rid: undefined, statsDay: '2026-10-04', nowMs: NOW }), /--rid/);
    assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', base: 'https://h.example/path', nowMs: NOW }), /origin/);
    assert.ok(!JSON.stringify(w).match(/token|bearer|secret/i), 'nothing secret in the workload');
  }
  ok('workload: resolved once from rid + an EXPLICIT, REAL (round-tripped: 2026-02-30 / 04-31 / non-leap 02-29 refused), settled stats day + destination; its id changes with any of them and not with the time of resolution');

  // ── eligibility (r2 #4) ─────────────────────────────────────────────────────────────────────────────────────────
  {
    const base = { preflightStatus: 204, preflightAllowOrigin: ORIGIN, status: 200 };
    assert.deepStrictEqual(P.eligibility(base), { eligible: true });
    assert.deepStrictEqual(P.eligibility({ ...base, preflightStatus: 500 }), { eligible: false, reason: 'preflight_status_500' }, '🔴 OPTIONS 500 + GET 200 is not a measurement');
    assert.deepStrictEqual(P.eligibility({ ...base, preflightAllowOrigin: null }), { eligible: false, reason: 'preflight_origin_not_allowed' }, 'a preflight a browser would reject');
    assert.deepStrictEqual(P.eligibility({ ...base, preflightAllowOrigin: 'https://other.example' }), { eligible: false, reason: 'preflight_origin_not_allowed' });
    assert.deepStrictEqual(P.eligibility({ ...base, status: 403 }), { eligible: false, reason: 'get_status_403' });
    assert.deepStrictEqual(P.eligibility({ ...base, preflightStatus: 200 }), { eligible: true }, '2xx preflight');
  }
  ok('eligibility: a sample counts only if its preflight succeeded as a browser requires (2xx + Access-Control-Allow-Origin == the portal origin) AND its GET answered 200 — OPTIONS 500 + GET 200 is excluded');

  // ── the probe CLI against a local server ───────────────────────────────────────────────────────────────────────
  const seen = []; let failPreflightFor = null;
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, traceparent: req.headers.traceparent, xct: req.headers['x-cloud-trace-context'], auth: req.headers.authorization });
    if (req.method === 'OPTIONS') {
      if (failPreflightFor && req.url.startsWith(`/${failPreflightFor}`)) { res.writeHead(500); return res.end(); }
      res.writeHead(204, { 'access-control-allow-origin': req.headers.origin, 'access-control-max-age': '600' }); return res.end();
    }
    res.writeHead(200, { 'access-control-allow-origin': req.headers.origin }); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const TOKEN = 'tok-' + 'S'.repeat(40);
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  const out = f('warm.jsonl');
  failPreflightFor = 'getEditableCatalog';   // r2 #4: OPTIONS 500 followed by a 200 GET, on one endpoint
  const run = await cli(['--label', 'before', '--mode', 'warm', '--samples', '2', '--rid', 'x_pizza', '--stats-day', '2026-10-04', '--base', baseUrl, '--out', out], { PORTAL_PROBE_ID_TOKEN: TOKEN });
  failPreflightFor = null;
  assert.strictEqual(run.code, 0, run.o);
  const rows = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 6);
  assert.strictEqual(new Set(rows.map((r) => r.workloadId)).size, 1, 'every sample carries the ONE workload');
  for (const r of rows) for (const k of ['rid', 'statsDay', 'destination', 'path', 'preflightTrace', 'getTrace']) assert.ok(r[k], `row records ${k}`);
  assert.strictEqual(new Set(rows.flatMap((r) => [r.preflightTrace, r.getTrace])).size, 12, 'a distinct trace id per leg');
  for (const r of rows) {
    const pf = seen.find((s) => s.method === 'OPTIONS' && s.traceparent && s.traceparent.includes(r.preflightTrace));
    const get = seen.find((s) => s.method === 'GET' && s.traceparent && s.traceparent.includes(r.getTrace));
    assert.ok(pf && get, 'each leg was SENT with its recorded trace id');
    assert.ok(pf.xct.startsWith(`${r.preflightTrace}/`) && get.xct.startsWith(`${r.getTrace}/`), 'X-Cloud-Trace-Context carries the same id');
    assert.strictEqual(pf.auth, undefined); assert.strictEqual(get.auth, `Bearer ${TOKEN}`);
  }
  const failed = rows.filter((r) => r.fn === 'getEditableCatalog');
  assert.ok(failed.every((r) => r.preflightStatus === 500 && r.status === 200), 'fixture: OPTIONS 500 then GET 200 recorded as such');
  assert.ok(rows.filter((r) => r.fn !== 'getEditableCatalog').every((r) => r.preflightAllowOrigin === ORIGIN), 'the preflight ACAO is recorded');
  assert.ok(!run.o.includes(TOKEN.slice(4)) && !fs.readFileSync(out, 'utf8').includes(TOKEN.slice(4)), '🔴 the token appears in no output and no file');
  const mix = await cli(['--label', 'before', '--mode', 'warm', '--samples', '1', '--rid', 'x_pizza', '--stats-day', '2026-10-03', '--base', baseUrl, '--out', out], { PORTAL_PROBE_ID_TOKEN: TOKEN });
  assert.notStrictEqual(mix.code, 0); assert.match(mix.o, /mixes 2 workloads/);
  const noTok = await cli(['--label', 'x', '--mode', 'warm', '--rid', 'x_pizza', '--stats-day', '2026-10-04', '--base', baseUrl, '--out', f('n.jsonl')], { PORTAL_PROBE_ID_TOKEN: '' });
  assert.notStrictEqual(noTok.code, 0); assert.match(noTok.o, /PORTAL_PROBE_ID_TOKEN/);
  srv.close();
  ok('probe run: every sample records the one workload + a DISTINCT trace id per leg, actually sent; the preflight status AND its Allow-Origin are recorded (an OPTIONS 500 + GET 200 sample is recorded as such); credentials only on the GET; the token is in no output or file; mixing workloads in a file and a missing token are refused');

  // ── r2 #1: the CLI retains the evidence (through a fake gcloud) ────────────────────────────────────────────────
  {
    // age the samples past the ingestion guard, and give the fake log store one row per class
    const aged = rows.map((r) => ({ ...r, startedAt: new Date(Date.parse(r.startedAt) - 15 * 60000).toISOString(), endedAt: new Date(Date.parse(r.endedAt) - 15 * 60000).toISOString() }));
    fs.writeFileSync(out, aged.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const ms = aged.filter((r) => r.fn === 'getMyRestaurants');   // round 0 → cold, round 1 → warm
    const ss = aged.filter((r) => r.fn === 'getSalesStats');      // round 0 → ambiguous (pair conflict), round 1 → uncorrelated
    const rq = (trace, instance, revision, at) => ({ trace: `projects/xpizza-delivery/traces/${trace}`, resource: { labels: { revision_name: revision } }, labels: { instanceId: instance }, timestamp: at });
    const fixture = {
      requests: [
        rq(ms[0].preflightTrace, 'A', 'r1', ms[0].endedAt), rq(ms[0].getTrace, 'A', 'r1', ms[0].endedAt),
        rq(ms[1].preflightTrace, 'B', 'r1', ms[1].endedAt), rq(ms[1].getTrace, 'B', 'r1', ms[1].endedAt),
        rq(ss[0].preflightTrace, 'C', 'r1', ss[0].endedAt), rq(ss[0].preflightTrace, 'C', 'r2', ss[0].endedAt), rq(ss[0].getTrace, 'C', 'r1', ss[0].endedAt),
        rq(ss[1].preflightTrace, 'D', 'r1', ss[1].endedAt),   // the GET leg has no request log
        ...aged.filter((r) => r.fn === 'getEditableCatalog').flatMap((r) => [rq(r.preflightTrace, 'E', 'r1', r.endedAt), rq(r.getTrace, 'E', 'r1', r.endedAt)]),
      ],
      startups: [{ labels: { instanceId: 'A' }, resource: { labels: { revision_name: 'r1' } }, timestamp: ms[0].startedAt },
        { labels: { instanceId: 'C' }, resource: { labels: { revision_name: 'r1' } }, timestamp: ss[0].startedAt }],
    };
    fs.writeFileSync(f('fixture.json'), JSON.stringify(fixture));
    const calls = f('gcloud-calls.txt'); fs.writeFileSync(calls, '');
    const sum = await cli(['--summarize', out, '--logs'], { FAKE_GCLOUD_FIXTURE: f('fixture.json'), FAKE_GCLOUD_CALLS: calls });
    assert.strictEqual(sum.code, 0, sum.o);
    const evPath = out.replace(/\.jsonl$/, '') + '.attributed.json';
    assert.match(sum.o, new RegExp(`wrote evidence ${evPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    assert.strictEqual(ev.kind, 'portal-probe-evidence'); assert.strictEqual(ev.workloadId, rows[0].workloadId); assert.ok(ev.logsReadAt);
    assert.strictEqual(ev.rows.length, 6, '🔴 EVERY row is retained, excluded ones included');
    const byTrace = (t) => ev.rows.find((r) => r.getTrace === t);
    const cold = byTrace(ms[0].getTrace).attribution;
    assert.strictEqual(cold.cls, 'cold');
    assert.deepStrictEqual([cold.evidence.preflight.trace, cold.evidence.preflight.revision, cold.evidence.preflight.instance, cold.evidence.get.instance, cold.evidence.get.startup],
      [ms[0].preflightTrace, 'r1', 'A', 'A', ms[0].startedAt], 'the matched trace / revision / instance / startup are retained');
    assert.strictEqual(byTrace(ms[1].getTrace).attribution.cls, 'warm');
    assert.strictEqual(byTrace(ss[0].getTrace).attribution.cls, 'ambiguous'); assert.deepStrictEqual(byTrace(ss[0].getTrace).attribution.evidence.preflight.pairs, [['r1', 'C'], ['r2', 'C']]);
    assert.strictEqual(byTrace(ss[1].getTrace).attribution.cls, 'uncorrelated');
    for (const r of ev.rows.filter((x) => x.fn === 'getEditableCatalog')) assert.deepStrictEqual(r.eligibility, { eligible: false, reason: 'preflight_status_500' }, 'the excluded OPTIONS-500 rows are retained with their reason');
    assert.ok(!fs.readFileSync(evPath, 'utf8').includes(TOKEN.slice(4)), 'no token in the evidence');
    const filters = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    assert.ok(filters.length >= 2 && filters.every((x) => /resource\.type="cloud_run_revision"/.test(x)), 'every log read is a scoped, read-only `gcloud logging read` with the project pinned (the fake refuses anything else)');
    assert.match(sum.o, /EXCLUDED warm run → ineligible \(preflight_status_500\): 2/);
    // --evidence names the artifact explicitly
    const sum2 = await cli(['--summarize', out, '--logs', '--evidence', f('named.json')], { FAKE_GCLOUD_FIXTURE: f('fixture.json'), FAKE_GCLOUD_CALLS: calls });
    assert.strictEqual(sum2.code, 0, sum2.o); assert.strictEqual(JSON.parse(fs.readFileSync(f('named.json'), 'utf8')).rows.length, 6);
    // the guard over CLI artifacts: refuses raw files; over the artifact it prints exclusions, then INSUFFICIENT
    const raw = await cli(['--warm-guard', out, evPath]);
    assert.notStrictEqual(raw.code, 0); assert.match(raw.o, /not a probe evidence artifact/);
    const g = await cli(['--warm-guard', evPath, f('named.json')]);
    assert.strictEqual(g.code, 1, g.o);
    const iEx = g.o.indexOf('getEditableCatalog: counted 0 before / 0 after; excluded before {"preflight_status_500":2}');
    assert.ok(iEx > -1 && iEx < g.o.indexOf('getEditableCatalog: INSUFFICIENT'), 'exclusions are reported BEFORE the minimum is enforced');
    assert.match(g.o, /getSalesStats: counted 0 before \/ 0 after; excluded before \{"attributed_ambiguous":1,"attributed_uncorrelated":1\}/);
    assert.match(g.o, /getMyRestaurants: counted 1 before \/ 1 after; excluded before \{"attributed_cold":1\}/);
  }
  ok('CLI evidence retention (fake gcloud on PATH, read-only + project-pinned): `--summarize --logs` WRITES <file>.attributed.json (or --evidence) holding EVERY row — cold, warm, ambiguous (with both conflicting pairs), uncorrelated and the OPTIONS-500 exclusions — each with eligibility, class, reason and per-leg trace/revision/instance/startup; the CLI warm guard refuses the raw file and, over the artifacts, prints every exclusion per endpoint before INSUFFICIENT');

  // ── the gate's count-marks preload in the PARENT must not reach the CLI children (advisor gate RED at 1a44ccd) ──
  {
    const preload = path.join(__dirname, 'count-marks.js');
    // non-vacuity: the preload really does append its trailer to a node child's stdout (what broke the gcloud JSON)
    const leak = spawnSync(process.execPath, ['-e', 'process.stdout.write("{}")'], { env: { ...process.env, NODE_OPTIONS: `--require "${preload}"` }, encoding: 'utf8' });
    assert.strictEqual(leak.status, 0, leak.stderr); assert.match(leak.stdout, /^\{\}##CELLS \d+\n$/, 'the preload pollutes a child that inherits it');
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${prev ? `${prev} ` : ''}--require "${preload}"`;
    try {
      const calls = f('gcloud-calls-preload.txt'); fs.writeFileSync(calls, '');
      const r = await cli(['--summarize', out, '--logs', '--evidence', f('preload.json')], { FAKE_GCLOUD_FIXTURE: f('fixture.json'), FAKE_GCLOUD_CALLS: calls });
      assert.strictEqual(r.code, 0, `🔴 the CLI path must pass with the gate's NODE_OPTIONS set in the parent:\n${r.o}`);
      assert.ok(!/##CELLS/.test(r.o), 'the probe child itself ran without the preload');
      assert.ok(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length >= 2, 'the fake gcloud was really reached (and it refuses an inherited NODE_OPTIONS)');
      assert.strictEqual(JSON.parse(fs.readFileSync(f('preload.json'), 'utf8')).rows.length, 6);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
    }
  }
  ok('hermetic CLI children: with the gate\'s count-marks NODE_OPTIONS set in the parent (a preload proven to append ##CELLS to an inheriting child), `--summarize --logs` through the fake gcloud still exits 0 with all 6 rows — neither the probe nor the fake gcloud inherits it');

  // ── r2 #2: the warm guard counts only eligible, attributed-WARM samples ─────────────────────────────────────────
  const artifact = (file, { rid = 'x_pizza', statsDay = '2026-10-04', base: b, slow = 0, cls = 'warm', preflightStatus = 204, mode = 'warm', extraRows = [] } = {}) => {
    const w = P.resolveWorkload({ rid, statsDay, base: b, nowMs: NOW });
    const R = [];
    for (let i = 0; i < 50; i++) for (const fn of ['getMyRestaurants', 'getEditableCatalog', 'getSalesStats']) {
      const r = { label: 'x', mode, fn, workloadId: w.workloadId, rid: w.rid, statsDay: w.statsDay, destination: w.destination, path: w.paths[fn],
        preflightStatus, preflightAllowOrigin: ORIGIN, status: 200, primaryMs: 100 + i + (fn === 'getSalesStats' ? slow : 0), preflightMs: 1, requestMs: 1 };
      r.eligibility = P.eligibility(r); r.attribution = { cls, reason: 'fixture', evidence: {} };
      R.push(r);
    }
    fs.writeFileSync(file, JSON.stringify({ kind: 'portal-probe-evidence', version: 1, workloadId: w.workloadId, rows: [...R, ...extraRows] }));
  };
  artifact(f('b.json')); artifact(f('a.json'));
  assert.strictEqual(P.warmGuard(f('b.json'), f('a.json'), silent).pass, true, 'same workload, attributed-warm, same latency → PASS');
  artifact(f('a-slow.json'), { slow: 60 });
  const slow = P.warmGuard(f('b.json'), f('a-slow.json'), silent);
  assert.strictEqual(slow.pass, false); assert.strictEqual(slow.results.getSalesStats, 'FAIL'); assert.strictEqual(slow.results.getMyRestaurants, 'PASS');
  // 🔴 codex r2 repros: 50 UNCORRELATED per endpoint per file, OPTIONS 500 + GET 200, cold- or ambiguous-attributed → never a PASS
  for (const [label, opts] of [['uncorrelated', { cls: 'uncorrelated' }], ['ambiguous', { cls: 'ambiguous' }], ['cold', { cls: 'cold' }], ['OPTIONS 500 + GET 200', { preflightStatus: 500 }], ['a cold-mode run', { mode: 'cold' }]]) {
    artifact(f('x-b.json'), opts); artifact(f('x-a.json'), opts);
    const lines = []; const r = P.warmGuard(f('x-b.json'), f('x-a.json'), (l) => lines.push(l));
    assert.strictEqual(r.pass, false, `🔴 ${label} samples must not PASS the warm guard`);
    assert.deepStrictEqual(Object.values(r.results), ['INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT'], `${label}: nothing is counted`);
    assert.ok(lines[0].includes('counted 0 before / 0 after; excluded before {"'), `${label}: the exclusion is reported first (${lines[0]})`);
  }
  for (const [name, o, re] of [['rid', { rid: 'la_musa' }, /rid: "x_pizza" vs "la_musa"/], ['statsDay', { statsDay: '2026-10-03' }, /statsDay: "2026-10-04" vs "2026-10-03"/], ['destination', { base: 'https://other.example' }, /destination/]]) {
    artifact(f(`a-${name}.json`), o);
    assert.throws(() => P.warmGuard(f('b.json'), f(`a-${name}.json`), silent), re, `🔴 a ${name} mismatch must be REFUSED`);
  }
  artifact(f('a-mixed.json'), { extraRows: [{ mode: 'warm', fn: 'getSalesStats', workloadId: 'ffffffffffffffff', eligibility: { eligible: true }, attribution: { cls: 'warm' }, primaryMs: 1 }] });
  assert.throws(() => P.warmGuard(f('b.json'), f('a-mixed.json'), silent), /mixes 2 workloads/);
  artifact(f('a-noattr.json'), { extraRows: [{ mode: 'warm', fn: 'getSalesStats', workloadId: 'x', eligibility: { eligible: true }, primaryMs: 1 }] });
  assert.throws(() => P.warmGuard(f('b.json'), f('a-noattr.json'), silent), /no attribution/);
  assert.throws(() => P.warmGuard(out, f('a.json'), silent), /not a probe evidence artifact/, 'a raw sample file is refused');
  fs.writeFileSync(f('old.jsonl'), JSON.stringify({ mode: 'warm', fn: 'getSalesStats', preflightStatus: 204, preflightAllowOrigin: ORIGIN, status: 200, primaryMs: 1, startedAt: 'x', endedAt: 'y' }));
  assert.throws(() => P.summarize(f('old.jsonl'), { print: silent }), /no workloadId/, 'a pre-revision sample file (no workload recorded) is refused, not trusted');
  ok('warm guard: reads only evidence artifacts; counts ONLY eligible, attributed-WARM samples of warm runs — 50 uncorrelated / ambiguous / cold-attributed / OPTIONS-500 / cold-mode samples per endpoint per file are each INSUFFICIENT, never PASS, with the exclusions printed first; the stricter bound as before; mismatched workloads, mixed files, unattributed rows and raw files are REFUSED');

  // ── cold attribution (r1 SF1 + r2 #3) ──────────────────────────────────────────────────────────────────────────
  {
    const row = { preflightTrace: 'p1', getTrace: 'g1', startedAt: '2026-10-07T12:00:00.000Z', endedAt: '2026-10-07T12:00:04.000Z' };
    const rq = (trace, instance, revision = 'getsalesstats-00007-abc') => ({ trace, instance, revision, timestamp: '2026-10-07T12:00:03Z' });
    const st = (instance, ts, revision = 'getsalesstats-00007-abc') => ({ instance, revision, timestamp: ts });
    let c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', '2026-10-07T12:00:00.500Z')]);
    assert.strictEqual(c.cls, 'cold'); assert.strictEqual(c.evidence.get.startup, '2026-10-07T12:00:00.500Z');
    // r1 repro: an UNRELATED concurrent startup → NOT cold
    c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('Z', '2026-10-07T12:00:01Z'), st('A2', '2026-10-07T12:00:01Z', 'rev-new')]);
    assert.strictEqual(c.cls, 'warm');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', '2026-10-07T12:00:01Z', 'rev-new')]).cls, 'warm', 'an instance is (revision, instance id)');
    // 🔴 r2 #3 repro: preflight trace with (r1,A) AND (r2,A), GET (r1,A), (r1,A) started in the window → NOT cold
    c = P.classifySample(row, [rq('p1', 'A', 'r1'), rq('p1', 'A', 'r2'), rq('g1', 'A', 'r1')], [st('A', '2026-10-07T12:00:01Z', 'r1')]);
    assert.notStrictEqual(c.cls, 'cold', '🔴 conflicting revisions in one trace must not produce cold');
    assert.strictEqual(c.cls, 'ambiguous'); assert.deepStrictEqual(c.evidence.preflight.pairs, [['r1', 'A'], ['r2', 'A']]);
    // the same conflict on the GET leg, and a hit order that puts the conflicting pair first
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A', 'r1'), rq('g1', 'A', 'r2'), rq('g1', 'A', 'r1')], [st('A', '2026-10-07T12:00:01Z', 'r1')]).cls, 'ambiguous');
    // EVERY hit validated: a valid hit + an id-less hit for one leg → uncorrelated (not the first hit's verdict)
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A'), { trace: 'g1', revision: 'getsalesstats-00007-abc', instance: undefined, timestamp: 'x' }], [st('A', '2026-10-07T12:00:01Z')]).reason, 'get_request_log_without_instance');
    // duplicate hits of the SAME pair are fine
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('p1', 'A'), rq('g1', 'A')], [st('A', '2026-10-07T12:00:01Z')]).cls, 'cold');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A', 'rev-old'), rq('g1', 'A', 'rev-new')], [st('A', '2026-10-07T12:00:01Z', 'rev-new')]).cls, 'ambiguous', 'legs: same id, different revisions');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', '2026-10-07T11:40:00Z')]).cls, 'warm', 'pre-warmed');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'B')], [st('B', '2026-10-07T12:00:02Z')]).cls, 'ambiguous', 'different instances, one started');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'B')], [st('A', '2026-10-07T12:00:00.2Z')]).cls, 'ambiguous');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'B')], []).cls, 'warm');
    assert.deepStrictEqual([P.classifySample(row, [rq('g1', 'A')], [st('A', '2026-10-07T12:00:01Z')]).cls, P.classifySample(row, [rq('g1', 'A')], []).reason], ['uncorrelated', 'preflight_no_request_log']);
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A')], []).reason, 'get_no_request_log');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A'), rq('g1', 'B')], []).cls, 'ambiguous', 'one trace on two instances');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', new Date(Date.parse(row.endedAt) + P.SKEW_MS + 1).toISOString())]).cls, 'warm', 'outside the skew');
  }
  ok('cold attribution: cold ONLY when every request-log hit of both legs validates and names ONE (revision, instance) pair, the same for both legs, whose startup is inside the window — the codex r2 repro ((r1,A)+(r2,A) on the preflight trace, (r1,A) started) is ambiguous with both pairs kept, in either hit order and on either leg; an id-less hit among valid ones → uncorrelated; duplicate hits of one pair are fine; the r1 cases (unrelated startup, other revision, pre-warmed, cross-instance, missing logs, skew) hold');

  // ── summarize composition (module level, injected reader) ──────────────────────────────────────────────────────
  {
    const file = f('cold.jsonl');
    const w = P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW });
    const mk = (i, want, extra = {}) => ({ label: 'after', mode: 'cold', round: i, fn: 'getSalesStats', workloadId: w.workloadId, rid: 'x_pizza', statsDay: '2026-10-04', destination: w.destination, path: w.paths.getSalesStats,
      startedAt: `2026-10-07T12:0${i}:00.000Z`, endedAt: `2026-10-07T12:0${i}:03.000Z`, preflightTrace: `p${i}`, getTrace: `g${i}`, preflightStatus: 204, preflightAllowOrigin: ORIGIN, status: 200,
      primaryMs: want === 'cold' ? 2000 : 150, preflightMs: 1, requestMs: 1, _want: want, ...extra });
    const rows2 = [mk(1, 'cold'), mk(2, 'warm'), mk(3, 'ambiguous'), mk(4, 'uncorrelated'), mk(5, 'cold', { preflightStatus: 500 })];
    fs.writeFileSync(file, rows2.map((r) => JSON.stringify(r)).join('\n'));
    const read = (filter) => {
      if (/log_id\("run.googleapis.com\/requests"\)/.test(filter)) {
        const L = [];
        for (const r of rows2) {
          if (r._want === 'uncorrelated') continue;
          const inst = `i${r.round}`;
          L.push({ trace: `projects/xpizza-delivery/traces/${r.preflightTrace}`, resource: { labels: { revision_name: 'rev1' } }, labels: { instanceId: inst }, timestamp: r.endedAt });
          L.push({ trace: `projects/xpizza-delivery/traces/${r.getTrace}`, resource: { labels: { revision_name: 'rev1' } }, labels: { instanceId: r._want === 'ambiguous' ? `${inst}b` : inst }, timestamp: r.endedAt });
        }
        return L.filter((e) => filter.includes(e.trace));
      }
      const S = [['i1', '2026-10-07T12:01:01Z'], ['i3b', '2026-10-07T12:03:01Z'], ['i5', '2026-10-07T12:05:01Z'], ['unrelated', '2026-10-07T12:02:01Z']]
        .map(([id, t]) => ({ labels: { instanceId: id }, resource: { labels: { revision_name: 'rev1' } }, timestamp: t }));
      return S.filter((e) => filter.includes(`"${e.labels.instanceId}"`));
    };
    const s = P.summarize(file, { logs: true, read, nowMs: Date.parse('2026-10-07T12:30:00Z'), print: silent, evidenceOut: f('cold.attributed.json') });
    assert.deepStrictEqual(s.rows.map((r) => r.attribution.cls), ['cold', 'warm', 'ambiguous', 'uncorrelated', 'cold']);
    assert.strictEqual(s.groups['after cold getSalesStats'].length, 1, 'ONLY the eligible, attributed cold sample enters the cold statistics');
    assert.deepStrictEqual(s.excluded, { 'cold run → ambiguous': 1, 'cold run → uncorrelated': 1, 'cold run → warm': 1, 'cold run → ineligible (preflight_status_500)': 1 },
      'the OPTIONS-500 sample is excluded even though it is attributed cold');
    assert.strictEqual(JSON.parse(fs.readFileSync(f('cold.attributed.json'), 'utf8')).rows.length, 5);
    assert.throws(() => P.summarize(file, { logs: true, read, nowMs: Date.parse('2026-10-07T12:07:00Z'), print: silent }), /at least 5 minutes/);
    const u = P.summarize(file, { logs: false, print: silent });
    assert.deepStrictEqual(Object.keys(u.groups), ['after cold (UNATTRIBUTED: run with --logs; not evidence of a cold start) getSalesStats']);
    assert.strictEqual(u.evidencePath, null, 'no artifact without --logs');
  }
  ok('summarize: of 5 cold-run samples only the eligible attributed-cold one counts — warm / ambiguous / uncorrelated and an attributed-cold OPTIONS-500 sample are excluded and counted; reads < 5 min after the run are refused; without --logs cold samples are UNATTRIBUTED and no artifact is written');

  fs.rmSync(tmp, { recursive: true, force: true });
  __finished = true;
  console.log(`\nportal-latency-probe: OK (${n})`);
})().catch((e) => { console.error('portal-latency-probe FAILED:', e && e.stack || e); process.exit(1); });
