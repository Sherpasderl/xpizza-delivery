'use strict';
// Calificaciones v2 (PLAN-3a-merchant-reviews-v2 r4.2 §2, r5 §1 + §4) — THE one period model for the reviews page: the last N CLOSED
// HN weeks (Mon–Sun; a week closes 7 days after its Sunday ends: r1's edit window). The list runs from the oldest window week's Monday
// to now; the Overview and the bucket builder use the closed weeks. America/Tegucigalpa is UTC−6 with no daylight saving.
const HN_OFFSET_MS = 6 * 3600e3;
const DAY = 86400e3, WEEK = 7 * DAY;
const WEEKS = Object.freeze([1, 4, 13]);
const MAX_WEEKS = 13;

// the Monday 00:00 HN (as ms) of the week holding `t`
function hnMonday(t) {
  const dayStart = Math.floor((t - HN_OFFSET_MS) / DAY) * DAY;
  const dow = (new Date(dayStart).getUTCDay() + 6) % 7;   // Mon = 0
  return dayStart - dow * DAY + HN_OFFSET_MS;
}
// { start: the oldest window week's Monday, closedEnd: the newest closed week's end (exclusive) }. The week that ended last Sunday
// closes next Monday (+7 d), so the newest closed week is the one before it.
function windowOf(weeks, now) {
  const closedEnd = hnMonday(now) - WEEK;
  return { start: closedEnd - weeks * WEEK, closedEnd };
}
const hnDate = (t) => new Date(t - HN_OFFSET_MS).toISOString().slice(0, 10);
// HN day 'YYYY-MM-DD' → its start (ms)
const dayStart = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) + HN_OFFSET_MS; };
// the HN days of [from, to) as 'YYYY-MM-DD', oldest first
function daysOf(from, to) {
  const out = [];
  for (let t = Math.floor((from - HN_OFFSET_MS) / DAY) * DAY + HN_OFFSET_MS; t < to; t += DAY) out.push(hnDate(t));
  return out;
}
// the bucket builder's range (r5 §4): from the Monday that starts the OLDEST week a weeks=13 window can contain, through today
// (the 13 closed weeks + the completed-but-not-closed week + the current partial week ⇒ ≤ 105 days)
const builderRange = (now) => ({ start: windowOf(MAX_WEEKS, now).start, end: now });

module.exports = { HN_OFFSET_MS, DAY, WEEK, WEEKS, MAX_WEEKS, hnMonday, windowOf, hnDate, dayStart, daysOf, builderRange };
