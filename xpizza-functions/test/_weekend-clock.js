'use strict';
/* THE INTAKE WEEKEND CLOCK for suites that order from a weekend-only section (x_pizza's "ny", WEEKEND_ONLY_CATS).
 *
 * 🔴 WHY. createOrder / chargeOnlineOrder refuse a weekend-only dish on Mon–Thu (Honduras time) with 400 weekend_only:
 * index.js computes the fulfilment time as `scheduled_for ?? Date.now()` and passes it to menu-pricing's
 * weekendOnlyViolation(items, rid, fulfillmentMs, keys). A suite that orders such a dish against the REAL clock is green
 * Fri–Sun and red Mon–Thu — its verdict depends on the calendar, not the code (found 2026-10-12, a Monday).
 *
 * HOW. Exactly where the code reads the time: the handlers' ONE consumer of it. index.js binds weekendOnlyViolation once
 * at load (`const { weekendOnlyViolation } = require('./menu-pricing')`), so this swaps the module's cached exports for
 * a copy whose weekendOnlyViolation calls the REAL rule with the fulfilment time replaced by the controlled clock — but
 * only when the handler passed "now" (within CLOCK_SKEW_MS of Date.now()); a scheduled_for time passes through
 * untouched. The rule, the catalog-derived key set and every other export stay real, and the global Date is NOT touched
 * (tokens, TTLs, rate limits and Firestore times keep the real clock). No production file changes.
 *
 * Load this BEFORE ../index.js. Every call is recorded, so a suite can prove the gate it relies on actually ran.
 */
const assert = require('assert');
const P = require.resolve('../menu-pricing');
const real = require(P);

// Fixed instants, noon in Honduras (UTC−6): self-checked against the rule's own day function below.
const SATURDAY = Date.UTC(2026, 9, 10, 18, 0, 0);   // Sat 2026-10-10 12:00 HN
const MONDAY = Date.UTC(2026, 9, 12, 18, 0, 0);     // Mon 2026-10-12 12:00 HN
assert.strictEqual(real.hnDayFromMs(SATURDAY), 6, 'weekend clock: SATURDAY must be a Honduras Saturday');
assert.strictEqual(real.hnDayFromMs(MONDAY), 1, 'weekend clock: MONDAY must be a Honduras Monday');

const CLOCK_SKEW_MS = 120000;
const clock = { ms: SATURDAY };
const calls = [];
const weekendOnlyViolation = (items, restaurantId, fulfillmentMs, keys) => {
  const isNow = Number.isFinite(fulfillmentMs) && Math.abs(fulfillmentMs - Date.now()) <= CLOCK_SKEW_MS;
  const used = isNow ? clock.ms : fulfillmentMs;
  const out = real.weekendOnlyViolation(items, restaurantId, used, keys);
  calls.push({ restaurantId, isNow, day: real.hnDayFromMs(used), result: out });
  return out;
};
require.cache[P].exports = { ...real, weekendOnlyViolation };

// set the day the intake gate sees; returns the Honduras day number it now reads
function setDay(which) {
  assert.ok(which === 'saturday' || which === 'monday', `weekend clock: unknown day ${which}`);
  clock.ms = which === 'saturday' ? SATURDAY : MONDAY;
  return real.hnDayFromMs(clock.ms);
}
module.exports = { setDay, calls, SATURDAY, MONDAY };
