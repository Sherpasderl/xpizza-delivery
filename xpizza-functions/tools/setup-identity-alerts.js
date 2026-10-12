#!/usr/bin/env node
'use strict';
// 1D D4-c2b — install + accept the identity integrity alerts (§6) and the permanent portal-latency alarms (§6a). OWNER-RUN.
// DRY RUN unless --apply; idempotent (only creates / updates what differs); explicit project; a VERIFIED email channel required.
//
//   node tools/setup-identity-alerts.js --project xpizza-delivery --channel <notificationChannel name> thresholds
//   node tools/setup-identity-alerts.js --project xpizza-delivery --channel <name> plan                      (default; dry run)
//   node tools/setup-identity-alerts.js --project xpizza-delivery --channel <name> install                  (metrics → policies; the job may be PAUSED)
//   node tools/setup-identity-alerts.js --project xpizza-delivery --channel <name> arm                      (AFTER resume: a heartbeat METRIC POINT
//                                                                                                            ingested after the policy change + the
//                                                                                                            §6 revision-transition acceptance)
//   node tools/setup-identity-alerts.js --project xpizza-delivery --channel <name> accept-integrity         (§6 acceptance 1)
//   node tools/setup-identity-alerts.js --project xpizza-delivery --channel <name> accept-absence           (§6 acceptance 2 — GUIDED MANUAL:
//                                                                                                            the OWNER pauses/resumes; the tool only
//                                                                                                            reads the scheduler state)
//   node tools/setup-identity-alerts.js --project xpizza-delivery --channel <name> accept-portal <function> (§6a acceptance)
//
// The bodies are built ONLY from tools/identity-alerts.json (tools/identity-alerts-core.js); thresholds by the plan's rule over the
// trailing 30 days of that function's Cloud Run request logs (synthetic c2b_acceptance entries excluded), printed with n / dates /
// method / status for the hand-back record. HONEST LIMIT: Cloud Monitoring exposes no incidents API, so "an incident opened /
// stayed open / closed" is checked on the policy's OWN aggregated series (same aligner + reducer, via timeSeries.list) and the
// owner CONFIRMS the open / close emails at the prompts; both are recorded in the transcript the tool prints.
const readline = require('readline');
const A = require('./identity-alerts-core');
const S = require('../catalog/identity-integrity-state');

const LOGGING = 'https://logging.googleapis.com/v2';
const MONITORING = 'https://monitoring.googleapis.com/v3';
const SCHEDULER = 'https://cloudscheduler.googleapis.com/v1';
const JOB = (project, region) => `projects/${project}/locations/${region}/jobs/firebase-schedule-verifyIdentityIntegrity-${region}`;
const MIN = 60 * 1000;

function makeApi(project, { fetchImpl = fetch, token } = {}) {
  async function call(method, url, body) {
    const t = await token();
    const r = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); const json = text ? JSON.parse(text) : {};
    if (!r.ok) { const e = new Error(`${method} ${url} → ${r.status} ${json.error ? json.error.message : text}`); e.status = r.status; throw e; }
    return json;
  }
  const P = `projects/${project}`;
  return {
    listMetrics: async () => (await call('GET', `${LOGGING}/${P}/metrics?pageSize=500`)).metrics || [],
    createMetric: (m) => call('POST', `${LOGGING}/${P}/metrics`, m),
    updateMetric: (m) => call('PUT', `${LOGGING}/${P}/metrics/${encodeURIComponent(m.name)}`, m),
    listPolicies: async () => (await call('GET', `${MONITORING}/${P}/alertPolicies?pageSize=500`)).alertPolicies || [],
    createPolicy: (p) => call('POST', `${MONITORING}/${P}/alertPolicies`, p),
    updatePolicy: (name, p) => call('PATCH', `${MONITORING}/${name}`, p),
    getChannel: (name) => call('GET', `${MONITORING}/${name}`),
    listEntries: async (filter, { pageSize = 1000, orderBy = 'timestamp desc', maxPages = 50 } = {}) => {
      const out = []; let pageToken;
      for (let i = 0; i < maxPages; i += 1) {
        const r = await call('POST', `${LOGGING}/entries:list`, { resourceNames: [P], filter, orderBy, pageSize, pageToken });
        out.push(...(r.entries || [])); pageToken = r.nextPageToken; if (!pageToken) break;
      }
      return out;
    },
    writeEntries: (entries) => call('POST', `${LOGGING}/entries:write`, { entries, partialSuccess: false }),
    timeSeries: async (filter, aggregation, startMs, endMs) => (await call('GET', `${MONITORING}/${P}/timeSeries?${new URLSearchParams({ filter,
      'interval.startTime': new Date(startMs).toISOString(), 'interval.endTime': new Date(endMs).toISOString(),
      'aggregation.alignmentPeriod': aggregation.alignmentPeriod, 'aggregation.perSeriesAligner': aggregation.perSeriesAligner,
      'aggregation.crossSeriesReducer': aggregation.crossSeriesReducer, ...(aggregation.groupByFields || []).reduce((o, f, i) => ({ ...o, [`aggregation.groupByFields[${i}]`]: f }), {}) })}`)).timeSeries || [],
    // READ-ONLY on the scheduler (advisor ruling, codex build r3 P1-A / P1-3): this tool never pauses or resumes the job — only
    // the OWNER changes scheduler state, so an incident pause is never overridden and no request of ours can land late
    getJob: (region) => call('GET', `${SCHEDULER}/${JOB(project, region)}`),
  };
}

