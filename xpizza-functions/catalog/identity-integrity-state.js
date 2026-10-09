'use strict';
/* 1D D4-c2b — THE MONITOR STATE + REDUCER (PLAN-D4c2b rev 14 §4, §6, §9). PURE: every function takes the restaurant's node
   (the value at RTDB `catalog_integrity/{rid}`, or null) and returns the NEXT node; the monitor commits it inside ONE RTDB
   transaction on that node (never a root transaction). Being pure and idempotent, a retried or overlapping run converges.

   🔴 FINDINGS ARE STICKY UNTIL THE OWNER ACKNOWLEDGES THEM (owner option A). A finding, once recorded, stays `open`; if its
   condition later disappears it records `condition: cleared` + `cleared_obs_t` and STILL counts toward the alert. Only
   `ack()` (tools/ack-identity-finding.js) closes it. A condition that reappears after acknowledgement opens a NEW finding
   (its id includes the new first observation). `summary` is recomputed from the open findings in EVERY commit, so a crash
   between commit and logging only delays an alert, never loses it.

   obs_t: the observation's server time at FULL precision, as a fixed-width string "SSSSSSSSSSSS.NNNNNNNNN" (lexicographic
   order = time order); arithmetic uses its milliseconds. */
const { H } = require('./evidence-encoding');

const MIN = 60 * 1000;
const STALE_COVERAGE_MS = 45 * MIN;          // §6: active_ok / audit_ok older than 45 min
const STALE_ACTIVITY_MS = 120 * MIN;         // §4: an activity-deferral streak lasting > 2 h elapsed → stale{merchant_active}
const DEGRADED_ALERT_MS = 120 * MIN;         // §4: a degraded timer > 2 h opens a sticky `degraded` finding
const BACKLOG_MAX = 40;                      // §3: stale when backlog > 40 …
const BACKLOG_AGE_MS = 120 * MIN;            //      … or backlog_age > 2 h
const BACKOFF_BASE_MS = 15 * MIN;            // §4: retry_after = now + min(15 min × 2^failures, 2 h)
const BACKOFF_MAX_MS = 120 * MIN;
const GROWTH_FINDINGS = 2000;                // §9
const GROWTH_BYTES = 1024 * 1024;

// ── obs_t ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function obsT(ts) {   // a Firestore Timestamp (seconds, nanoseconds) → the fixed-width string
  const s = Number(ts.seconds); const n = Number(ts.nanoseconds);
  if (!Number.isSafeInteger(s) || s < 0 || !Number.isSafeInteger(n) || n < 0 || n > 999999999) throw new Error(`obs_t: bad timestamp ${JSON.stringify(ts)}`);
  return `${String(s).padStart(12, '0')}.${String(n).padStart(9, '0')}`;
}
const obsMs = (t) => { const [s, n] = String(t).split('.'); return Number(s) * 1000 + Math.floor(Number(n) / 1e6); };
const fromMs = (ms) => obsT({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });
const isObs = (t) => typeof t === 'string' && /^\d{12}\.\d{9}$/.test(t);

const clone = (x) => (x === null || x === undefined ? {} : JSON.parse(JSON.stringify(x)));
const counts0 = () => ({ open_violations: 0, open_gaps: 0, open_degraded: 0 });

function base(node) {
  const n = clone(node);
  n.coverage = n.coverage || {};
  n.findings = n.findings || {};
  n.timers = n.timers || {};
  n.summary = n.summary || counts0();
  return n;
}

