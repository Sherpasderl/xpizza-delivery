'use strict';
// PLAN-3a-capp-push-tokens r0 + the advisor's rulings (2026-11-14) — THE customer promo-push policy: how many Sherpa campaign pushes a
// person may get and when never. OWNER-EDITABLE (platform_config/push), validated here — the ONE module the capp's GET
// (getCustomerPushPrefs.limits), the sender (5f, imports it and owns its evolution) and the Sherpa-admin editor (a later portal item,
// through writePushPolicy) all use.
//   platform_config/push = { v (version ≥ 1), promo_daily_max, promo_weekly_max, quiet_from, quiet_to, by, at }
//   DEFAULTS: 1 per day, 3 per week, quiet 21:00 → 09:00 HN — times are HN MINUTES 0..1439 (the hours tripwire: no HH:MM parsing).
//   BOUNDS (APPROVED 11-14): daily 0..3; weekly 0..10 and ≥ daily (room to RAISE frequency); the quiet window is MANDATORY — from ≠ to,
//   its wrap-aware length (to − from + 1440) % 1440 within 360..840 minutes (6..14 h): the owner may send more often, never at night.
//   A malformed, out-of-bounds or unreadable stored node ⇒ the DEFAULTS (fail closed); the setter refuses what the bounds refuse.
const PATH = 'platform_config/push';
const DEFAULTS = Object.freeze({ promo_daily_max: 1, promo_weekly_max: 3, quiet_from: 1260, quiet_to: 540 });
const FIELDS = Object.freeze(Object.keys(DEFAULTS));
const BOUNDS = Object.freeze({ promo_daily_max: [0, 3], promo_weekly_max: [0, 10], minute: [0, 1439], quiet_len: [360, 840] });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, [lo, hi]) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const quietLen = (from, to) => (to - from + 1440) % 1440;

// a policy (exactly the four fields) → { ok: true, value } | { ok: false, field, reason }
function validatePushPolicy(p) {
  if (!isObj(p) || Object.keys(p).length !== FIELDS.length || !FIELDS.every((k) => Object.prototype.hasOwnProperty.call(p, k))) return { ok: false, field: 'policy', reason: 'bad_shape' };
  if (!isInt(p.promo_daily_max, BOUNDS.promo_daily_max)) return { ok: false, field: 'promo_daily_max', reason: 'out_of_bounds' };
  if (!isInt(p.promo_weekly_max, BOUNDS.promo_weekly_max)) return { ok: false, field: 'promo_weekly_max', reason: 'out_of_bounds' };
  if (p.promo_weekly_max < p.promo_daily_max) return { ok: false, field: 'promo_weekly_max', reason: 'below_daily' };
  if (!isInt(p.quiet_from, BOUNDS.minute)) return { ok: false, field: 'quiet_from', reason: 'out_of_bounds' };
  if (!isInt(p.quiet_to, BOUNDS.minute)) return { ok: false, field: 'quiet_to', reason: 'out_of_bounds' };
  if (!isInt(quietLen(p.quiet_from, p.quiet_to), BOUNDS.quiet_len)) return { ok: false, field: 'quiet_to', reason: 'quiet_window' };
  return { ok: true, value: { promo_daily_max: p.promo_daily_max, promo_weekly_max: p.promo_weekly_max, quiet_from: p.quiet_from, quiet_to: p.quiet_to } };
}

// the stored node → the policy in force (the DEFAULTS unless the node is a whole, in-bounds, versioned policy)
function normalizePushPolicy(node) {
  if (!isObj(node) || !Number.isSafeInteger(node.v) || node.v < 1) return { ...DEFAULTS };
  const r = validatePushPolicy(Object.fromEntries(FIELDS.map((k) => [k, node[k]])));
  return r.ok ? r.value : { ...DEFAULTS };
}

// the policy in force; a read failure ⇒ the DEFAULTS (fail closed: never more pushes than the owner's defaults on an outage)
async function readPushPolicy(db) {
  try { return normalizePushPolicy((await db.ref(PATH).once('value')).val()); } catch (_) { return { ...DEFAULTS }; }
}

// THE setter (the Sherpa-admin editor; an owner CLI): validated, ONE version-CAS transaction (expected 0 = create).
// → { ok: true, version } | { ok: false, field, reason } (nothing written) | { ok: false, reason: 'conflict' | 'current_malformed' }
async function writePushPolicy(db, { expected, policy, actor, now }) {
  const r = validatePushPolicy(policy);
  if (!r.ok) return r;
  if (!Number.isSafeInteger(expected) || expected < 0 || typeof actor !== 'string' || !actor || !Number.isSafeInteger(now)) return { ok: false, field: 'request', reason: 'bad_request' };
  let why = null;
  const tx = await db.ref(PATH).transaction((cur) => {
    why = null;
    const v = cur === null ? 0 : (isObj(cur) && Number.isSafeInteger(cur.v) && cur.v >= 1 ? cur.v : null);
    if (v === null) { why = 'current_malformed'; return undefined; }
    if (v !== expected) { why = 'conflict'; return cur === null ? null : undefined; }   // null-first: a cold null never aborts
    return { v: expected + 1, ...r.value, by: actor, at: now };
  });
  if (why) return { ok: false, reason: why };
  if (!(tx && tx.committed)) return { ok: false, reason: 'conflict' };
  return { ok: true, version: expected + 1 };
}

module.exports = { PATH, DEFAULTS, BOUNDS, validatePushPolicy, normalizePushPolicy, readPushPolicy, writePushPolicy };