/* §6a thresholds over the trailing 30 days — the recorded basis (n, dates, method/status) printed for the hand-back */
async function computeThresholds(api, project, { nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - 30 * 24 * 60 * MIN).toISOString();
  const out = {};
  for (const f of A.SPEC.portal.functions) {
    const entries = await api.listEntries(`${A.thresholdPopulationFilter(f, project)} AND timestamp>="${since}"`);
    const lat = entries.map((e) => A.parseLatency(e.httpRequest && e.httpRequest.latency)).filter((x) => x !== null);
    const t = A.thresholdFor(f, lat);
    const times = entries.map((e) => e.timestamp).sort();
    const statuses = [...new Set(entries.map((e) => e.httpRequest && e.httpRequest.status))].sort();
    out[f.name] = { ...t, method: f.method, statuses, from: times[0] || null, to: times[times.length - 1] || null, since };
  }
  return out;
}

async function plan(api, project, channel, thresholds) {
  const ch = await api.getChannel(channel);
  if (ch.type !== 'email' || ch.verificationStatus !== 'VERIFIED') throw new Error(`channel ${channel} must be a VERIFIED email channel (type ${ch.type}, ${ch.verificationStatus})`);
  const metrics = [...A.integrityMetrics(), ...A.portalMetrics(project, Object.fromEntries(Object.entries(thresholds).map(([k, v]) => [k, v.value])))];
  const policies = [...A.integrityPolicies(channel), ...A.portalPolicies(channel, Object.fromEntries(Object.entries(thresholds).map(([k, v]) => [k, v.value])))];
  const [im, ip] = await Promise.all([api.listMetrics(), api.listPolicies()]);
  return { metrics, policies, metricDiff: A.diffMetrics(metrics, im), policyDiff: A.diffPolicies(policies, ip) };
}
// INSTALL (§6 arming order, first half): metrics → policies; only what differs is written. Needs NO heartbeat — the rollout installs
// and accepts the portal alarms while the scheduler job is still PAUSED (§10; codex build r1 P1-4). Arming is the separate `arm`.
async function apply(api, p) {
  const done = [];
  for (const d of p.metricDiff) {
    const m = p.metrics.find((x) => x.name === d.name);
    if (d.action === 'create') { await api.createMetric(m); done.push(`metric create ${m.name}`); }
    if (d.action === 'update') { await api.updateMetric(m); done.push(`metric update ${m.name}`); }
  }
  for (const d of p.policyDiff) {
    const pol = p.policies.find((x) => x.displayName === d.displayName);
    if (d.action === 'create') { await api.createPolicy(pol); done.push(`policy create ${pol.displayName}`); }
    if (d.action === 'update') { await api.updatePolicy(d.name, pol); done.push(`policy update ${pol.displayName}`); }
  }
  return done;
}