// ── findings ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const openByCond = (n, cond) => Object.entries(n.findings).find(([, f]) => f.cond === cond && f.status === 'open');
// upsert ONE classifier finding observed at obs_t with the given scope
function observe(n, f, obs_t, scope) {
  const hit = openByCond(n, f.cond);
  if (hit) {
    const [, rec] = hit;
    rec.last_obs_t = obs_t; rec.condition = 'present'; delete rec.cleared_obs_t;
    return hit[0];
  }
  const id = H(`${f.cond}|${obs_t}`);
  n.findings[id] = { kind: f.kind, class: f.class, cond: f.cond, scope, subject: f.subject, detail: f.detail || {},
    status: 'open', condition: 'present', first_obs_t: obs_t, last_obs_t: obs_t };
  return id;
}
function recomputeSummary(n) {
  const s = counts0();
  for (const f of Object.values(n.findings)) {
    if (f.status !== 'open') continue;
    if (f.class === 'violation') s.open_violations += 1;
    else if (f.class === 'gap') s.open_gaps += 1;
    else if (f.class === 'degraded') s.open_degraded += 1;
  }
  n.summary = s;
  n.coverage.findings_count = Object.keys(n.findings).length;
  return n;
}

// ── §2 an ACTIVE result → applied only if newer than the stored observation ─────────────────────────────────────────
// result = classifyActive(...) + { obs_t, generation }.  → { node, applied }
function applyActive(node, result, { obs_t, generation }) {
  const n = base(node);
  if (n.active && isObs(n.active.obs_t) && !(obs_t > n.active.obs_t)) return { node: recomputeSummary(n), applied: false };
  n.active = { obs_t, generation, state: result.state, ...(result.reason ? { reason: result.reason } : {}) };
  if (!result.coverage) return { node: recomputeSummary(n), applied: true };
  // findings of THIS observation; every other open ACTIVE-scope finding no longer holds → condition cleared (stays open)
  const seen = new Set(result.findings.map((f) => observe(n, f, obs_t, 'active')));
  for (const [id, f] of Object.entries(n.findings)) {
    if (f.status === 'open' && f.scope === 'active' && !seen.has(id) && f.condition === 'present') { f.condition = 'cleared'; f.cleared_obs_t = obs_t; }
  }
  // degraded timers: open on first sight, close when a newer complete observation shows the pair clean or absent
  const now = new Set(result.degradedPairs);
  for (const p of now) if (!n.timers[p]) n.timers[p] = obs_t;
  for (const [p, since] of Object.entries(n.timers)) {
    const cond = H(`degraded|${p}|${since}`);
    if (!now.has(p)) {
      delete n.timers[p];
      const hit = openByCond(n, cond);
      if (hit && hit[1].condition === 'present') { hit[1].condition = 'cleared'; hit[1].cleared_obs_t = obs_t; }
      continue;
    }
    if (obsMs(obs_t) - obsMs(since) > DEGRADED_ALERT_MS) {
      observe(n, { kind: 'degraded', class: 'degraded', cond, subject: `pair:${p}`, detail: { since } }, obs_t, 'timer');
    }
  }
  completed(n, obs_t, 'active_ok_obs_t');
  syncBacklog(n);
  return { node: recomputeSummary(n), applied: true };
}

// a completed check resets failure/backoff and the activity-deferral streak
// §3 backlog, mirrored into the COMPACT coverage child (summary emission never reads the full node, §6/§9)
function syncBacklog(n) {
  const cur = n.active && Number.isSafeInteger(n.active.generation) ? n.active.generation : null;
  if (cur === null || !Number.isSafeInteger(n.audited_through)) { delete n.coverage.backlog; delete n.coverage.backlog_since_ms; return; }
  n.coverage.backlog = Math.max(0, cur - n.audited_through);
  if (n.coverage.backlog > 0 && n.backlog_anchor && Number.isFinite(n.backlog_anchor.since_ms)) n.coverage.backlog_since_ms = n.backlog_anchor.since_ms;
  else delete n.coverage.backlog_since_ms;
}
function completed(n, obs_t, key) {
  n.coverage[key] = obs_t;
  n.coverage.failures = 0;
  delete n.coverage.retry_after;
  n.coverage.active_streak = 0;
  delete n.coverage.active_streak_run_id;
  delete n.coverage.first_active_deferral_obs_t;
}

