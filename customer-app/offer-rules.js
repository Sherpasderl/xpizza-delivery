'use strict';
// THE ONE OFFER RULES — shared by the server and the customer app (advisor 11-14, interface agreed with capp; rule 4: one source).
// Pure, no requires. The server requires THIS file (marketing/offer-price.js, marketing/offer-model.js, catalog/offers-serve.js); the capp
// loads a byte-identical copy (customer-app/offer-rules.js, written by tools/sync-client.js; marketing/offer-rules-sync.guard.test.js).
//   bogoSaving(unitsCents, freePerOrder) → cents: the eligible units' table prices in any order; dearest first, every 2nd one free, at
//     most freePerOrder free units (the price path's pairing rule).
//   inWindow(schedule, nowMs) → bool: start ≤ now < end (end null/absent = open), and the HN minute-of-week inside one of the weekly
//     intervals (HN days, the minute window, a window past midnight belongs to the day it starts, the week wraps).
//   weeklyIntervals(schedule) → [[from, to)] minutes of the HN week (the overlap rule and inWindow use it).
// Honduras is UTC−6 all year (no DST).
const HN_OFFSET_MS = 6 * 3600000;
const DAY_MS = 86400000;
const WEEK_MIN = 7 * 1440;

function bogoSaving(unitsCents, freePerOrder) {
  const el = unitsCents.slice().sort((a, b) => b - a);
  let d = 0;
  for (let i = 1, k = 0; i < el.length && k < freePerOrder; i += 2, k += 1) d += el[i];
  return d;
}

// An offer's weekly minutes: for each day d, [d·1440 + from, d·1440 + to) where a window ending at or before its start runs past
// midnight (it belongs to the day it STARTS on, «vie/sáb 21:00–00:00»); no window = the whole day. Intervals wrap at the week's end.
function weeklyIntervals(schedule) {
  const out = [];
  for (const d of schedule.days) {
    const base = d * 1440;
    let a = 0, b = 1440;
    if (schedule.window) { a = schedule.window.from; b = schedule.window.to; if (b <= a) b += 1440; }
    const s = base + a, e = base + b;
    if (e <= WEEK_MIN) out.push([s, e]); else { out.push([s, WEEK_MIN]); out.push([0, e - WEEK_MIN]); }
  }
  return out;
}

function inWindow(schedule, nowMs) {
  if (!schedule || typeof schedule !== 'object' || !Array.isArray(schedule.days)) return false;
  if (!(Number.isSafeInteger(schedule.start) && schedule.start <= nowMs)) return false;
  if (Number.isSafeInteger(schedule.end) && nowMs >= schedule.end) return false;
  const local = nowMs - HN_OFFSET_MS;
  const m = new Date(local).getUTCDay() * 1440 + Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60000);
  return weeklyIntervals(schedule).some(([a, b]) => m >= a && m < b);
}

(function (root) {
  const api = { bogoSaving, inWindow, weeklyIntervals, WEEK_MIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OfferRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
