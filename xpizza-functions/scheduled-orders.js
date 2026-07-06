'use strict';

/**
 * Scheduled Orders — pure server-authoritative core (SCHEDULED_ORDERS_PLAN.md rev-3).
 *
 * PURE: no db, no I/O (extract-then-golden). Holds the money-safe/time-safe decisions the triggers wire:
 *   - server-authoritative hours / slot generation / validation (UTC−6 Honduras, §F), used at CREATE +
 *     CONFIRM + RELEASE (never trust the client),
 *   - the release-sweep per-order decision (§C: claim scheduled→releasing, skip blocked/cancel/not-due,
 *     recover stale releasing),
 *   - the reconcile SLA / overdue classification (§E),
 *   - the slot-bound fingerprint input (§B.4 / R2-#3),
 *   - the non-live status set (scheduled + releasing are non-live everywhere).
 *
 * Config values (§ open-Q3) are constants here, per-restaurant-overridable via resolveCfg(cfg).
 */

const TZ_OFFSET_MS = 6 * 3600000;        // America/Tegucigalpa, no DST
const MS_PER_MIN = 60000;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const SCHEDULED = 'scheduled';
const RELEASING = 'releasing';
// pending_payment + the two held states are non-live: never on kitchen/dispatch/driver/tracker/factura.
const NON_LIVE_STATUSES = new Set(['pending_payment', SCHEDULED, RELEASING]);
const isNonLive = (status) => NON_LIVE_STATUSES.has(status);

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// v1 defaults; gate-cleared as the executor's call (open-Q3). Per-restaurant override via resolveCfg.
const DEFAULT_CFG = {
  slotMin: 15,                 // slot granularity
  minLeadMin: 60,              // earliest a customer may schedule ahead of now
  maxHorizonHours: 168,        // 7 days
  releaseLeadMin: 30,          // release ~prep-lead before the slot: release_at = scheduled_for − this
  releaseJitterMs: 120000,     // delivery-release spread (deterministic per order) to avoid same-minute bursts
  slaReleaseOverdueMin: 30,    // still scheduled past release_at + this → alert
  slaServiceGraceMin: 30,      // past scheduled_for + this, never served → alert (capture-now liability)
  staleReleasingMs: 300000,    // a releasing claim older than this is stale → recover
  maxSlots: 400,               // hard cap on generated slot list
};
function resolveCfg(cfg) {
  const c = cfg || {};
  const out = { ...DEFAULT_CFG };
  for (const k of Object.keys(DEFAULT_CFG)) if (isNum(c[k])) out[k] = c[k];
  return out;
}