// a COMPLETE request-log resource copied from a REAL entry of the service (all five labels asserted)
async function realResource(api, project, service, logSuffix) {
  const [e] = await api.listEntries(`resource.type="cloud_run_revision" AND resource.labels.service_name="${service}"${logSuffix ? ` AND logName="projects/${project}/logs/${logSuffix}"` : ''}`, { pageSize: 1, maxPages: 1 });
  if (!e) throw new Error(`no real log entry for ${service} to copy the resource from`);
  for (const k of ['service_name', 'revision_name', 'configuration_name', 'location', 'project_id']) if (!e.resource.labels[k]) throw new Error(`real entry for ${service} lacks resource label ${k}`);
  return { resource: e.resource, logName: e.logName };
}

/* ── bounded primitives (codex build r1 P1-5): every API call, prompt and wait has a deadline ──────────────────────────── */
function bounded(p, ms, label) {
  let t = null;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label}_timeout`), { timeout: true })), Math.max(0, ms)); })])
    .finally(() => clearTimeout(t));
}
// every method of the API, raced against `ms`
const boundedApi = (api, ms) => new Proxy(api, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => bounded(t[k](...a), ms, `api_${String(k)}`) : t[k]) });
// a prompt that gives up at `ms` → null (unanswered), closing it if it can be cancelled; it never blocks a deadline
const askBounded = (ask, q, ms) => { const p = ask(q); return bounded(p, ms, 'prompt').catch((e) => { if (e && e.timeout) { if (p && typeof p.cancel === 'function') p.cancel(); return null; } throw e; }); };

const HB_POLICY = 'D4-c2b identity integrity: heartbeat absent 45 min';
const heartbeatSeries = (api, fromMs, toMs) => api.timeSeries(`metric.type="${A.metricType(A.SPEC.integrity.heartbeat_metric)}" AND resource.type="cloud_run_revision"`,
  A.SPEC.integrity.heartbeat_policy.aggregations[0], fromMs, toMs);
const positivePointAfter = (series, tMs) => series.some((x) => (x.points || []).some((pt) => Number((pt.value && pt.value.int64Value) || 0) > 0
  && Date.parse((pt.interval && pt.interval.endTime) || 0) >= tMs));

/* ARM (§6, after the job is RESUMED; codex build r1 P1-4): (1) the job is ENABLED; (2) a heartbeat METRIC POINT — not merely a raw log
   entry — was ingested AFTER the absence policy's last change; (3) the REVISION TRANSITION acceptance: the owner redeploys the
   unchanged function, a heartbeat arrives from the NEW revision, and the service-level series shows no 45-min gap (no absence
   incident), which the owner confirms. Every wait and prompt is bounded. */
async function arm({ api, region, project, now = Date.now, sleep, ask, log = console.log, waitMs = 30 * MIN, pollMs = MIN, transitionMs = 90 * MIN, askMs = 15 * MIN }) {
  const job = await api.getJob(region);
  if (job.state !== 'ENABLED') throw new Error(`the job is ${job.state} — resume it first (arming verifies a LIVE heartbeat)`);
  const pol = (await api.listPolicies()).find((x) => x.displayName === HB_POLICY);
  if (!pol) throw new Error('the heartbeat absence policy is not installed — run install first');
  const tPolicy = Date.parse((pol.mutationRecord && pol.mutationRecord.mutateTime) || (pol.creationRecord && pol.creationRecord.mutateTime) || 0);
  if (!(tPolicy > 0)) throw new Error('cannot read the heartbeat policy\'s last change time');
  const until = now() + waitMs;
  for (;;) {
    if (positivePointAfter(await heartbeatSeries(api, tPolicy, now()), tPolicy)) break;
    if (now() >= until) throw new Error(`no heartbeat METRIC POINT ingested after the policy change (${new Date(tPolicy).toISOString()}) within ${Math.round(waitMs / MIN)} min — NOT armed`);
    await sleep(Math.min(pollMs, Math.max(0, until - now())));
  }
  log(`  ✓ armed: a heartbeat metric point was ingested after the policy change at ${new Date(tPolicy).toISOString()}`);
  // the revision transition (§6 acceptance): redeploy the UNCHANGED function → a heartbeat from the new revision, no absence incident
  const [last] = await api.listEntries(A.heartbeatFilter(), { pageSize: 1, maxPages: 1 });
  if (!last) throw new Error('no heartbeat log entry to take the current revision from');
  const rev0 = last.resource.labels.revision_name; const t0 = now();
  log(`  current revision ${rev0}. NOW redeploy the UNCHANGED function:\n    firebase deploy --only functions:verifyIdentityIntegrity --project ${project}`);
  const tEnd = t0 + transitionMs; let seen = null;
  while (!seen) {
    const [e] = await api.listEntries(`${A.heartbeatFilter()} AND resource.labels.revision_name!="${rev0}" AND timestamp>="${new Date(t0).toISOString()}"`, { pageSize: 1, maxPages: 1 });
    if (e) seen = e; else { if (now() >= tEnd) throw new Error(`no heartbeat from a new revision within ${Math.round(transitionMs / MIN)} min`); await sleep(Math.min(pollMs, Math.max(0, tEnd - now()))); }
  }
  log(`  ✓ heartbeat from the new revision ${seen.resource.labels.revision_name} at ${seen.timestamp}`);
  /* the service-level series ACROSS the transition (codex build r2 P2-D): ingested positive points must exist on BOTH sides of the
     new revision's first heartbeat — the last point at/before it and a point after it (waited for, bounded: ingestion lags) — and no
     two consecutive points from t0 − 45 min to the last one may be ≥ 45 min apart. An empty or one-sided series never passes. */
  const tNew = Date.parse(seen.timestamp);
  const positives = async () => (await heartbeatSeries(api, t0 - 45 * MIN, now())).flatMap((x) => (x.points || []).filter((pt) => Number((pt.value && pt.value.int64Value) || 0) > 0)
    .map((pt) => Date.parse(pt.interval.endTime))).filter(Number.isFinite).sort((a, b) => a - b);
  let pts = await positives();
  const pEnd = now() + waitMs;
  while (!pts.some((t) => t > tNew)) {
    if (now() >= pEnd) throw new Error(`no ingested heartbeat METRIC POINT after the new revision's first heartbeat (${seen.timestamp}) within ${Math.round(waitMs / MIN)} min — continuity NOT shown`);
    await sleep(Math.min(pollMs, Math.max(0, pEnd - now()))); pts = await positives();
  }
  if (!pts.some((t) => t <= tNew)) throw new Error('no ingested heartbeat METRIC POINT before the revision transition — continuity NOT shown');
  for (let i = 1; i < pts.length; i += 1) if (pts[i] - pts[i - 1] >= 45 * MIN) throw new Error('the service-level heartbeat series has a ≥ 45-min gap across the revision transition');
  const answer = await askBounded(ask, '  Did an ABSENCE incident email arrive during the redeploy? (expected NO)', askMs);
  if (answer === null) throw new Error('the owner did not confirm (no answer) — revision-transition acceptance NOT passed');
  if (answer) throw new Error('an absence incident opened on a revision transition');
  log('  ✓ revision-transition acceptance PASSED (no absence incident; series continuous across revisions)');
  return { armedAfter: tPolicy, revisions: [rev0, seen.resource.labels.revision_name] };
}

