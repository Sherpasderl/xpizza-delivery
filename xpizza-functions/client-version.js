'use strict';
// ── P-SELFUPDATE §4 — the VERSION HEARTBEAT (reportClientVersion) + its sweep ─────────────────────────────────────
//
// A page reports {app, deployment, context, build, compat, instance}. Reports are UNTRUSTED observations, never
// authority: nothing here gates an order, a write or a floor. They feed the owner's coverage report and the D4-c
// go/no-go (PLAN §6).
//
// ORDER OF WORK, and why:
//   1. STRICT SCHEMA before any database work — known app; (app, deployment, context) must be EXACTLY a manifest
//      combination; context a registered restaurant (the warmed registry) or `platform`; compat an integer in
//      [1, the app's current generation]; build/instance path-safe and bounded. Bounded cardinality: `build` is stored
//      ONLY in the live instance record, never as a counter key.
//   2. A DEDICATED limiter (`client_version_limits/{ipKey}`), NOT the order buckets under rate_limits (the order IP
//      bucket allows 20 / 10 min and must never be consumed by telemetry). Unlike checkRateLimit, which FAILS OPEN on a
//      database error (right for orders), this entry point returns an explicit {allowed, failed}: `failed` → the report
//      is DROPPED (telemetry is never worth an unbounded write).
//   3. ONE multi-path update: the live instance record (server time) + the HOURLY counter
//      client_version_stats/{hour}/{deployment}/{context}/{compat} (ServerValue.increment).
//
// The SWEEP (scheduled): indexed (`.indexOn` last_seen / window_start), bounded batches, CONDITIONAL deletes (a record
// is removed only if it is still expired at delete time — a page that reported meanwhile keeps its record). Hourly
// counters older than the retention are removed by key.
const { rateLimitKey } = require('./order-dedup');
const { PLATFORM_CONTEXT, ID_RE } = require('./platform-manifest');

const HEARTBEAT_LIMIT = { windowMs: 10 * 60 * 1000, max: 120 };   // per IP; ≈1 report / 10 min / visible tab + wakes
const LIVE_WINDOW_MS = 30 * 60 * 1000;                              // "live" in the owner report
const INSTANCE_TTL_MS = 24 * 60 * 60 * 1000;                        // instance records are swept after a day of silence
const STATS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;                // hourly counters kept 30 days (PLAN §4)
const SWEEP_BATCH = 200;
const SWEEP_MAX_BATCHES = 10;
const BUILD_RE = /^[A-Za-z0-9._-]{1,80}$/;
const INSTANCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DIAG = new Set(['kitchen_floor_refusal']);                    // a module KDS's below-floor RTDB denial (PLAN §5)

const pad = (n, w = 2) => String(n).padStart(w, '0');
// UTC hour bucket key, sortable as a string: YYYYMMDDHH
function hourKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}

// → { ok: true, report } | { ok: false, error }
function validateReport(body, platform, knownContexts) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body' };
  const allowed = new Set(['app', 'deployment', 'context', 'build', 'compat', 'instance', 'diag']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, error: `unknown_field` };
  const { app, deployment, context, build, compat, instance, diag } = body;
  if (typeof app !== 'string' || !ID_RE.test(app) || !platform.isKnownApp(app)) return { ok: false, error: 'app' };
  if (typeof deployment !== 'string' || !ID_RE.test(deployment)) return { ok: false, error: 'deployment' };
  if (typeof context !== 'string') return { ok: false, error: 'context' };
  if (!platform.isValidCombination(app, deployment, context)) return { ok: false, error: 'combination' };
  if (context !== PLATFORM_CONTEXT && !(knownContexts && knownContexts.has(context))) return { ok: false, error: 'context' };
  if (typeof build !== 'string' || !BUILD_RE.test(build)) return { ok: false, error: 'build' };
  if (!Number.isInteger(compat) || compat < 1 || compat > platform.maxCompat(app)) return { ok: false, error: 'compat' };
  if (typeof instance !== 'string' || !INSTANCE_RE.test(instance)) return { ok: false, error: 'instance' };
  if (diag !== undefined && !DIAG.has(diag)) return { ok: false, error: 'diag' };
  return { ok: true, report: { app, deployment, context, build, compat, instance, ...(diag ? { diag } : {}) } };
}

// The heartbeat's OWN limiter entry point. Same fixed-window transaction as checkRateLimit, but a database error is
// reported, not hidden: { allowed, failed, retryAfterSec }.
async function checkHeartbeatLimit(db, rawKey, cfg = HEARTBEAT_LIMIT, now = Date.now()) {
  if (!rawKey) return { allowed: false, failed: true, retryAfterSec: 0 };
  const ref = db.ref(`client_version_limits/${rateLimitKey(rawKey)}`);
  try {
    const res = await ref.transaction((cur) => {
      if (!cur || now - cur.window_start >= cfg.windowMs) return { count: 1, window_start: now };
      if (cur.count >= cfg.max) return;                       // over the limit → abort, no write
      return { count: cur.count + 1, window_start: cur.window_start };
    });
    if (res.committed) return { allowed: true, failed: false, retryAfterSec: 0 };
    const v = res.snapshot.val();
    return { allowed: false, failed: false, retryAfterSec: v ? Math.max(1, Math.ceil((v.window_start + cfg.windowMs - now) / 1000)) : 1 };
  } catch (e) {
    console.error('client_version_limit_failed', e && e.message);
    return { allowed: false, failed: true, retryAfterSec: 0 };
  }
}

