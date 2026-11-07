'use strict';
// ── PLAN 3 — formSignal: a server-visible COUNT of order-form cart blocks (docs/superpowers/plans/2026-10-26-form-signal-counter.md r3)
//
// A form that refuses a checkout because of a cart conflict sends ONE beacon: {rid, event, reasons}. These are UNTRUSTED
// observations, never authority: nothing reads them to gate anything. They answer "how often is a customer blocked, where,
// and why", per restaurant per Honduras day. No PII, no IP, no dish names, no cart contents.
//
// ORDER OF WORK (each refusal returns and writes no COUNTER — "no write" = nothing under form_signals/):
//   0. SIZE on the raw bytes (rawBody when the wrapper kept it): > 512 → 413.               no database call at all
//   1. PARSE: text/plain only (what sendBeacon(url, string) sends — a CORS-simple request); a string body or an
//      already-parsed object go through the same checks. Keys exactly {rid, event, reasons}. → 204   no database call
//   2. VALIDATE: rid structural (RID_RE) FIRST, then `await registry.ready()` and registry.known() (a cold instance's
//      known() is the compiled floor until the first read — r3 #3); event + every reason in its allowlist, all or
//      nothing; reasons deduped. → 204                                                   no database call besides the registry
//   3. LIMIT: a DEDICATED fail-CLOSED limiter (form_signal_limits/{ipKey}, never the order buckets), keyed on the
//      RIGHTMOST X-Forwarded-For entry (the hop Google's front end appends; the leftmost and req.ip are client-spoofable).
//      failed → 503 {dropped:true}; over → 429.                                            limiter bookkeeping only
//   4. WRITE: ONE atomic multi-path update with the server-derived Honduras day. A write failure → 204, one log line,
//      no retry (an observation, not a record).
const { rateLimitKey } = require('./order-dedup');
const { RID_RE } = require('./platform-manifest');
const { hnDateISO } = require('./lib/hn-date');

const MAX_BODY_BYTES = 512;
const MAX_REASONS = 8;
const EVENTS = new Set(['restore', 'build', 'submit', 'send']);
const REASONS = new Set(['removed', 'renamed', 'repriced', 'unavailable', 'option', 'choice', 'empty']);
const KEYS = ['event', 'reasons', 'rid'];                                  // sorted: the body's keys must be exactly these
const SIGNAL_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };               // per ip key
const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
const SWEEP_MAX_BATCHES = 10;

function rawLength(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.length;
  const b = req.body;
  if (typeof b === 'string') return Buffer.byteLength(b, 'utf8');
  if (Buffer.isBuffer(b)) return b.length;
  if (b && typeof b === 'object') return Buffer.byteLength(JSON.stringify(b), 'utf8');
  return 0;
}

function isTextPlain(req) {
  const ct = String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
  return ct === 'text/plain';
}

// A string (the text parser), a Buffer (a raw parser) or an already-parsed object → the plain object, or null.
function parseBody(b) {
  let v = b;
  try {
    if (Buffer.isBuffer(v)) v = v.toString('utf8');
    if (typeof v === 'string') v = JSON.parse(v);
  } catch (_) { return null; }
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}

// STRUCTURE only — pure, no registry, no database. → { ok: true, signal } | { ok: false, error }
function validateStructure(body) {
  if (!body) return { ok: false, error: 'body' };
  const keys = Object.keys(body).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return { ok: false, error: 'keys' };
  const { rid, event, reasons } = body;
  if (typeof rid !== 'string' || !RID_RE.test(rid)) return { ok: false, error: 'rid' };
  if (typeof event !== 'string' || !EVENTS.has(event)) return { ok: false, error: 'event' };
  if (!Array.isArray(reasons) || reasons.length < 1 || reasons.length > MAX_REASONS) return { ok: false, error: 'reasons' };
  if (!reasons.every((r) => typeof r === 'string' && REASONS.has(r))) return { ok: false, error: 'reason' };
  return { ok: true, signal: { rid, event, reasons: [...new Set(reasons)] } };
}

// The rightmost X-Forwarded-For entry: the hop Google's front end appended. Never the leftmost, never req.ip.
function ipKeyOf(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '');
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// The signal's OWN limiter: the heartbeat's fixed-window transaction, failure REPORTED (fail-closed by the caller).
async function checkSignalLimit(db, rawKey, cfg = SIGNAL_LIMIT, now = Date.now()) {
  if (!rawKey) return { allowed: false, failed: true, retryAfterSec: 0 };
  const ref = db.ref(`form_signal_limits/${rateLimitKey(rawKey)}`);
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
    console.error('form_signal_limit_failed', e && e.message);
    return { allowed: false, failed: true, retryAfterSec: 0 };
  }
}

