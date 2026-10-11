'use strict';
// 1D D4-c2b — the alert definitions + owner tool (PLAN-D4c2b rev 14 §6, §6a), offline: the pinned policy values, the emitter line vs
// the INSTALLED filters, the threshold rule, the portal filters, and the tool's plan / apply against a recording fake API (channel
// refusal, arming order, idempotency, the five-label resource copy). Run: node tools/identity-alerts.test.js
const assert = require('assert');
const A = require('./identity-alerts-core');
const T = require('./setup-identity-alerts');
const S = require('../catalog/identity-integrity-state');

let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-alerts FAILED: exited without completing (a promise never settled)'); process.exitCode = 1; } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const CH = 'projects/p/notificationChannels/1';
const THR = { getMyRestaurants: 3, getEditableCatalog: 3, editCatalog: 4, publishEdited: 3, getSalesStats: 5 };

setTimeout(() => { console.error('identity-alerts FAILED: the suite did not finish within 60 s (a bound was not enforced)'); process.exit(1); }, 60000).unref();
(async () => {
  // ── 1. §6 policies exactly as the plan pins them ───────────────────────────────────────────────────────────────
  {
    const pols = A.integrityPolicies(CH);
    assert.deepStrictEqual(pols.map((p) => p.displayName), ['D4-c2b identity integrity: open_violations > 0', 'D4-c2b identity integrity: open_degraded > 0',
      'D4-c2b identity integrity: stale > 0', 'D4-c2b identity integrity: heartbeat absent 45 min'], 'open_gaps is informational: a metric, no policy');
    for (const p of pols.slice(0, 3)) {
      const c = p.conditions[0].conditionThreshold;
      assert.deepStrictEqual(c.aggregations, [{ alignmentPeriod: '1800s', perSeriesAligner: 'ALIGN_SUM', crossSeriesReducer: 'REDUCE_SUM', groupByFields: ['metric.label.rid'] }]);
      assert.deepStrictEqual([c.comparison, c.thresholdValue, c.duration, c.evaluationMissingData, p.alertStrategy.autoClose], ['COMPARISON_GT', 0, '60s', 'EVALUATION_MISSING_DATA_INACTIVE', '3600s']);
      assert.deepStrictEqual(p.notificationChannels, [CH]);
    }
    const hb = pols[3].conditions[0].conditionAbsent;
    assert.deepStrictEqual(hb.aggregations, [{ alignmentPeriod: '900s', perSeriesAligner: 'ALIGN_SUM', crossSeriesReducer: 'REDUCE_SUM', groupByFields: [] }], 'service level: revisions summed into one series');
    assert.strictEqual(hb.duration, '2700s', '45-min absence');
    const metrics = A.integrityMetrics();
    assert.deepStrictEqual(metrics.map((m) => m.name), ['identity_integrity_open_violations', 'identity_integrity_open_degraded', 'identity_integrity_stale', 'identity_integrity_open_gaps', 'identity_integrity_heartbeat']);
    for (const m of metrics.slice(0, 4)) { assert.deepStrictEqual([m.metricDescriptor.metricKind, m.metricDescriptor.valueType], ['DELTA', 'INT64']); assert.strictEqual(m.labelExtractors.rid, 'EXTRACT(jsonPayload.rid)'); }
  }
  ok('§6 policies: per-field 30-min ALIGN_SUM / REDUCE_SUM by rid, GT 0, duration 60 s, missing data inactive, autoClose 3600 s; open_gaps metric without policy; heartbeat absence 45 min aggregated at SERVICE level; DELTA/INT64 counters with rid extracted');

  // ── 2. the monitor's OWN emitter vs the installed filters ─────────────────────────────────────────────────────────
  {
    const entry = (line) => ({ resource: { type: 'cloud_run_revision', labels: { service_name: 'verifyidentityintegrity' } }, jsonPayload: line });
    const line = (s, stale = 0) => S.summaryLine('rid', { coverage: stale ? { first_enumerated_at: S.fromMs(0) } : {}, summary: s }, stale ? 100 * 60000 : 0);
    const f = (field) => A.integrityStateFilter(field);
    assert.ok(A.matches(f('open_violations'), entry(line({ open_violations: 2, open_gaps: 0, open_degraded: 0 }))));
    assert.ok(!A.matches(f('open_violations'), entry(line({ open_violations: 0, open_gaps: 3, open_degraded: 0 }))), 'a zero count never matches');
    assert.ok(A.matches(f('open_gaps'), entry(line({ open_violations: 0, open_gaps: 3, open_degraded: 0 }))));
    assert.ok(A.matches(f('open_degraded'), entry(line({ open_violations: 0, open_gaps: 0, open_degraded: 1 }))));
    assert.ok(A.matches(f('stale'), entry(line({ open_violations: 0, open_gaps: 0, open_degraded: 0 }, 1))), 'stale = 1');
    assert.ok(!A.matches(f('open_violations'), { resource: { type: 'cloud_run_revision', labels: { service_name: 'other' } }, jsonPayload: line({ open_violations: 1 }) }), 'only the monitor\'s service');
    assert.ok(A.matches(A.heartbeatFilter(), entry(S.heartbeatLine({ enumerated: 2, covered: 2 }))));
    assert.ok(!A.matches(A.heartbeatFilter(), entry(line({ open_violations: 0, open_gaps: 0, open_degraded: 0 }))));
    assert.throws(() => A.matches('jsonPayload.x:"y"', {}), /subset/, 'a filter the evaluator cannot read is never "matched"');
  }
  ok('§6 acceptance premise: the monitor\'s own summaryLine / heartbeatLine match exactly the installed filters (positive counts only, the monitor\'s service only); an unreadable filter term throws');

  // ── 3. §6a thresholds: the deterministic rule ─────────────────────────────────────────────────────────────────────
  {
    const F = Object.fromEntries(A.SPEC.portal.functions.map((f) => [f.name, f]));
    assert.deepStrictEqual(A.thresholdFor(F.publishEdited, [0.8, 1.2, 2.48, 0.9, 1.0, 1.1]).value, 3, 'the plan\'s own example: n = 6, max 2.48 s → 3.0 s');
    assert.strictEqual(A.thresholdFor(F.publishEdited, [1, 1, 1, 1]).value, 5, 'n < 5 → the default');
    assert.strictEqual(A.thresholdFor(F.getMyRestaurants, Array(10).fill(9)).value, 3, '5 ≤ n < 20 → the default (only publishEdited uses its observed max)');
    const xs = Array.from({ length: 40 }, (_, i) => 0.1 + i * 0.05);   // max 2.05, p95 = 1.95 → 1.5×p95 = 2.925 → +0.5 = 3.425 → 3.5
    assert.deepStrictEqual([A.thresholdFor(F.getSalesStats, xs).value, A.thresholdFor(F.getSalesStats, xs).rule], [3.5, 'n>=20']);
    assert.strictEqual(A.thresholdFor(F.getSalesStats, [...Array(19).fill(0.2), 6.1]).value, 7, 'n = 20: max(6.1, 1.5 × 0.2) + 0.5 = 6.6 s, rounded UP to 7.0 s');
    assert.strictEqual(A.roundUpHalf(3.0), 3); assert.strictEqual(A.roundUpHalf(3.01), 3.5);
    assert.deepStrictEqual(A.SPEC.portal.functions.map((f) => [f.name, f.method, f.default_s]), [['getMyRestaurants', 'GET', 3], ['getEditableCatalog', 'GET', 3], ['editCatalog', 'POST', 4], ['publishEdited', 'POST', 5], ['getSalesStats', 'GET', 5]]);
  }
  ok('§6a thresholds: n ≥ 20 = max(observed max, 1.5 × p95) + 0.5 s rounded up to 0.5 s; 5 ≤ n < 20 = the default except publishEdited = observed max + 0.5 s (the plan\'s example 2.48 → 3.0 s); n < 5 = the default; the five functions, methods and defaults as the plan\'s table');

  // ── 4. §6a filters ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    const m = A.portalMetrics('p', THR); const pol = A.portalPolicies(CH, THR);
    const pe = (k) => m.find((x) => x.name === `portal_${k}_publishedited`);
    const req = (status, latency, extra = {}) => ({ resource: { type: 'cloud_run_revision', labels: { service_name: 'publishedited', location: 'us-central1', project_id: 'p' } },
      logName: 'projects/p/logs/run.googleapis.com%2Frequests', httpRequest: { requestMethod: 'POST', status, latency }, ...extra });
    assert.ok(A.matches(pe('slow').filter, req(200, '3.4s')) && !A.matches(pe('slow').filter, req(200, '2.9s')), 'slow = over the threshold');
    assert.ok(!A.matches(pe('slow').filter, req(503, '9s')), 'a 5xx is not "slow" (status < 500)');
    assert.ok(A.matches(pe('error').filter, req(503, '0.1s')) && A.matches(pe('error').filter, req(500, '9s')) && !A.matches(pe('error').filter, req(499, '0.1s')), 'error = status ≥ 500, not inheriting < 500');
    assert.ok(!A.matches(pe('error').filter, { ...req(503, '0.1s'), httpRequest: { requestMethod: 'GET', status: 503, latency: '0.1s' } }), 'the function\'s method only');
    assert.ok(A.matches(pe('slow').filter, req(200, '3.6s', { labels: { c2b_acceptance: '1' } })), 'the alerting metrics COUNT the synthetic acceptance entries');
    assert.ok(!A.matches(A.thresholdPopulationFilter(A.SPEC.portal.functions[3], 'p'), req(200, '3.6s', { labels: { c2b_acceptance: '1' } })), 'the threshold population EXCLUDES them');
    assert.strictEqual(pe('latency').valueExtractor, 'REGEXP_EXTRACT(httpRequest.latency, "^([0-9.]+)s$")');
    assert.deepStrictEqual(pe('latency').metricDescriptor, { metricKind: 'DELTA', valueType: 'DISTRIBUTION', unit: 's' });
    const slowPol = pol.find((p) => p.displayName === 'D4-c2b portal slow: publishEdited').conditions[0].conditionThreshold;
    const errPol = pol.find((p) => p.displayName === 'D4-c2b portal error: publishEdited').conditions[0].conditionThreshold;
    assert.deepStrictEqual([slowPol.aggregations[0].alignmentPeriod, slowPol.aggregations[0].groupByFields, slowPol.thresholdValue], ['3600s', [], 1], 'SLOW: ≥ 2 within 1 h, service level');
    assert.deepStrictEqual([errPol.aggregations[0].alignmentPeriod, errPol.aggregations[0].groupByFields, errPol.thresholdValue], ['900s', [], 2], 'ERROR: ≥ 3 within 15 min');
    assert.strictEqual(pol.length, 10); assert.ok(!A.SPEC.portal.functions.some((f) => f.name === 'reportClientVersion'), 'reportClientVersion excluded (background)');
    assert.throws(() => A.portalMetrics('p', { ...THR, editCatalog: 0 }), /none for editCatalog/);
  }
  ok('§6a filters: slow = non-5xx over the threshold, error = ≥ 500 (separate), the function\'s method and service only; synthetic entries counted by the alerting metrics, excluded from the threshold population; latency DISTRIBUTION via REGEXP_EXTRACT; SLOW 1 h > 1 / ERROR 15 min > 2 at service level; 10 policies; reportClientVersion excluded');

  // ── 5. the tool against a recording fake API ─────────────────────────────────────────────────────────────────────
  {
    const calls = [];
    const fake = (state) => ({
      getChannel: async (name) => { calls.push(['getChannel', name]); return state.channel; },
      listMetrics: async () => state.metrics.slice(), listPolicies: async () => state.policies.slice(),
      createMetric: async (m) => { calls.push(['createMetric', m.name]); state.metrics.push(m); },
      updateMetric: async (m) => { calls.push(['updateMetric', m.name]); state.metrics = state.metrics.map((x) => (x.name === m.name ? m : x)); },
      createPolicy: async (p) => { calls.push(['createPolicy', p.displayName]); state.policies.push({ ...p, name: `projects/p/alertPolicies/${state.policies.length}` }); },
      updatePolicy: async (name, p) => { calls.push(['updatePolicy', p.displayName]); state.policies = state.policies.map((x) => (x.name === name ? { ...p, name } : x)); },
      listEntries: async () => state.entries || [],
    });
    const thresholds = Object.fromEntries(Object.entries(THR).map(([k, v]) => [k, { value: v }]));
    const st = { channel: { type: 'email', verificationStatus: 'UNVERIFIED' }, metrics: [], policies: [] };
    await assert.rejects(() => T.plan(fake(st), 'p', CH, thresholds), /VERIFIED email channel/, 'an unverified channel is refused before anything is written');
    st.channel = { type: 'email', verificationStatus: 'VERIFIED' };
    const p1 = await T.plan(fake(st), 'p', CH, thresholds);
    assert.ok(p1.metricDiff.every((d) => d.action === 'create') && p1.policyDiff.every((d) => d.action === 'create'));
    calls.length = 0;
    await T.apply(fake(st), p1);
    const firstPolicy = calls.findIndex((c) => c[0] === 'createPolicy'); const lastMetric = calls.map((c) => c[0]).lastIndexOf('createMetric');
    assert.ok(lastMetric < firstPolicy, 'ARMING ORDER: every metric before any policy');
    assert.strictEqual(calls.filter((c) => c[0] === 'createMetric').length, 20); assert.strictEqual(calls.filter((c) => c[0] === 'createPolicy').length, 14);
    calls.length = 0;
    const p2 = await T.plan(fake(st), 'p', CH, thresholds);
    assert.deepStrictEqual(await T.apply(fake(st), p2), [], 'IDEMPOTENT: a second apply writes nothing');
    assert.deepStrictEqual(calls.filter((c) => c[0] !== 'getChannel'), []);
    const p3 = await T.plan(fake(st), 'p', CH, Object.fromEntries(Object.entries(thresholds).map(([k, v]) => [k, { value: k === 'editCatalog' ? 4.5 : v.value }])));
    assert.deepStrictEqual(p3.metricDiff.filter((d) => d.action !== 'unchanged'), [{ name: 'portal_slow_editcatalog', action: 'update' }], 'a changed threshold updates exactly its metric');
    assert.deepStrictEqual(p3.policyDiff.filter((d) => d.action !== 'unchanged').map((d) => d.displayName), ['D4-c2b portal slow: editCatalog'], '… and its policy\'s condition name');
    // the five-label resource copy
    st.entries = [{ resource: { type: 'cloud_run_revision', labels: { service_name: 's', revision_name: 'r', configuration_name: 'c', location: 'l' } }, logName: 'x' }];
    await assert.rejects(() => T.realResource(fake(st), 'p', 's', null), /lacks resource label project_id/);
    st.entries[0].resource.labels.project_id = 'p';
    assert.deepStrictEqual((await T.realResource(fake(st), 'p', 's', null)).resource.labels.project_id, 'p');
    assert.strictEqual(T.JOB('p', 'us-central1'), 'projects/p/locations/us-central1/jobs/firebase-schedule-verifyIdentityIntegrity-us-central1');
  }
  ok('the tool (fake API): an unverified channel refused before any write; apply arms metrics (20) BEFORE policies (14); a second apply writes nothing; a changed threshold updates exactly that metric + policy; a real entry lacking any of the five resource labels is refused; the paused job is the function\'s scheduler job');

  // ── 6. P1-4: INSTALL needs no heartbeat (the job is PAUSED at that point); ARM needs the job ENABLED and a heartbeat METRIC POINT ──
  {
    const tPol = Date.parse('2026-10-11T00:00:00Z'); let clock = tPol + 60000;
    const st = { job: 'PAUSED', policies: [{ displayName: T.HB_POLICY, mutationRecord: { mutateTime: new Date(tPol).toISOString() } }], series: [], entries: [], calls: [] };
    const api = {
      getJob: async () => ({ state: st.job }), listPolicies: async () => st.policies,
      timeSeries: async () => st.series, listEntries: async (f) => { st.calls.push(f); return st.entries.filter((e) => !e.match || e.match(f)); },
    };
    const sleep = async (ms) => { clock += ms; };
    const base = { api, region: 'us-central1', project: 'p', now: () => clock, sleep, log: () => {}, waitMs: 5 * 60000, pollMs: 60000, transitionMs: 10 * 60000, askMs: 1000 };
    // install needs NOTHING from the heartbeat: apply over an empty plan writes nothing and waits for nothing
    assert.deepStrictEqual(await T.install({}, { metricDiff: [], policyDiff: [], metrics: [], policies: [] }), [], 'install never waits for a heartbeat');
    await assert.rejects(() => T.arm({ ...base, ask: async () => false }), /resume it first/, 'arm refuses while the job is PAUSED');
    st.job = 'ENABLED';
    // a RAW heartbeat LOG entry alone is not arming: no ingested metric point → not armed, at the bounded wait
    st.entries = [{ timestamp: new Date(clock).toISOString(), resource: { labels: { revision_name: 'rev-1' } } }];
    await assert.rejects(() => T.arm({ ...base, ask: async () => false }), /no heartbeat METRIC POINT .* NOT armed/, 'a log entry without an ingested metric point does NOT arm');
    // a point BEFORE the policy change does not count either
    st.series = [{ points: [{ value: { int64Value: '1' }, interval: { endTime: new Date(tPol - 1000).toISOString() } }] }];
    await assert.rejects(() => T.arm({ ...base, ask: async () => false }), /NOT armed/, 'a point ingested before the policy change does not arm');
    // armed + the revision transition: a heartbeat from a NEW revision, a continuous series, the owner says no absence email
    st.series = [{ points: [0, 15, 30, 45].map((m) => ({ value: { int64Value: '1' }, interval: { endTime: new Date(tPol + m * 60000).toISOString() } })) }];
    st.entries = [{ timestamp: new Date(clock).toISOString(), resource: { labels: { revision_name: 'rev-1' } }, match: (f) => !/revision_name!=/.test(f) },
      { timestamp: new Date(clock + 1).toISOString(), resource: { labels: { revision_name: 'rev-2' } }, match: (f) => /revision_name!="rev-1"/.test(f) }];
    const r = await T.arm({ ...base, ask: async () => false });
    assert.deepStrictEqual(r.revisions, ['rev-1', 'rev-2'], 'armed, then the revision transition passed');
    // codex build r2 P2-D: an EMPTY transition series, or one with points on only ONE side of the new revision, never passes
    const tNew = clock + 1;   // the new revision's heartbeat timestamp (entries[1])
    const ser = (mins) => [{ points: mins.map((m) => ({ value: { int64Value: '1' }, interval: { endTime: new Date(tPol + m * 60000).toISOString() } })) }];
    let calls = 0;
    api.timeSeries = async () => { calls += 1; return calls === 1 ? ser([5]) : []; };   // armed by one point, then the transition series is EMPTY
    await assert.rejects(() => T.arm({ ...base, ask: async () => false }), /no ingested heartbeat METRIC POINT after the new revision/, 'an empty transition series fails');
    calls = 0; api.timeSeries = async () => { calls += 1; return calls === 1 ? ser([5]) : ser([5]); };   // points only BEFORE the transition
    await assert.rejects(() => T.arm({ ...base, ask: async () => false }), /after the new revision/, 'points only before the transition fail');
    const after = Math.ceil((tNew - tPol) / 60000) + 10;
    calls = 0; api.timeSeries = async () => { calls += 1; return calls === 1 ? ser([after]) : ser([after]); };   // points only AFTER it
    await assert.rejects(() => T.arm({ ...base, ask: async () => false }), /before the revision transition/, 'points only after the transition fail');
    api.timeSeries = async () => st.series;
    await assert.rejects(() => T.arm({ ...base, ask: () => new Promise(() => {}) }), /did not confirm/, 'an UNANSWERED confirmation is a failure at its bound, never a hang');
    await assert.rejects(() => T.arm({ ...base, ask: async () => true }), /absence incident opened on a revision transition/);
    st.series = [{ points: [0, 50].map((m) => ({ value: { int64Value: '1' }, interval: { endTime: new Date(tPol + m * 60000).toISOString() } })) }];
    await assert.rejects(() => T.arm({ ...base, ask: async () => false }), /≥ 45-min gap/, 'a 45-min gap in the service-level series across the transition fails');
  }
  ok('P1-4: install needs no heartbeat (the job stays PAUSED); arm refuses a paused job, and arms only on a heartbeat METRIC POINT ingested after the policy change (a raw log entry, or an older point, is NOT armed); the revision-transition acceptance needs a heartbeat from the NEW revision, no 45-min series gap and the owner\'s bounded confirmation');

  // ── 7. P1-5: ABSENCE acceptance always RESUMES — at its independent deadline when nobody answers, and after a thrown error ──
  {
    const mk = (over = {}) => {
      const st = { state: 'ENABLED', paused: 0, resumed: 0, gets: 0, failResume: 0 };
      const hb = { timestamp: new Date(Date.now()).toISOString() };
      const api = {
        listEntries: async () => [hb], pauseJob: async () => { st.paused += 1; st.state = 'PAUSED'; },
        resumeJob: async () => { st.resumed += 1; if (st.failResume > 0) { st.failResume -= 1; throw new Error('503'); } st.state = 'ENABLED'; },
        getJob: async () => { st.gets += 1; return { state: st.state }; }, ...over(st),
      };
      return { st, api };
    };
    const lim = { region: 'r', log: () => {}, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), drainMs: 10, totalMs: 300, passMs: 250, askMs: 60 };
    // nobody ever answers: the prompt is bounded, the deadline is re-evaluated, the job is RESUMED and verified, the result is a FAIL
    let { st, api } = mk(() => ({}));
    const t0 = Date.now();
    await assert.rejects(() => T.acceptAbsence({ ...lim, api, ask: () => new Promise(() => {}) }), /no absence email/);
    assert.deepStrictEqual([st.paused, st.resumed >= 1, st.state], [1, true, 'ENABLED'], 'resumed at the deadline although the prompt was never answered');
    assert.ok(Date.now() - t0 < 2000, 'within its independent deadline');
    // an exception AFTER the pause (the post-drain heartbeat refresh throws) → still resumed, the error surfaces
    let n2 = 0;
    ({ st, api } = mk(() => ({ listEntries: async () => { n2 += 1; if (n2 > 1) throw new Error('logging down'); return [{ timestamp: new Date().toISOString() }]; } })));
    await assert.rejects(() => T.acceptAbsence({ ...lim, api, ask: async () => true }), /logging down/);
    assert.deepStrictEqual([st.paused, st.resumed, st.state], [1, 1, 'ENABLED'], 'an exception after the pause still resumes');
    // a failing resume is RETRIED, and the job state is VERIFIED
    ({ st, api } = mk(() => ({})));
    st.failResume = 2;
    const ok7 = await T.acceptAbsence({ ...lim, api, ask: async () => true });
    assert.deepStrictEqual([ok7.ok, st.resumed, st.state], [true, 3, 'ENABLED'], 'resume retried until ENABLED');
    ({ st, api } = mk(() => ({ resumeJob: async () => { throw new Error('denied'); } })));
    await assert.rejects(() => T.acceptAbsence({ ...lim, api, ask: async () => true }), /NOT enabled/, 'a resume that never takes is reported, never silent');
    // codex build r2 P1-A: the server APPLIES the pause but its response is lost (timeout) → the job is still reconciled and RESUMED
    ({ st, api } = mk((x) => ({ pauseJob: async () => { x.paused += 1; x.state = 'PAUSED'; throw Object.assign(new Error('api_pauseJob_timeout'), { timeout: true }); } })));
    await assert.rejects(() => T.acceptAbsence({ ...lim, api, ask: async () => true }), /api_pauseJob_timeout/);
    assert.deepStrictEqual([st.paused, st.resumed, st.state], [1, 1, 'ENABLED'], 'a pause applied with a lost response is still resumed');
    // the pause never applied (it failed before reaching the server) → the state reads ENABLED → nothing to resume, the error surfaces
    ({ st, api } = mk(() => ({ pauseJob: async () => { throw new Error('403'); } })));
    await assert.rejects(() => T.acceptAbsence({ ...lim, api, ask: async () => true }), /403/);
    assert.deepStrictEqual([st.resumed, st.state], [0, 'ENABLED'], 'a pause that never applied needs no resume (state verified ENABLED)');
    // the state read itself fails (unknown) → resume anyway, verified
    let g = 0;
    ({ st, api } = mk((x) => ({ getJob: async () => { g += 1; if (g === 1) throw new Error('503'); return { state: x.state }; } })));
    await T.acceptAbsence({ ...lim, api, ask: async () => true });
    assert.deepStrictEqual([st.resumed >= 1, st.state], [true, 'ENABLED'], 'an UNKNOWN state is resumed');
    // the absence clock starts at the heartbeat re-read AFTER draining (the in-flight run may have emitted a later one)
    let reads = 0;
    ({ st, api } = mk(() => ({ listEntries: async () => { reads += 1; return [{ timestamp: new Date(reads === 1 ? Date.now() - 1000 : Date.now()).toISOString() }]; } })));
    const ref7 = await T.acceptAbsence({ ...lim, api, ask: async () => true });
    assert.strictEqual(ref7.ok, true, 'passes against the REFRESHED last heartbeat (the pre-pause one is 1 s old, past the 250 ms pass bound)');
    // every API call can be bounded
    const slow = T.boundedApi({ getJob: () => new Promise(() => {}) }, 30);
    await assert.rejects(() => slow.getJob('r'), /api_getJob_timeout/);
  }
  ok('P1-5: absence acceptance always resumes — nobody answers → resumed and verified at the INDEPENDENT deadline (a FAIL, never a hang); an exception after the pause → resumed; a failing resume retried until ENABLED, a resume that never takes reported; every API call boundable');

  FINISHED = true;
  console.log(`identity-alerts: OK (${n})`);
})().catch((e) => { console.error('identity-alerts FAILED:', e); process.exit(1); });
