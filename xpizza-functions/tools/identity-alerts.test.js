'use strict';
// 1D D4-c2b — the alert definitions + owner tool (PLAN-D4c2b rev 14 §6, §6a), offline: the pinned policy values, the emitter line vs
// the INSTALLED filters, the threshold rule, the portal filters, and the tool's plan / apply against a recording fake API (channel
// refusal, arming order, idempotency, the five-label resource copy). Run: node tools/identity-alerts.test.js
const assert = require('assert');
const A = require('./identity-alerts-core');
const T = require('./setup-identity-alerts');
const S = require('../catalog/identity-integrity-state');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const CH = 'projects/p/notificationChannels/1';
const THR = { getMyRestaurants: 3, getEditableCatalog: 3, editCatalog: 4, publishEdited: 3, getSalesStats: 5 };

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

  console.log(`identity-alerts: OK (${n})`);
})().catch((e) => { console.error('identity-alerts FAILED:', e); process.exit(1); });