/* §6 acceptance (2) ABSENCE — a GUIDED MANUAL step (advisor ruling on codex build r3 P1-A + P1-3). The tool NEVER changes the
   scheduler: the OWNER pauses and resumes it with the printed gcloud commands, and the tool only READS the job's state to verify.
     1. the job must be ENABLED at the start (else REFUSED — never start from a paused or unknown scheduler, e.g. an incident pause);
     2. print the exact pause command; wait (bounded) and VERIFY the state reads PAUSED;
     3. drain the in-flight invocation; the absence clock starts at the LAST ingested heartbeat, re-read after draining;
     4. wait for the absence email until an INDEPENDENT deadline (each prompt bounded);
     5. print the exact resume command; wait (bounded) and VERIFY ENABLED.
   On a timeout or an error it never resumes on its own: it prints the CURRENT state and the resume command, loudly, and fails. */
const schedulerCmd = (verb, region, project) => `gcloud scheduler jobs ${verb} firebase-schedule-verifyIdentityIntegrity-${region} --location ${region}${project ? ` --project ${project}` : ''}`;
async function acceptAbsence({ api, region, project, now = Date.now, sleep, ask, log = console.log, drainMs = 6 * MIN, totalMs = 80 * MIN, passMs = 70 * MIN, askMs = 5 * MIN,
  pauseWaitMs = 15 * MIN, resumeWaitMs = 15 * MIN, pollMs = 30 * 1000 }) {
  const stateNow = async () => { try { return (await api.getJob(region)).state || 'UNKNOWN'; } catch (e) { return `UNKNOWN (${(e && e.message) || e})`; } };
  const waitFor = async (want, ms) => {
    const until = now() + ms; let st = await stateNow();
    while (st !== want && now() < until) { await sleep(Math.min(pollMs, Math.max(0, until - now()))); st = await stateNow(); }
    return st;
  };
  const loud = async (why) => {
    const st = await stateNow();
    log(`\n  ‼ ${why}\n  ‼ SCHEDULER STATE NOW: ${st}\n  ‼ If it is not ENABLED, the OWNER resumes it:\n      ${schedulerCmd('resume', region, project)}\n`);
  };
  const start = await stateNow();
  if (start !== 'ENABLED') throw new Error(`REFUSED — the job is ${start}; absence acceptance starts only from ENABLED (it never touches a paused job — e.g. an incident pause)`);
  const [first] = await api.listEntries(A.heartbeatFilter(), { pageSize: 1, maxPages: 1 });
  if (!first) throw new Error('no heartbeat ingested yet');
  log(`  last ingested heartbeat: ${first.timestamp}`);
  let ok = false;
  try {
    log(`  OWNER: pause the job now (this tool never does):\n      ${schedulerCmd('pause', region, project)}`);
    const paused = await waitFor('PAUSED', pauseWaitMs);
    if (paused !== 'PAUSED') throw new Error(`the job did not read PAUSED within ${Math.round(pauseWaitMs / MIN)} min (state ${paused})`);
    log('  ✓ verified PAUSED; draining any in-flight invocation…');
    await sleep(drainMs);
    const [last] = await api.listEntries(A.heartbeatFilter(), { pageSize: 1, maxPages: 1 });
    const t0 = Date.parse((last || first).timestamp);
    log(`  last ingested heartbeat (after draining): ${(last || first).timestamp} — the absence clock starts there`);
    const deadline = t0 + totalMs;
    while (now() < deadline) {
      const a = await askBounded(ask, `  (${Math.round((now() - t0) / MIN)} min since the last heartbeat) Has the ABSENCE email arrived?`, Math.min(askMs, Math.max(1, deadline - now())));
      if (a === true) { ok = now() - t0 <= passMs; break; }
      if (now() < deadline && a === false) await sleep(Math.min(askMs, Math.max(0, deadline - now())));
    }
    log(`  OWNER: resume the job now:\n      ${schedulerCmd('resume', region, project)}`);
    const resumed = await waitFor('ENABLED', resumeWaitMs);
    if (resumed !== 'ENABLED') throw new Error(`the job did not read ENABLED within ${Math.round(resumeWaitMs / MIN)} min (state ${resumed})`);
    log('  ✓ verified ENABLED');
  } catch (e) {
    await loud(`absence acceptance STOPPED: ${(e && e.message) || e}`);
    throw e;
  }
  if (!ok) throw new Error('no absence email within 45 + 25 min of the last ingested heartbeat');
  log('  ✓ acceptance (2) PASSED');
  return { ok };
}

