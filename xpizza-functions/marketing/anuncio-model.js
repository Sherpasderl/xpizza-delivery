'use strict';
// PLAN-3a-marketing-server r0 §4 (advisor APPROVED 2026-11-14; step 3, FULLY DARK) — the «Anuncio» (paid weekly home placement,
// «Patrocinado» in the app), pure. ONE slot per week platform-wide (Q8); L 450 ISV incl., Sherpa-set (platform_config/marketing);
// no charge field anywhere — money moves only through the restaurant ledger (DECISIONS 4747), which does not exist yet.
//   weeks: driver-ledger/ledger-core's HN Monday week ("W2026-11-16" = Mon 00:00 … Sun 23:59:59.999 HN), the SAME week the payout
//   ledger closes. A week is bookable only before it starts; the free cancel deadline is the Sunday 23:59:59.999 HN before it.
//   eligibility (advisor ruling 11-14, owner pending): the PUBLIC rating — rating_avg ≥ rating_min with rating_count ≥ min_ratings —
//   and «not paused-heavy»: paused-while-open hours over the last 30 HN days ≤ paused_max_h_30d. The pause term comes from 5f's merit C
//   (merit/paused.js, one source) and is ABSENT until feat/merit-5f merges (advisor ruling (A)); no «pedidos con problemas» metric.
//   visibility (one rule, shared by the capp's serving read and the hidden-day recorder): eligible by rating, and not paused NOW.
const { weekOf, weekBounds, nextWeek } = require('../driver-ledger/ledger-core');
const OCS = require('../order-control-state');

const WEEKS_AHEAD = 8;
const BOOKINGS_MAX = 12;                     // per rid (a quarter ahead + recent history)
const BOOKING_RETAIN_MS = 26 * 7 * 86400000; // ended / cancelled bookings pruned after 26 weeks
const BOOKING_ID_RE = /^b_[a-z2-7]{12}$/;
const WEEK_RE = /^W\d{4}-\d{2}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const cancelDeadline = (week) => weekBounds(week).start - 1;   // Sunday 23:59:59.999 HN before the week

// the next WEEKS_AHEAD weeks that have not started (the current week never: it already began)
function bookableWeeks(nowMs) {
  const out = [];
  let w = nextWeek(weekOf(nowMs));
  while (out.length < WEEKS_AHEAD) { out.push(w); w = nextWeek(w); }
  return out;
}
const isBookable = (week, nowMs) => typeof week === 'string' && WEEK_RE.test(week) && bookableWeeks(nowMs).includes(week);

// the rating term, from public_stats/{rid} (rating fields exist only at ≥ 10 ratings — the PUBLIC threshold) → { ok, rating, count, reasons }
function ratingEligibility(stats, thresholds) {
  const t = isObj(thresholds) ? thresholds : null;
  const rating = isObj(stats) && typeof stats.rating_avg === 'number' ? stats.rating_avg : null;
  const count = isObj(stats) && Number.isSafeInteger(stats.rating_count) ? stats.rating_count : 0;
  const reasons = [];
  if (!t) reasons.push('config_unavailable');
  else if (rating === null || count < t.min_ratings) reasons.push('not_enough_ratings');
  else if (rating < t.rating_min) reasons.push('rating_below');
  return { ok: reasons.length === 0, rating, count, reasons };
}

// THE visibility rule (capp serving read + hidden-day recorder): eligible by rating and NOT paused now (order_control's one reader)
function anuncioVisible({ stats, control, thresholds, nowMs }) {
  if (!ratingEligibility(stats, thresholds).ok) return { visible: false, reason: 'rating' };
  const st = OCS.effectiveState(control, nowMs).state;
  if (st !== OCS.OPEN) return { visible: false, reason: st === OCS.PAUSED ? 'paused' : 'control_unknown' };
  return { visible: true };
}

// a booking's state as shown: reserved before its week, active during, ended after (derived — no job); cancelled is stored
function bookingStatus(b, nowMs) {
  if (!isObj(b) || !WEEK_RE.test(String(b.week))) return 'unknown';
  if (b.state === 'cancelled') return 'cancelled';
  const { start, end } = weekBounds(b.week);
  return nowMs < start ? 'reserved' : nowMs < end ? 'active' : 'ended';
}

// the days of a booking's week that were not shown (the pro-rata input the ledger will read): { day: 'hidden' } entries
const hiddenDays = (b) => Object.entries(isObj(b) && isObj(b.days) ? b.days : {}).filter(([d, v]) => DAY_RE.test(d) && isObj(v) && v.state === 'hidden').map(([d]) => d).sort();

module.exports = { WEEKS_AHEAD, BOOKINGS_MAX, BOOKING_RETAIN_MS, BOOKING_ID_RE, WEEK_RE, cancelDeadline, bookableWeeks, isBookable,
  ratingEligibility, anuncioVisible, bookingStatus, hiddenDays, weekOf, weekBounds };
