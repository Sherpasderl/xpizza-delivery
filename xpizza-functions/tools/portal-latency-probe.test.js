'use strict';
// PORTAL SPEED §5 probe — codex build r1 SF1 (cold attribution) + SF2 (fixed workload). No network beyond 127.0.0.1;
// the gcloud log reader is injected, so every case is deterministic.
// Run: node tools/portal-latency-probe.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const P = require('./portal-latency-probe');

let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 portal-latency-probe: exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = Date.parse('2026-10-07T18:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
const silent = () => {};

(async () => {
  // ── SF2: the workload ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const w = P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW });
    assert.strictEqual(w.paths.getSalesStats, '/getSalesStats?restaurantId=x_pizza&from=2026-10-04&to=2026-10-04&compare=none');
    assert.strictEqual(w.destination, 'https://us-central1-xpizza-delivery.cloudfunctions.net');
    assert.match(w.workloadId, /^[0-9a-f]{16}$/);
    assert.strictEqual(P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW + 3 * 86400000 }).workloadId, w.workloadId, 'the id does not depend on WHEN it is resolved (no clock in the workload)');
    for (const [k, v] of [['rid', 'la_musa'], ['statsDay', '2026-10-03'], ['base', 'https://other.example']]) {
      assert.notStrictEqual(P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW, [k]: v }).workloadId, w.workloadId, `${k} is part of the workload id`);
    }
    assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', nowMs: NOW }), /--stats-day YYYY-MM-DD is required/, 'no default day: it must be explicit');
    assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-06', nowMs: NOW }), /not settled/, 'yesterday is not settled');
    assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-13-40', nowMs: NOW }), /required/);
    assert.throws(() => P.resolveWorkload({ rid: undefined, statsDay: '2026-10-04', nowMs: NOW }), /--rid/);
    assert.throws(() => P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', base: 'https://h.example/path', nowMs: NOW }), /origin/);
    assert.ok(!JSON.stringify(w).match(/token|bearer|secret/i), 'nothing secret in the workload');
  }
  ok('workload: resolved once from rid + an EXPLICIT settled stats day + destination (no clock-derived default; yesterday/malformed/missing refused); its id changes with any of them and not with the time of resolution');

  // the CLI against a local server: one workload for every sample, a trace id per LEG, the token never written
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, traceparent: req.headers.traceparent, xct: req.headers['x-cloud-trace-context'], auth: req.headers.authorization });
    res.writeHead(req.method === 'OPTIONS' ? 204 : 200, { 'access-control-max-age': '600' }); res.end(req.method === 'OPTIONS' ? '' : '{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const TOKEN = 'tok-' + 'S'.repeat(40);
  const out = path.join(tmp, 'warm.jsonl');
  const cli = (args, env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'portal-latency-probe.js'), ...args], { env: { ...process.env, ...env } });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('close', (code) => resolve({ code, o }));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const run = await cli(['--label', 'before', '--mode', 'warm', '--samples', '2', '--rid', 'x_pizza', '--stats-day', '2026-10-04', '--base', base, '--out', out], { PORTAL_PROBE_ID_TOKEN: TOKEN });
  srv.close();
  assert.strictEqual(run.code, 0, run.o);
  const rows = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 6);
  assert.strictEqual(new Set(rows.map((r) => r.workloadId)).size, 1, 'every sample carries the ONE workload');
  assert.deepStrictEqual([...new Set(rows.filter((r) => r.fn === 'getSalesStats').map((r) => r.path))], ['/getSalesStats?restaurantId=x_pizza&from=2026-10-04&to=2026-10-04&compare=none']);
  for (const r of rows) for (const k of ['rid', 'statsDay', 'destination', 'path', 'preflightTrace', 'getTrace']) assert.ok(r[k], `row records ${k}`);
  assert.strictEqual(new Set(rows.flatMap((r) => [r.preflightTrace, r.getTrace])).size, 12, 'a distinct trace id per leg');
  for (const r of rows) {
    const pf = seen.find((s) => s.method === 'OPTIONS' && s.traceparent && s.traceparent.includes(r.preflightTrace));
    const get = seen.find((s) => s.method === 'GET' && s.traceparent && s.traceparent.includes(r.getTrace));
    assert.ok(pf && get, 'each leg was SENT with its recorded trace id');
    assert.ok(pf.xct.startsWith(`${r.preflightTrace}/`) && get.xct.startsWith(`${r.getTrace}/`), 'X-Cloud-Trace-Context carries the same id');
    assert.strictEqual(pf.auth, undefined, 'the preflight carries no credentials'); assert.strictEqual(get.auth, `Bearer ${TOKEN}`);
  }
  assert.ok(!run.o.includes(TOKEN.slice(4)) && !fs.readFileSync(out, 'utf8').includes(TOKEN.slice(4)), '🔴 the token appears in no output and no file');
  // a file never mixes workloads
  const mix = await cli(['--label', 'before', '--mode', 'warm', '--samples', '1', '--rid', 'x_pizza', '--stats-day', '2026-10-03', '--base', base, '--out', out], { PORTAL_PROBE_ID_TOKEN: TOKEN });
  assert.notStrictEqual(mix.code, 0); assert.match(mix.o, /mixes 2 workloads/);
  const noTok = await cli(['--label', 'x', '--mode', 'warm', '--rid', 'x_pizza', '--stats-day', '2026-10-04', '--base', base, '--out', path.join(tmp, 'n.jsonl')], { PORTAL_PROBE_ID_TOKEN: '' });
  assert.notStrictEqual(noTok.code, 0); assert.match(noTok.o, /PORTAL_PROBE_ID_TOKEN/);
  ok('probe run: every sample records the one workload (rid, statsDay, destination, path) + a DISTINCT trace id per leg, actually sent (traceparent + X-Cloud-Trace-Context); credentials only on the GET; the token is in no output or file; appending a different workload to a file is refused; no token → refused');

  // ── SF2: the warm guard refuses mismatched workloads ───────────────────────────────────────────────────────────
  const synth = (file, { rid = 'x_pizza', statsDay = '2026-10-04', base: b, slow = 0, mode = 'warm', extra = [] } = {}) => {
    const w = P.resolveWorkload({ rid, statsDay, base: b, nowMs: NOW });
    const L = [];
    for (let i = 0; i < 50; i++) for (const fn of ['getMyRestaurants', 'getEditableCatalog', 'getSalesStats']) {
      L.push({ label: 'x', mode, fn, status: 200, workloadId: w.workloadId, rid: w.rid, statsDay: w.statsDay, destination: w.destination, path: w.paths[fn],
        primaryMs: 100 + i + (fn === 'getSalesStats' ? slow : 0), preflightMs: 1, requestMs: 1, startedAt: 'x', endedAt: 'y' });
    }
    fs.writeFileSync(file, [...L, ...extra].map((r) => JSON.stringify(r)).join('\n'));
  };
  const f = (n) => path.join(tmp, n);
  synth(f('b')); synth(f('a'));
  assert.strictEqual(P.warmGuard(f('b'), f('a'), silent).pass, true, 'same workload, same latency → PASS');
  synth(f('a-slow'), { slow: 60 });
  const slow = P.warmGuard(f('b'), f('a-slow'), silent);
  assert.strictEqual(slow.pass, false); assert.strictEqual(slow.results.getSalesStats, 'FAIL'); assert.strictEqual(slow.results.getMyRestaurants, 'PASS');
  for (const [name, o, re] of [['rid', { rid: 'la_musa' }, /rid: "x_pizza" vs "la_musa"/], ['statsDay', { statsDay: '2026-10-03' }, /statsDay: "2026-10-04" vs "2026-10-03"/], ['destination', { base: 'https://other.example' }, /destination/]]) {
    synth(f(`a-${name}`), o);
    assert.throws(() => P.warmGuard(f('b'), f(`a-${name}`), silent), re, `🔴 a ${name} mismatch must be REFUSED, never PASS`);
  }
  synth(f('a-mixed'), { extra: [{ mode: 'warm', fn: 'getSalesStats', status: 200, workloadId: 'ffffffffffffffff', primaryMs: 1 }] });
  assert.throws(() => P.warmGuard(f('b'), f('a-mixed'), silent), /mixes 2 workloads/);
  fs.writeFileSync(f('old'), JSON.stringify({ mode: 'warm', fn: 'getSalesStats', status: 200, primaryMs: 1 }));
  assert.throws(() => P.warmGuard(f('old'), f('a'), silent), /no workloadId/, 'a pre-revision file (no workload recorded) is refused, not trusted');
  ok('warm guard: the stricter bound per endpoint (PASS / FAIL as before), and it REFUSES a before/after pair whose restaurant, stats day (query) or destination differ, a file mixing workloads, and a file with no recorded workload');

  // ── SF1: cold attribution ──────────────────────────────────────────────────────────────────────────────────────
  {
    const row = { preflightTrace: 'p1', getTrace: 'g1', startedAt: '2026-10-07T12:00:00.000Z', endedAt: '2026-10-07T12:00:04.000Z' };
    const rq = (trace, instance, revision = 'getsalesstats-00007-abc') => ({ trace, instance, revision, timestamp: '2026-10-07T12:00:03Z' });
    const st = (instance, ts, revision = 'getsalesstats-00007-abc') => ({ instance, revision, timestamp: ts });
    // the true cold start: both legs on instance A, A started inside the window
    let c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', '2026-10-07T12:00:00.500Z')]);
    assert.strictEqual(c.cls, 'cold'); assert.strictEqual(c.evidence.get.instance, 'A'); assert.strictEqual(c.evidence.get.revision, 'getsalesstats-00007-abc'); assert.strictEqual(c.evidence.get.startup, '2026-10-07T12:00:00.500Z');
    // 🔴 codex repro: an UNRELATED concurrent startup (another instance, another revision) in the window → NOT cold
    c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('Z', '2026-10-07T12:00:01Z'), st('A2', '2026-10-07T12:00:01Z', 'getsalesstats-00008-new')]);
    assert.strictEqual(c.cls, 'warm', '🔴 a concurrent startup of ANOTHER instance must not make this sample cold');
    // same instance id, other revision started in the window → not this instance
    c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', '2026-10-07T12:00:01Z', 'getsalesstats-00008-new')]);
    assert.strictEqual(c.cls, 'warm', 'an instance is (revision, instance id)');
    // the SAME instance id on two revisions is two instances: GET's revision started in the window → ambiguous, not warm
    c = P.classifySample(row, [rq('p1', 'A', 'rev-old'), rq('g1', 'A', 'rev-new')], [st('A', '2026-10-07T12:00:01Z', 'rev-new')]);
    assert.strictEqual(c.cls, 'ambiguous', 'an instance is (revision, instance id) on the legs too');
    // the instance started BEFORE the sample (pre-warmed) → warm
    c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', '2026-10-07T11:40:00Z')]);
    assert.strictEqual(c.cls, 'warm');
    // 🔴 preflight and GET on DIFFERENT instances, one of them cold → ambiguous, excluded
    c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'B')], [st('B', '2026-10-07T12:00:02Z')]);
    assert.strictEqual(c.cls, 'ambiguous'); assert.strictEqual(c.reason, 'legs_on_different_instances_one_started');
    c = P.classifySample(row, [rq('p1', 'A'), rq('g1', 'B')], [st('A', '2026-10-07T12:00:00.2Z')]);
    assert.strictEqual(c.cls, 'ambiguous', 'either leg cold on a different instance → ambiguous');
    // different instances, neither started → still warm (both warm instances)
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'B')], []).cls, 'warm');
    // uncorrelated legs fail closed
    assert.deepStrictEqual([P.classifySample(row, [rq('g1', 'A')], [st('A', '2026-10-07T12:00:01Z')]).cls, P.classifySample(row, [rq('g1', 'A')], []).reason], ['uncorrelated', 'preflight_no_request_log']);
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A')], []).reason, 'get_no_request_log');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), { trace: 'g1', revision: 'r', instance: undefined, timestamp: 'x' }], []).reason, 'get_request_log_without_instance');
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A'), rq('g1', 'B')], []).cls, 'ambiguous', 'one trace on two instances → ambiguous');
    // the window: a startup a moment outside (beyond the skew) does not count
    assert.strictEqual(P.classifySample(row, [rq('p1', 'A'), rq('g1', 'A')], [st('A', new Date(Date.parse(row.endedAt) + P.SKEW_MS + 1).toISOString())]).cls, 'warm');
  }
  ok('cold attribution: cold ONLY when both legs\' own request logs (by their trace ids) name the SAME (revision, instance) and THAT instance\'s startup log is inside the sample window; a concurrent unrelated startup (other instance or revision) → warm; pre-warmed → warm; preflight and GET on different instances with a startup → ambiguous (excluded); a missing request log / instance id → uncorrelated (excluded); a trace on two instances → ambiguous; the evidence (trace, revision, instance, startup) is kept');

  // the log fetch + summarize composition, with an injected (read-only) reader
  {
    const file = path.join(tmp, 'cold.jsonl');
    const w = P.resolveWorkload({ rid: 'x_pizza', statsDay: '2026-10-04', nowMs: NOW });
    const mk = (i, fn, cls) => ({ label: 'after', mode: 'cold', round: i, fn, workloadId: w.workloadId, rid: 'x_pizza', statsDay: '2026-10-04', destination: w.destination, path: w.paths[fn],
      startedAt: `2026-10-07T12:0${i}:00.000Z`, endedAt: `2026-10-07T12:0${i}:03.000Z`, preflightTrace: `p${i}${fn}`, getTrace: `g${i}${fn}`, status: 200, primaryMs: cls === 'cold' ? 2000 : 150, preflightMs: 1, requestMs: 1, _want: cls });
    const rows = [mk(1, 'getSalesStats', 'cold'), mk(2, 'getSalesStats', 'warm'), mk(3, 'getSalesStats', 'ambiguous'), mk(4, 'getSalesStats', 'uncorrelated')];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
    const filters = [];
    const read = (filter) => {
      filters.push(filter);
      if (/log_id\("run.googleapis.com\/requests"\)/.test(filter)) {
        const L = [];
        for (const r of rows) {
          const sameInst = `i${r.round}`;
          if (r._want === 'uncorrelated') continue;
          L.push({ trace: `projects/xpizza-delivery/traces/${r.preflightTrace}`, resource: { labels: { revision_name: 'rev1' } }, labels: { instanceId: sameInst }, timestamp: r.endedAt });
          L.push({ trace: `projects/xpizza-delivery/traces/${r.getTrace}`, resource: { labels: { revision_name: 'rev1' } }, labels: { instanceId: r._want === 'ambiguous' ? `${sameInst}b` : sameInst }, timestamp: r.endedAt });
        }
        return L.filter((e) => filter.includes(e.trace));
      }
      // startup logs: i1 (cold) and i3b (the ambiguous GET instance) started in their windows; an UNRELATED instance in every window
      const S = [{ labels: { instanceId: 'i1' }, resource: { labels: { revision_name: 'rev1' } }, timestamp: '2026-10-07T12:01:01Z' },
        { labels: { instanceId: 'i3b' }, resource: { labels: { revision_name: 'rev1' } }, timestamp: '2026-10-07T12:03:01Z' },
        { labels: { instanceId: 'unrelated' }, resource: { labels: { revision_name: 'rev1' } }, timestamp: '2026-10-07T12:02:01Z' }];
      return S.filter((e) => filter.includes(`"${e.labels.instanceId}"`));
    };
    const lines = [];
    const s = P.summarize(file, { logs: true, read, nowMs: Date.parse('2026-10-07T12:30:00Z'), print: (l) => lines.push(l) });
    assert.deepStrictEqual(s.rows.map((r) => r.attribution.cls), ['cold', 'warm', 'ambiguous', 'uncorrelated']);
    assert.deepStrictEqual(Object.keys(s.groups), ['after cold getSalesStats']); assert.strictEqual(s.groups['after cold getSalesStats'].length, 1, 'ONLY the attributed cold sample enters the cold statistics');
    assert.deepStrictEqual(s.excluded, { 'cold run → ambiguous': 1, 'cold run → uncorrelated': 1, 'cold run → warm': 1 });
    assert.ok(filters.every((x) => /resource\.type="cloud_run_revision"/.test(x)), 'every read is scoped to Cloud Run');
    assert.ok(filters.some((x) => x.includes('trace=("projects/xpizza-delivery/traces/p1getSalesStats"')), 'request logs are looked up BY THE LEGS\' TRACE IDS');
    assert.ok(filters.filter((x) => /Starting new instance/.test(x)).every((x) => /labels\.instanceId=\(/.test(x) && !x.includes('"unrelated"')), 'startup logs are looked up BY THE MATCHED INSTANCE IDS only');
    assert.throws(() => P.summarize(file, { logs: true, read, nowMs: Date.parse('2026-10-07T12:05:00Z'), print: silent }), /at least 5 minutes/, 'too-early log reads are refused (an un-ingested log would read as uncorrelated)');
    // without --logs a cold run is reported as UNATTRIBUTED, never as cold
    const u = P.summarize(file, { logs: false, print: silent });
    assert.deepStrictEqual(Object.keys(u.groups), ['after cold (UNATTRIBUTED: run with --logs; not evidence of a cold start) getSalesStats']);
  }
  ok('summarize --logs (injected read-only reader): request logs fetched by the legs\' trace ids, startup logs only for the matched instances; of 4 cold-run samples only the attributed cold one is counted — warm / ambiguous / uncorrelated are EXCLUDED and counted; a read < 5 min after the run is refused; without --logs cold samples are labelled UNATTRIBUTED');

  fs.rmSync(tmp, { recursive: true, force: true });
  __finished = true;
  console.log(`\nportal-latency-probe: OK (${n})`);
})().catch((e) => { console.error('portal-latency-probe FAILED:', e && e.stack || e); process.exit(1); });