const parseHM = (s) => {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return (h >= 0 && h <= 24 && mi >= 0 && mi < 60) ? h * 60 + mi : null;
};
// local (UTC−6) day-key + minutes-since-local-midnight for a UTC ms instant.
function localParts(atMs) {
  const d = new Date(atMs - TZ_OFFSET_MS);
  return { dayKey: DAY_KEYS[d.getUTCDay()], mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
// the open window {startMin,endMin} for the day of `atMs`, or null when closed / malformed.
function hoursForDay(hours, atMs) {
  const hd = hours && hours[localParts(atMs).dayKey];
  if (!hd || hd.open === false) return null;
  const startMin = parseHM(hd.start), endMin = parseHM(hd.end);
  return (startMin === null || endMin === null || endMin <= startMin) ? null : { startMin, endMin };
}
function isOpenAt(hours, atMs) {
  const hd = hoursForDay(hours, atMs);
  if (!hd) return false;
  const { mins } = localParts(atMs);
  return mins >= hd.startMin && mins < hd.endMin;   // end exclusive
}

// validateScheduledFor — the authoritative gate at create/confirm/release. Returns { valid, reason }.
function validateScheduledFor(hours, scheduledForMs, nowMs, cfg) {
  const c = resolveCfg(cfg);
  const slotMs = c.slotMin * MS_PER_MIN;
  if (!isNum(scheduledForMs)) return { valid: false, reason: 'not_a_time' };
  if (scheduledForMs <= nowMs) return { valid: false, reason: 'in_past' };
  if (scheduledForMs % slotMs !== 0) return { valid: false, reason: 'not_granular' };
  if (scheduledForMs < nowMs + c.minLeadMin * MS_PER_MIN) return { valid: false, reason: 'below_min_lead' };
  if (scheduledForMs > nowMs + c.maxHorizonHours * 3600000) return { valid: false, reason: 'above_max_horizon' };
  if (!isOpenAt(hours, scheduledForMs)) return { valid: false, reason: 'closed_at_slot' };
  return { valid: true, reason: null };
}

// generateSlots — the offerable future slots (client fetches these; server re-validates on submit).
function generateSlots(hours, nowMs, cfg) {
  const c = resolveCfg(cfg);
  const slotMs = c.slotMin * MS_PER_MIN;
  const start = Math.ceil((nowMs + c.minLeadMin * MS_PER_MIN) / slotMs) * slotMs;
  const end = nowMs + c.maxHorizonHours * 3600000;
  const slots = [];
  for (let ms = start; ms <= end && slots.length < c.maxSlots; ms += slotMs) {
    if (isOpenAt(hours, ms)) slots.push(ms);
  }
  return slots;
}

const releaseAtFor = (scheduledForMs, cfg) => scheduledForMs - resolveCfg(cfg).releaseLeadMin * MS_PER_MIN;

// deterministic per-order jitter in [0, releaseJitterMs) for delivery-release spread (no Math.random).
function releaseJitterMs(orderId, cfg) {
  const c = resolveCfg(cfg);
  let h = 5381; const s = String(orderId || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return c.releaseJitterMs > 0 ? h % c.releaseJitterMs : 0;
}

// releaseDecision — the sweep's per-order action. { action: 'claim'|'skip'|'recover_stale', reason }.
function releaseDecision(order, nowMs, cfg) {
  const c = resolveCfg(cfg);
  const o = order || {};
  if (o.status === RELEASING) {
    return (isNum(o.releasing_since) && nowMs - o.releasing_since > c.staleReleasingMs)
      ? { action: 'recover_stale', reason: 'stale_releasing' }
      : { action: 'skip', reason: 'in_flight' };
  }
  if (o.status !== SCHEDULED) return { action: 'skip', reason: 'not_scheduled' };
  if (o.scheduled_blocked === true) return { action: 'skip', reason: 'blocked' };        // R2-#1: no re-alert loop
  if (o.resolving_action === 'cancel') return { action: 'skip', reason: 'cancel_in_progress' };
  if (!(isNum(o.release_at) && o.release_at <= nowMs)) return { action: 'skip', reason: 'not_due' };
  return { action: 'claim', reason: null };
}

// releaseTimeValid — the RELEASE-time re-validation (§D). At release we no longer check lead/horizon (the
// slot is imminent by design); we check the slot is not a missed window and is still within an open window
// (hours may have changed since booking). Closed/invalid ⇒ HOLD + block + alert, never dump on a dark kitchen.
function releaseTimeValid(hours, order, nowMs, cfg) {
  const c = resolveCfg(cfg);
  const o = order || {};
  if (!isNum(o.scheduled_for)) return { valid: false, reason: 'no_slot' };
  if (nowMs > o.scheduled_for + c.slaServiceGraceMin * MS_PER_MIN) return { valid: false, reason: 'missed_window' };
  if (!isOpenAt(hours, o.scheduled_for)) return { valid: false, reason: 'closed_at_slot' };
  return { valid: true, reason: null };
}

// scheduledOverdue — reconcile SLA. Paid-scheduled is legit until release_at; then alert (§E, R1-#7/#14).
function scheduledOverdue(order, nowMs, cfg) {
  const c = resolveCfg(cfg);
  const o = order || {};
  if (o.status !== SCHEDULED && o.status !== RELEASING) return { overdue: false, kind: null };
  if (isNum(o.scheduled_for) && nowMs > o.scheduled_for + c.slaServiceGraceMin * MS_PER_MIN) {
    return { overdue: true, kind: 'scheduled_service_overdue' };   // slot passed, never served — capture-now liability
  }
  if (isNum(o.release_at) && nowMs > o.release_at + c.slaReleaseOverdueMin * MS_PER_MIN) {
    return { overdue: true, kind: 'scheduled_release_overdue' };   // due to release but still held
  }
  return { overdue: false, kind: null };
}

// fingerprintExtra — folded into orderFingerprint so a reused cart can't rebind a DIFFERENT slot (R2-#3).
const fingerprintExtra = (fields) => `${(fields && fields.scheduled_for) || ''}|${(fields && fields.order_type) || ''}`;

module.exports = {
  SCHEDULED, RELEASING, NON_LIVE_STATUSES, isNonLive,
  resolveCfg, DEFAULT_CFG, isOpenAt, validateScheduledFor, generateSlots, releaseAtFor, releaseJitterMs,
  releaseDecision, releaseTimeValid, scheduledOverdue, fingerprintExtra, TZ_OFFSET_MS,
};