async function recordReport(db, ServerValue, r, now = Date.now()) {
  const hour = hourKey(now);
  const updates = {
    [`client_versions/${r.app}/${r.instance}`]: { deployment: r.deployment, context: r.context, build: r.build, compat: r.compat, last_seen: ServerValue.TIMESTAMP },
    [`client_version_stats/${hour}/${r.deployment}/${r.context}/${r.compat}`]: ServerValue.increment(1),
  };
  if (r.diag) updates[`client_version_stats/${hour}/diag/${r.diag}/${r.deployment}/${r.compat}`] = ServerValue.increment(1);
  await db.ref().update(updates);
}

// The HTTP handler body. deps: { db, ServerValue, platform, registry, now }
async function handleReport(req, res, deps) {
  if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  let known = null;
  const body = req.body;
  // the registry is consulted only when the context names a restaurant (warmed once per instance, bounded)
  if (body && typeof body.context === 'string' && body.context !== PLATFORM_CONTEXT && deps.registry) {
    try { await deps.registry.ready(); known = deps.registry.known(); } catch (_) { known = null; }
  }
  const v = validateReport(body, deps.platform, known);
  if (!v.ok) return res.status(400).json({ error: 'invalid_report', field: v.error });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const lim = await checkHeartbeatLimit(deps.db, ip, HEARTBEAT_LIMIT, deps.now ? deps.now() : Date.now());
  if (lim.failed) return res.status(503).json({ error: 'telemetry_unavailable', dropped: true });
  if (!lim.allowed) { res.set('Retry-After', String(lim.retryAfterSec)); return res.status(429).json({ error: 'rate_limited' }); }
  try {
    await recordReport(deps.db, deps.ServerValue, v.report, deps.now ? deps.now() : Date.now());
  } catch (e) {
    console.error('client_version_record_failed', e && e.message);
    return res.status(503).json({ error: 'telemetry_unavailable', dropped: true });
  }
  return res.status(204).end();
}

// Conditional delete: removes the record only if `expired(cur)` still holds INSIDE the transaction.
async function conditionalRemove(ref, expired) {
  const r = await ref.transaction((cur) => (cur === null ? null : (expired(cur) ? null : undefined)));
  return r.committed && r.snapshot.val() === null;
}

// deps: { db, platform, now }
async function sweepClientVersions(deps) {
  const now = deps.now ? deps.now() : Date.now();
  const out = { instances: 0, limits: 0, stats: 0 };
  const instCutoff = now - INSTANCE_TTL_MS;
  for (const app of deps.platform.sites.apps) {
    for (let b = 0; b < SWEEP_MAX_BATCHES; b += 1) {
      const snap = await deps.db.ref(`client_versions/${app}`).orderByChild('last_seen').endAt(instCutoff).limitToFirst(SWEEP_BATCH).once('value');
      const keys = Object.keys(snap.val() || {});
      for (const k of keys) {
        if (await conditionalRemove(deps.db.ref(`client_versions/${app}/${k}`), (cur) => typeof cur.last_seen !== 'number' || cur.last_seen <= instCutoff)) out.instances += 1;
      }
      if (keys.length < SWEEP_BATCH) break;
    }
  }
  const limCutoff = now - HEARTBEAT_LIMIT.windowMs;
  for (let b = 0; b < SWEEP_MAX_BATCHES; b += 1) {
    const snap = await deps.db.ref('client_version_limits').orderByChild('window_start').endAt(limCutoff).limitToFirst(SWEEP_BATCH).once('value');
    const keys = Object.keys(snap.val() || {});
    for (const k of keys) {
      if (await conditionalRemove(deps.db.ref(`client_version_limits/${k}`), (cur) => typeof cur.window_start !== 'number' || cur.window_start <= limCutoff)) out.limits += 1;
    }
    if (keys.length < SWEEP_BATCH) break;
  }
  // hourly counters: keys are UTC hours (YYYYMMDDHH) → everything strictly before the retention hour goes
  const statsCutoff = hourKey(now - STATS_RETENTION_MS);
  for (let b = 0; b < SWEEP_MAX_BATCHES; b += 1) {
    const snap = await deps.db.ref('client_version_stats').orderByKey().endBefore(statsCutoff).limitToFirst(SWEEP_BATCH).once('value');
    const keys = Object.keys(snap.val() || {});
    if (!keys.length) break;
    const upd = {}; for (const k of keys) upd[`client_version_stats/${k}`] = null;
    await deps.db.ref().update(upd);
    out.stats += keys.length;
    if (keys.length < SWEEP_BATCH) break;
  }
  return out;
}

module.exports = {
  handleReport, validateReport, checkHeartbeatLimit, recordReport, sweepClientVersions, hourKey,
  HEARTBEAT_LIMIT, LIVE_WINDOW_MS, INSTANCE_TTL_MS, STATS_RETENTION_MS, SWEEP_BATCH, SWEEP_MAX_BATCHES,
};
