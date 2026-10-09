'use strict';
/* 1D D4-c2b — the PURE half of tools/setup-identity-alerts.js (PLAN-D4c2b rev 14 §6, §6a): the exact log-based metric and alert
   policy bodies built from tools/identity-alerts.json, the portal-latency thresholds (the plan's deterministic rule), the
   desired-vs-installed diff (idempotency), and a small evaluator for the filter subset used here, so the acceptance can ASSERT
   that the monitor's own emitter (identity-integrity-state.js summaryLine) produces a line the installed filter matches. */
const SPEC = require('./identity-alerts.json');

const metricType = (name) => `logging.googleapis.com/user/${name}`;

/* ── §6 the integrity metrics ─────────────────────────────────────────────────────────────────────────────────────── */
function integrityStateFilter(field) {
  return `${SPEC.integrity.base_filter} AND jsonPayload.event="${SPEC.integrity.state_event}" AND jsonPayload.${field}>0`;
}
const heartbeatFilter = () => `${SPEC.integrity.base_filter} AND jsonPayload.event="${SPEC.integrity.heartbeat_event}"`;
function integrityMetrics() {
  const out = SPEC.integrity.metrics.map((m) => ({
    name: m.name,
    description: `D4-c2b: identity_integrity_state lines with ${m.field} > 0 (one per restaurant per 15-min run)${m.alert ? '' : ' — informational, no policy'}`,
    filter: integrityStateFilter(m.field),
    metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', unit: '1', labels: [{ key: 'rid', valueType: 'STRING', description: 'restaurant id' }] },
    labelExtractors: { rid: 'EXTRACT(jsonPayload.rid)' },
  }));
  out.push({ name: SPEC.integrity.heartbeat_metric, description: 'D4-c2b: identity_integrity_heartbeat lines (enumeration complete, nothing stale)',
    filter: heartbeatFilter(), metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', unit: '1' } });
  return out;
}
function integrityPolicies(channel) {
  const P = SPEC.integrity.state_policy; const HB = SPEC.integrity.heartbeat_policy;
  const pol = SPEC.integrity.metrics.filter((m) => m.alert).map((m) => ({
    displayName: `D4-c2b identity integrity: ${m.field} > 0`,
    combiner: 'OR',
    conditions: [{ displayName: `${m.field} > 0 (30-min rolling sum, per restaurant)`, conditionThreshold: {
      filter: `metric.type="${metricType(m.name)}" AND resource.type="cloud_run_revision"`,
      aggregations: P.aggregations, comparison: P.comparison, thresholdValue: P.thresholdValue, duration: P.duration, evaluationMissingData: P.evaluationMissingData } }],
    alertStrategy: { autoClose: P.autoClose },
    notificationChannels: [channel],
    userLabels: { slice: 'd4-c2b' },
  }));
  pol.push({ displayName: 'D4-c2b identity integrity: heartbeat absent 45 min', combiner: 'OR',
    conditions: [{ displayName: 'no heartbeat for 45 min (service level, across revisions)', conditionAbsent: {
      filter: `metric.type="${metricType(SPEC.integrity.heartbeat_metric)}" AND resource.type="cloud_run_revision"`,
      aggregations: HB.aggregations, duration: HB.absentDuration } }],
    alertStrategy: { autoClose: HB.autoClose }, notificationChannels: [channel], userLabels: { slice: 'd4-c2b' } });
  return pol;
}

/* ── §6a portal latency ───────────────────────────────────────────────────────────────────────────────────────────── */
const portalBase = (f, project) => `resource.type="cloud_run_revision" AND resource.labels.service_name="${f.service}" AND resource.labels.location="${SPEC.region}" AND resource.labels.project_id="${project}" AND logName="projects/${project}/logs/${SPEC.portal.request_log}" AND httpRequest.requestMethod="${f.method}"`;
// the threshold POPULATION excludes the synthetic acceptance entries; the alerting metrics must COUNT them (the acceptance drives them)
const thresholdPopulationFilter = (f, project) => `${portalBase(f, project)} AND -labels.${SPEC.portal.synthetic_label}="1"`;
function portalMetrics(project, thresholds) {
  const out = [];
  for (const f of SPEC.portal.functions) {
    const base = portalBase(f, project);
    const slow = thresholds[f.name];
    if (!(slow > 0)) throw new Error(`portal thresholds: none for ${f.name}`);
    out.push({ name: `portal_latency_${f.service}`, description: `D4-c2b §6a: ${f.name} request latency (s)`, filter: base,
      valueExtractor: 'REGEXP_EXTRACT(httpRequest.latency, "^([0-9.]+)s$")',
      metricDescriptor: { metricKind: 'DELTA', valueType: 'DISTRIBUTION', unit: 's' },
      bucketOptions: { explicitBuckets: { bounds: SPEC.portal.distribution_buckets } } });
    out.push({ name: `portal_slow_${f.service}`, description: `D4-c2b §6a: ${f.name} non-5xx requests slower than ${slow} s`,
      filter: `${base} AND httpRequest.status<500 AND httpRequest.latency>"${slow}s"`, metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', unit: '1' } });
    out.push({ name: `portal_error_${f.service}`, description: `D4-c2b §6a: ${f.name} 5xx responses`,
      filter: `${base} AND httpRequest.status>=500`, metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', unit: '1' } });
  }
  return out;
}
function portalPolicies(channel, thresholds) {
  const out = [];
  for (const f of SPEC.portal.functions) {
    for (const [kind, P, what] of [['slow', SPEC.portal.slow_policy, `≥ 2 requests slower than ${thresholds[f.name]} s within 1 h`], ['error', SPEC.portal.error_policy, '≥ 3 5xx within 15 min']]) {
      out.push({ displayName: `D4-c2b portal ${kind}: ${f.name}`, combiner: 'OR',
        conditions: [{ displayName: what, conditionThreshold: { filter: `metric.type="${metricType(`portal_${kind}_${f.service}`)}" AND resource.type="cloud_run_revision"`,
          aggregations: P.aggregations, comparison: P.comparison, thresholdValue: P.thresholdValue, duration: P.duration, evaluationMissingData: P.evaluationMissingData } }],
        alertStrategy: { autoClose: P.autoClose }, notificationChannels: [channel], userLabels: { slice: 'd4-c2b', portal_function: f.service } });
    }
  }
  return out;
}

/* ── §6a thresholds — the deterministic rule over the trailing 30 days (synthetic entries excluded by the caller) ──────── */
const roundUpHalf = (s) => Math.ceil(s * 2 - 1e-9) / 2;
function p95(xs) { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; }
function thresholdFor(f, latenciesS) {
  const n = latenciesS.length;
  const max = n ? Math.max(...latenciesS) : null;
  if (n >= 20) return { n, value: roundUpHalf(Math.max(max, 1.5 * p95(latenciesS)) + 0.5), rule: 'n>=20', max, p95: p95(latenciesS) };
  if (n >= 5 && f.small_n_rule === 'observed_max') return { n, value: roundUpHalf(max + 0.5), rule: 'observed_max', max };
  return { n, value: f.default_s, rule: 'default', ...(n ? { max } : {}) };
}
const parseLatency = (s) => { const m = /^([0-9.]+)s$/.exec(String(s || '')); return m ? Number(m[1]) : null; };

/* ── idempotency: the fields WE set, compared; anything else the API adds is ignored ──────────────────────────────────── */
const pickMetric = (m) => ({ description: m.description, filter: m.filter, labelExtractors: m.labelExtractors || {}, valueExtractor: m.valueExtractor || '',
  bucketOptions: m.bucketOptions || null, kind: m.metricDescriptor && m.metricDescriptor.metricKind, type: m.metricDescriptor && m.metricDescriptor.valueType });
const pickPolicy = (p) => ({ combiner: p.combiner, conditions: (p.conditions || []).map((c) => ({ displayName: c.displayName, t: c.conditionThreshold || null, a: c.conditionAbsent || null })),
  autoClose: p.alertStrategy && p.alertStrategy.autoClose, channels: (p.notificationChannels || []).slice().sort() });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function diffMetrics(desired, installed) {
  const by = new Map(installed.map((m) => [m.name, m]));
  return desired.map((m) => ({ name: m.name, action: !by.has(m.name) ? 'create' : (same(pickMetric(m), pickMetric(by.get(m.name))) ? 'unchanged' : 'update') }));
}
function diffPolicies(desired, installed) {
  const by = new Map(installed.map((p) => [p.displayName, p]));
  return desired.map((p) => ({ displayName: p.displayName, action: !by.has(p.displayName) ? 'create' : (same(pickPolicy(p), pickPolicy(by.get(p.displayName))) ? 'unchanged' : 'update'),
    name: by.has(p.displayName) ? by.get(p.displayName).name : undefined }));
}

/* ── a minimal evaluator for the filter subset used above: `a.b="x"`, `a.b>n` / `<n` / `>=n`, `a.b>"Ns"`, `-labels.x="1"`,
   joined by AND. Anything outside the subset THROWS (the acceptance must never pass on a filter it cannot read). ─────── */
function getPath(o, p) { return p.split('.').reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o); }
function matches(filter, entry) {
  const terms = filter.split(' AND ');
  for (const raw of terms) {
    const neg = raw.startsWith('-'); const t = neg ? raw.slice(1) : raw;
    const m = /^([A-Za-z_][\w.]*)(>=|<=|=|>|<)(.+)$/.exec(t);
    if (!m) throw new Error(`filter term outside the evaluated subset: ${raw}`);
    const [, path, op, rhsRaw] = m;
    const v = getPath(entry, path);
    let ok;
    if (/^".*"$/.test(rhsRaw)) {
      const rhs = rhsRaw.slice(1, -1);
      const dur = /^([0-9.]+)s$/.exec(rhs);
      if (op === '=') ok = v !== undefined && String(v) === rhs;
      else if (dur) { const lv = parseLatency(v); ok = lv !== null && (op === '>' ? lv > Number(dur[1]) : op === '<' ? lv < Number(dur[1]) : op === '>=' ? lv >= Number(dur[1]) : lv <= Number(dur[1])); }
      else throw new Error(`unsupported string comparison: ${raw}`);
    } else {
      const rhs = Number(rhsRaw); if (!Number.isFinite(rhs)) throw new Error(`unsupported value: ${raw}`);
      const nv = typeof v === 'number' ? v : Number(v);
      ok = v !== undefined && Number.isFinite(nv) && (op === '>' ? nv > rhs : op === '<' ? nv < rhs : op === '>=' ? nv >= rhs : op === '<=' ? nv <= rhs : nv === rhs);
    }
    if (neg ? ok : !ok) return false;
  }
  return true;
}

module.exports = { SPEC, metricType, integrityStateFilter, heartbeatFilter, integrityMetrics, integrityPolicies, portalBase, thresholdPopulationFilter, portalMetrics, portalPolicies,
  thresholdFor, parseLatency, roundUpHalf, p95, diffMetrics, diffPolicies, matches, pickMetric, pickPolicy };