// ── §3 an AUDIT page → applied only if CONTIGUOUS (start == audited_through + 1); stale pages discarded whole ──────────
// page = { start, end, findings: [classifier findings], obs_t, current, head?: { g, at_ms } }  → { node, applied }
function applyAuditPage(node, page) {
  const n = base(node);
  const through = Number.isSafeInteger(n.audited_through) ? n.audited_through : null;
  if (through === null || page.start !== through + 1 || !(page.end >= page.start - 1)) return { node: recomputeSummary(n), applied: false };
  for (const f of page.findings) observe(n, f, page.obs_t, 'audit');
  n.audited_through = page.end;
  // backlog anchor: the oldest unaudited generation and since when it has been waiting
  if (page.end >= page.current) { delete n.backlog_anchor; n.coverage.audit_ok_obs_t = page.obs_t; }
  else {
    const g = page.end + 1;
    if (!n.backlog_anchor || n.backlog_anchor.g !== g) n.backlog_anchor = { g, since_ms: page.head && page.head.g === g && Number.isFinite(page.head.at_ms) ? page.head.at_ms : obsMs(page.obs_t) };
  }
  syncBacklog(n);
  return { node: recomputeSummary(n), applied: true };
}

// ── §4 deferrals ─────────────────────────────────────────────────────────────────────────────────────────────────────
// merchant_active: NOT a failure, no backoff, no coverage credit; the streak counts once per run id
function deferActive(node, { obs_t, runId }) {
  const n = base(node);
  if (n.coverage.active_streak_run_id !== runId) {
    n.coverage.active_streak = (n.coverage.active_streak || 0) + 1;
    n.coverage.active_streak_run_id = runId;
  }
  n.coverage.last_active_obs_t = obs_t;
  if (!n.coverage.first_active_deferral_obs_t) n.coverage.first_active_deferral_obs_t = obs_t;
  return recomputeSummary(n);
}
// a FAILED check, a BUDGET deferral or an unavailable result: failures += 1, retry_after = now + min(15 min × 2^failures, 2 h)
function deferFailure(node, { nowMs, reason }) {
  const n = base(node);
  const failures = (n.coverage.failures || 0) + 1;
  n.coverage.failures = failures;
  n.coverage.last_attempt_at = nowMs;
  n.coverage.retry_after = nowMs + Math.min(BACKOFF_BASE_MS * (2 ** failures), BACKOFF_MAX_MS);
  n.coverage.last_failure = String(reason || 'failed').slice(0, 80);
  return recomputeSummary(n);
}
function enumerated(node, { obs_t }) {
  const n = base(node);
  if (!n.coverage.first_enumerated_at) n.coverage.first_enumerated_at = obs_t;
  return recomputeSummary(n);
}

// ── §1 boundary: WRITE-ONCE; findings for g < G0 recorded while unknown are relabelled pre_boundary (kept) ────────────
function setBoundary(node, b) {
  const n = base(node);
  if (n.boundary) return { node: recomputeSummary(n), written: false };
  n.boundary = b;
  if (!Number.isSafeInteger(n.audited_through)) n.audited_through = b.G0 - 1;
  for (const f of Object.values(n.findings)) {
    if (f.kind === 'unattested' && f.detail && f.detail.reason === 'boundary_unknown' && Number.isSafeInteger(f.detail.generation) && f.detail.generation < b.G0) {
      f.detail.reason = 'pre_boundary';
    }
  }
  return { node: recomputeSummary(n), written: true };
}

// ── owner acknowledgement (tools/ack-identity-finding.js) — in the SAME transaction the summary is recomputed ─────────
function ack(node, findingId, { at, by, note }) {
  const n = base(node);
  const f = n.findings[findingId];
  if (!f) return { node: recomputeSummary(n), ok: false, reason: 'no_such_finding' };
  if (f.status !== 'open') return { node: recomputeSummary(n), ok: false, reason: 'already_acknowledged' };
  f.status = 'acknowledged';
  f.ack = { at, by: String(by).slice(0, 120), note: String(note).slice(0, 500) };
  return { node: recomputeSummary(n), ok: true };
}

