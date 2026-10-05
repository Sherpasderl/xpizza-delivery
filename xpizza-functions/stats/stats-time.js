'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — business time (PLAN-stats rev 4, §S1.1 "Service time").
//
// ONE effective service timestamp per order: `scheduled_for` when present, else `created_at`. Every
// date/hour attribution goes through serviceMs(), so a scheduled order lands on the day it is SERVED,
// not the day it was placed.
//
// v1 is PINNED to Honduras time, fixed UTC−6 with no DST — the same offset scheduled-orders.js already
// uses (TZ_OFFSET_MS, imported, not retyped). A per-restaurant timezone is a later config field.
// Business dates are half-open [00:00, 24:00); weeks run Monday–Sunday.
// ---------------------------------------------------------------------------
const { TZ_OFFSET_MS, DEFAULT_CFG } = require('../scheduled-orders');

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/* 🔴 THE READ PADDING IS DERIVED FROM THE SCHEDULING HORIZON, never typed. A run reads by `created_at`
   but attributes by service date, and a scheduled order can be placed up to maxHorizonHours BEFORE the
   day it is served (scheduled-orders.js DEFAULT_CFG). Pad = that horizon rounded UP to whole days, plus
   one day of slack for the local-midnight boundary. At 168 h that is 8 days, the plan's figure; if the
   horizon ever grows, the padding grows with it instead of silently dropping far-ahead orders.
   stats-time.test.js asserts the pad covers the horizon. */
const READ_PAD_DAYS = Math.ceil(DEFAULT_CFG.maxHorizonHours / 24) + 1;
const READ_PAD_MS = READ_PAD_DAYS * DAY_MS;

const pad2 = (n) => String(n).padStart(2, '0');
const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);

// The order's service instant, or null when it has none usable (never guessed).
function serviceMs(order) {
  if (!order) return null;
  const sf = order.scheduled_for;
  if (sf != null && sf !== '') {
    const n = Number(sf);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const c = Number(order.created_at);
  return Number.isFinite(c) && c > 0 ? c : null;
}

// YYYY-MM-DD of a UTC instant, in Honduras local time.
function dateOf(ms) {
  const t = new Date(ms - TZ_OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
// Local hour 0..23.
function hourOf(ms) { return new Date(ms - TZ_OFFSET_MS).getUTCHours(); }

function parseDate(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  // Round-trip check rejects 2026-02-31 and friends instead of silently rolling them over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return utc;
}
const isDate = (s) => parseDate(s) !== null;

// [start, end) of a business date, as UTC instants.
function dayStartMs(date) {
  const u = parseDate(date);
  if (u === null) throw new Error(`bad_date: ${String(date).slice(0, 20)}`);
  return u + TZ_OFFSET_MS;
}
const dayEndMs = (date) => dayStartMs(date) + DAY_MS;

function addDays(date, n) {
  const u = parseDate(date);
  if (u === null) throw new Error(`bad_date: ${String(date).slice(0, 20)}`);
  const t = new Date(u + n * DAY_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
// Inclusive list of dates from..to (empty when to < from).
function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
const daysBetween = (from, to) => Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
// 0 = Monday … 6 = Sunday.
function weekdayOf(date) { return (new Date(parseDate(date)).getUTCDay() + 6) % 7; }
const weekStartOf = (date) => addDays(date, -weekdayOf(date));
const monthOf = (date) => date.slice(0, 7);

module.exports = {
  DAY_MS, READ_PAD_DAYS, READ_PAD_MS, TZ_OFFSET_MS,
  serviceMs, dateOf, hourOf, parseDate, isDate, dayStartMs, dayEndMs, addDays, datesBetween, daysBetween,
  weekdayOf, weekStartOf, monthOf, isFiniteNum,
};