module.exports = { makeApi, computeThresholds, plan, apply, install: apply, arm, acceptAbsence, bounded, boundedApi, askBounded, realResource, JOB, HB_POLICY };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const channel = val('--channel');
  if (!channel) { console.error('setup-identity-alerts: REFUSED — --channel projects/<p>/notificationChannels/<id> (a VERIFIED email channel) is required'); process.exit(2); }
  const mode = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['--project', '--channel'].includes(argv[i - 1])))[0] || 'plan';
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const api = boundedApi(makeApi(PROJECT_ID, { token: async () => { const t = await (await auth.getClient()).getAccessToken(); return t.token || t; } }), 2 * MIN);   // every API call bounded
  // a prompt that can be CANCELLED (askBounded closes it at its deadline, so an unanswered prompt never holds the process)
  const ask = (q) => { let rl; const p = new Promise((res) => { rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(`${q} [y/N] `, (a) => { rl.close(); res(/^y/i.test(a)); }); }); p.cancel = () => { try { rl.close(); } catch (_) {} }; return p; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const region = A.SPEC.region;
  (async () => {
    const thresholds = await computeThresholds(api, PROJECT_ID);
    console.log('§6a thresholds (trailing 30 days, synthetic excluded):');
    for (const [k, v] of Object.entries(thresholds)) console.log(`  ${k.padEnd(19)} ${v.method} ${String(v.value).padStart(4)} s  rule ${v.rule}  n ${v.n}  max ${v.max ?? '-'}  p95 ${v.p95 ?? '-'}  statuses ${JSON.stringify(v.statuses)}  ${v.from || '-'} … ${v.to || '-'}`);
    if (mode === 'thresholds') process.exit(0);
    const p = await plan(api, PROJECT_ID, channel, thresholds);
    for (const d of p.metricDiff) console.log(`  metric ${d.action.padEnd(9)} ${d.name}`);
    for (const d of p.policyDiff) console.log(`  policy ${d.action.padEnd(9)} ${d.displayName}`);
    if (mode === 'plan') { console.log('(dry run — run `apply` to write)'); process.exit(0); }
    if (mode === 'install' || mode === 'apply') {
      const done = await apply(api, p);
      console.log(done.length ? done.map((x) => `  ✓ ${x}`).join('\n') : '  nothing to change (idempotent)');
      console.log('  installed — NOT YET ARMED. After the job is resumed (§10), run: … arm');
      process.exit(0);
    }
    if (mode === 'arm') { await arm({ api, region, project: PROJECT_ID, sleep, ask }); process.exit(0); }
    if (mode === 'accept-integrity') {
      // (1) the SAME emitter serialises the line; it must match the INSTALLED filter before anything is written
      const line = S.summaryLine('_acceptance', { coverage: {}, summary: { open_violations: 1, open_gaps: 0, open_degraded: 0 } }, Date.now());
      const installed = (await api.listMetrics()).find((m) => m.name === 'identity_integrity_open_violations');
      if (!installed) throw new Error('metric identity_integrity_open_violations not installed — run apply first');
      const { resource, logName } = await realResource(api, PROJECT_ID, A.SPEC.integrity.service, null);
      const entry = () => ({ logName, resource, jsonPayload: S.summaryLine('_acceptance', { coverage: {}, summary: { open_violations: 1, open_gaps: 0, open_degraded: 0 } }, Date.now()), labels: { c2b_acceptance: '1' }, timestamp: new Date().toISOString() });
      if (!A.matches(installed.filter, entry())) throw new Error('the emitter\'s line does NOT match the installed filter');
      console.log(`  ✓ emitter line ${JSON.stringify(line)} matches the installed filter`);
      const pol = A.SPEC.integrity.state_policy.aggregations[0];
      const series = async () => api.timeSeries(`metric.type="${A.metricType('identity_integrity_open_violations')}" AND metric.label.rid="_acceptance"`, pol, Date.now() - 30 * MIN, Date.now());
      const start = Date.now();
      for (let i = 0; i <= 4; i += 1) {
        await api.writeEntries([entry()]); console.log(`  wrote positive line ${i + 1}/5 at ${new Date().toISOString()}`);
        if (i === 0) { if (!(await ask('  Has the incident EMAIL arrived (wait ≤ 10 min)?'))) throw new Error('no open email within 10 min'); }
        if (i < 4) { await sleep(15 * MIN); const s = await series(); const v = s.length ? Number(s[0].points[0].value.int64Value || 0) : 0; console.log(`  rolling 30-min sum = ${v}`); if (!(v > 0)) throw new Error('the policy series dropped to 0 while positives were still arriving (the incident would close)'); }
      }
      if (await ask('  Did any CLOSE (resolved) email arrive during these 60 min?')) throw new Error('the incident closed while positive lines were arriving');
      console.log(`  stopped writing at ${new Date().toISOString()} (as acknowledgement would); the incident must close within 45 min`);
      if (!(await ask('  Has the CLOSE email arrived within 30 + 15 min of the last positive?'))) throw new Error('no close within 45 min');
      if (await ask('  After waiting 45 more min: did it REOPEN?')) throw new Error('reopened');
      console.log(`  ✓ acceptance (1) PASSED in ${Math.round((Date.now() - start) / MIN)} min`);
      process.exit(0);
    }
    if (mode === 'accept-absence') { await acceptAbsence({ api, region, project: PROJECT_ID, sleep, ask }); process.exit(0); }
    if (mode === 'accept-portal') {
      const fname = argv[argv.indexOf('accept-portal') + 1];
      const f = A.SPEC.portal.functions.find((x) => x.name === fname);
      if (!f) throw new Error(`accept-portal <function>: one of ${A.SPEC.portal.functions.map((x) => x.name).join(', ')}`);
      const thr = thresholds[f.name].value;
      const { resource, logName } = await realResource(api, PROJECT_ID, f.service, A.SPEC.portal.request_log);
      const mk = (status, latencyS, revision = resource.labels.revision_name) => ({ logName, resource: { ...resource, labels: { ...resource.labels, revision_name: revision } },
        httpRequest: { requestMethod: f.method, status, latency: `${latencyS}s` }, labels: { [A.SPEC.portal.synthetic_label]: '1' }, timestamp: new Date().toISOString(), insertId: `c2b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
      // read back the shape, then check the real counts in the current window are 0
      const probe = mk(200, 0.01); await api.writeEntries([probe]); await sleep(30 * 1000);
      const [back] = await api.listEntries(`insertId="${probe.insertId}"`, { pageSize: 1, maxPages: 1 });
      if (!back || !back.httpRequest || back.resource.type !== 'cloud_run_revision') throw new Error('synthetic entry did not read back with its shape');
      for (const k of ['service_name', 'revision_name', 'configuration_name', 'location', 'project_id']) if (back.resource.labels[k] !== resource.labels[k]) throw new Error(`read-back label ${k} differs`);
      console.log('  ✓ synthetic entry read back with the complete resource (5 labels) and httpRequest');
      const slowFilter = `metric.type="${A.metricType(`portal_slow_${f.service}`)}"`; const errFilter = `metric.type="${A.metricType(`portal_error_${f.service}`)}"`;
      const sum = async (filter, agg, windowMs) => { const s = await api.timeSeries(filter, agg, Date.now() - windowMs, Date.now()); return s.reduce((a, x) => a + Number((x.points[0] && x.points[0].value.int64Value) || 0), 0); };
      if (await sum(slowFilter, A.SPEC.portal.slow_policy.aggregations[0], 60 * MIN) > 0 || await sum(errFilter, A.SPEC.portal.error_policy.aggregations[0], 15 * MIN) > 0) throw new Error('real slow / 5xx requests in the current window — wait for it to clear');
      await api.writeEntries([mk(200, thr + 0.5)]);
      if (await ask('  1 slow request written — did an incident email arrive within 10 min? (expected NO)')) throw new Error('1 slow opened an incident');
      await api.writeEntries([mk(200, thr + 0.5, `${resource.labels.revision_name}-c2b2`)]);   // a second revision label: must aggregate with the first
      if (!(await ask('  2nd slow request (another revision label) written — email within 10 min? (expected YES)'))) throw new Error('2 slow within 1 h did not page (or revisions did not aggregate)');
      await api.writeEntries([mk(503, 0.2), mk(503, 0.2)]);
      if (await ask('  2 × 5xx written — email? (expected NO)')) throw new Error('2 × 5xx paged');
      await api.writeEntries([mk(503, 0.2)]);
      if (!(await ask('  3rd 5xx within 15 min — email? (expected YES)'))) throw new Error('3 × 5xx did not page');
      const dist = await api.timeSeries(`metric.type="${A.metricType(`portal_latency_${f.service}`)}"`, { alignmentPeriod: '3600s', perSeriesAligner: 'ALIGN_DELTA', crossSeriesReducer: 'REDUCE_NONE' }, Date.now() - 60 * MIN, Date.now());
      if (!dist.length) throw new Error('the latency distribution ingested nothing');
      console.log('  ✓ latency distribution ingested; now wait for both windows to empty and confirm the CLOSE emails');
      if (!(await ask('  Did BOTH incidents close after their windows emptied?'))) throw new Error('incidents did not close');
      console.log(`  ✓ §6a acceptance PASSED for ${f.name} (threshold ${thr} s)`); process.exit(0);
    }
    throw new Error(`unknown mode ${mode}`);
  })().catch((e) => { console.error('setup-identity-alerts: FAILED —', e && e.message); process.exit(1); });
}