// ONE atomic multi-path update, with the server-derived Honduras day. Keys written out under their literal root.
async function recordSignal(db, ServerValue, s, now) {
  const D = hnDateISO(now);
  const updates = { [`form_signals/${D}/${s.rid}/${s.event}/_count`]: ServerValue.increment(1) };
  for (const r of s.reasons) updates[`form_signals/${D}/${s.rid}/${s.event}/${r}`] = ServerValue.increment(1);
  await db.ref().update(updates);
}

// The HTTP handler body. deps: { db, ServerValue, registry, now }
async function handleSignal(req, res, deps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).end(); }
  // 0. size, on the raw bytes
  if (rawLength(req) > MAX_BODY_BYTES) return res.status(413).end();
  // 1. parse — the beacon's content type only
  if (!isTextPlain(req)) return res.status(204).end();
  // 2. validate: structure first (pure), then the warmed registry
  const v = validateStructure(parseBody(req.body));
  if (!v.ok) return res.status(204).end();
  let known = null;
  try { if (deps.registry) { await deps.registry.ready(); known = deps.registry.known(); } } catch (_) { known = null; }
  if (!(known && known.has(v.signal.rid))) return res.status(204).end();
  // 3. the dedicated limiter, fail-CLOSED
  const lim = await checkSignalLimit(deps.db, ipKeyOf(req), SIGNAL_LIMIT, now());
  if (lim.failed) return res.status(503).json({ dropped: true });
  if (!lim.allowed) { res.set('Retry-After', String(lim.retryAfterSec)); return res.status(429).end(); }
  // 4. one atomic multi-path update
  try {
    await recordSignal(deps.db, deps.ServerValue, v.signal, now());
  } catch (e) {
    console.error('form_signal_write_failed', (e && e.code) || 'error');
  }
  return res.status(204).end();
}

// Conditional delete: removes the record only if `expired(cur)` still holds INSIDE the transaction.
async function conditionalRemove(ref, expired) {
  const r = await ref.transaction((cur) => (cur === null ? null : (expired(cur) ? null : undefined)));
  return r.committed && r.snapshot.val() === null;
}

// deps: { db, now } — day keys older than the retention (keys are YYYY-MM-DD, sortable as strings) and expired limiter
// windows, in bounded batches.
async function sweepFormSignals(deps) {
  const now = deps.now ? deps.now() : Date.now();
  const out = { days: 0, limits: 0 };
  const dayCutoff = hnDateISO(now - RETENTION_DAYS * DAY_MS);
  for (let b = 0; b < SWEEP_MAX_BATCHES; b += 1) {
    const snap = await deps.db.ref('form_signals').orderByKey().endBefore(dayCutoff).limitToFirst(SWEEP_BATCH).once('value');
    const keys = Object.keys(snap.val() || {});
    if (!keys.length) break;
    const upd = {}; for (const k of keys) upd[`form_signals/${k}`] = null;
    await deps.db.ref().update(upd);
    out.days += keys.length;
    if (keys.length < SWEEP_BATCH) break;
  }
  const limCutoff = now - SIGNAL_LIMIT.windowMs;
  for (let b = 0; b < SWEEP_MAX_BATCHES; b += 1) {
    const snap = await deps.db.ref('form_signal_limits').orderByChild('window_start').endAt(limCutoff).limitToFirst(SWEEP_BATCH).once('value');
    const keys = Object.keys(snap.val() || {});
    for (const k of keys) {
      if (await conditionalRemove(deps.db.ref(`form_signal_limits/${k}`), (cur) => typeof cur.window_start !== 'number' || cur.window_start <= limCutoff)) out.limits += 1;
    }
    if (keys.length < SWEEP_BATCH) break;
  }
  return out;
}

module.exports = {
  handleSignal, validateStructure, parseBody, ipKeyOf, checkSignalLimit, recordSignal, sweepFormSignals,
  MAX_BODY_BYTES, MAX_REASONS, EVENTS, REASONS, SIGNAL_LIMIT, RETENTION_DAYS, SWEEP_BATCH, SWEEP_MAX_BATCHES,
};