// ── §9 growth: node_bytes is the SERIALIZED size, recorded with every commit ─────────────────────────────────────────
function withSize(node) {
  const n = base(node);
  n.coverage.node_bytes = 0;
  let prev = -1;
  // fixed point: the recorded size includes its own digits
  while (n.coverage.node_bytes !== prev) { prev = n.coverage.node_bytes; n.coverage.node_bytes = Buffer.byteLength(JSON.stringify(n)); }
  return n;
}

// ── §6 stale + the per-restaurant summary line (from the compact coverage + summary children only) ────────────────────
function staleOf({ coverage = {} } = {}, nowMs) {
  const reasons = [];
  const c = coverage;
  const streak = !!c.first_active_deferral_obs_t;
  if (streak && nowMs - obsMs(c.first_active_deferral_obs_t) > STALE_ACTIVITY_MS) reasons.push('merchant_active');
  if (!streak) {
    const firstSeen = c.first_enumerated_at ? obsMs(c.first_enumerated_at) : null;
    for (const k of ['active_ok_obs_t', 'audit_ok_obs_t']) {
      const t = c[k] ? obsMs(c[k]) : null;
      if (t !== null ? nowMs - t > STALE_COVERAGE_MS : (firstSeen !== null && nowMs - firstSeen > STALE_COVERAGE_MS)) { reasons.push('coverage_gap'); break; }
    }
  }
  if (Number.isSafeInteger(c.backlog)) {
    if (c.backlog > BACKLOG_MAX) reasons.push('backlog');
    else if (c.backlog > 0 && Number.isFinite(c.backlog_since_ms) && nowMs - c.backlog_since_ms > BACKLOG_AGE_MS) reasons.push('backlog_age');
  }
  if ((c.findings_count || 0) > GROWTH_FINDINGS || (c.node_bytes || 0) > GROWTH_BYTES) reasons.push('state_growth');
  return { stale: reasons.length ? 1 : 0, reasons };
}
// the ONE emitter (the alert acceptance serialises through it too, §6)
function summaryLine(rid, view, nowMs) {
  const s = (view && view.summary) || counts0();
  const st = staleOf(view || {}, nowMs);
  return { event: 'identity_integrity_state', rid, open_violations: s.open_violations || 0, open_gaps: s.open_gaps || 0,
    open_degraded: s.open_degraded || 0, stale: st.stale, ...(st.reasons.length ? { stale_reasons: st.reasons } : {}) };
}
const heartbeatLine = ({ enumerated: e, covered }) => ({ event: 'identity_integrity_heartbeat', enumerated: e, covered });

// scheduling: oldest active_ok first; a restaurant with retry_after in the future is skipped (§4)
function scheduleOrder(views, nowMs) {
  return views
    .filter((v) => !(v.coverage && Number.isFinite(v.coverage.retry_after) && v.coverage.retry_after > nowMs))
    .sort((a, b) => {
      const ta = a.coverage && a.coverage.active_ok_obs_t ? a.coverage.active_ok_obs_t : '';
      const tb = b.coverage && b.coverage.active_ok_obs_t ? b.coverage.active_ok_obs_t : '';
      return ta < tb ? -1 : (ta > tb ? 1 : (a.rid < b.rid ? -1 : (a.rid > b.rid ? 1 : 0)));
    })
    .map((v) => v.rid);
}

module.exports = {
  MIN, STALE_COVERAGE_MS, STALE_ACTIVITY_MS, DEGRADED_ALERT_MS, BACKLOG_MAX, BACKLOG_AGE_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
  GROWTH_FINDINGS, GROWTH_BYTES,
  obsT, obsMs, fromMs, isObs, applyActive, applyAuditPage, deferActive, deferFailure, enumerated, setBoundary, ack, withSize,
  recomputeSummary, staleOf, summaryLine, heartbeatLine, scheduleOrder,
};
