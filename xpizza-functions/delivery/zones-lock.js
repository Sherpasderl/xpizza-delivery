'use strict';
// ENVÍO STEP 2 — the hours lock on CHANGING the drawn no-delivery zones (PLAN-envio-zones-step2-r2 §3.3; owner D1 2026-11-11: zones are
// edited only while every restaurant is closed). A simple, point-in-time owner rule — not a proof held through the commit (Codex r1
// F3, advisor: the seconds between this check and the commit, and a registration or hours/grace edit racing it, are ACCEPTED).
//   · every registered branch, from the registry read FRESH (ok && fresh), as the branch directory does
//   · hours from the ONE shared source (schedule/load-schedule.js) and ONLY from a fresh read (F2): a cache-sourced or failed read
//     → 503 hours_unavailable; fresh but missing / grammar-invalid hours → hours_unknown
//   · "open" = isWithinGrace (isOpenAt OR the paid-after-close grace), the clock read AFTER every read (F3)
//   · the grace is read strictly HERE (a failed read → 503), while materialization's fail-open default stays as it is
// → { ok: true } | { ok: false, status: 503, body } | { ok: false, status: 409, body: { error: 'zones_locked_while_open', branches } }
const SCHED = require('../scheduled-orders');
const { loadSchedule } = require('../schedule/load-schedule');

const UNAVAILABLE = { ok: false, status: 503, body: { error: 'hours_unavailable', retryable: true } };
const DEFAULT_GRACE_MIN = 15;

// config/order_grace_minutes, parsed exactly as the paid-after-close grace is (unset / non-finite / non-positive → 15) — but a READ
// ERROR throws instead of becoming 15, so this fail-closed consumer can tell an outage from an unset value
async function readGraceMinutesStrict(db) {
  const v = (await db.ref('config/order_grace_minutes').once('value')).val();
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRACE_MIN;
}

async function zonesLock(deps) {
  let reg;
  try { reg = await deps.readRegistry(); } catch (_) { return UNAVAILABLE; }
  if (!reg || reg.ok !== true || reg.fresh !== true || !Array.isArray(reg.ids)) return UNAVAILABLE;
  const ids = [...new Set(reg.ids)].sort();
  const schedules = [];
  for (const rid of ids) {
    // the ONE hours source, with the restaurant-config reader injected so the same single read also names the branch
    let s, identity = null;
    try { s = await loadSchedule(deps.db, rid, { now: deps.now(), getIdentity: async (d, r, t) => (identity = await deps.getIdentity(d, r, t)) }); } catch (_) { return UNAVAILABLE; }
    if (!s || s.source !== 'fresh') return UNAVAILABLE;
    schedules.push({ rid, s, location_name: identity && typeof identity.location_name === 'string' ? identity.location_name : null });
  }
  let graceMin;
  try { graceMin = await deps.readGrace(deps.db); } catch (_) { return UNAVAILABLE; }
  const now = deps.now();   // AFTER every read
  const branches = [];
  for (const { rid, s, location_name } of schedules) {
    if (!s.valid) branches.push({ rid, location_name, reason: 'hours_unknown' });
    else if (SCHED.isWithinGrace(s.hours, now, graceMin)) branches.push({ rid, location_name, reason: 'open' });
  }
  return branches.length ? { ok: false, status: 409, body: { error: 'zones_locked_while_open', branches } } : { ok: true };
}

module.exports = { zonesLock, readGraceMinutesStrict };
