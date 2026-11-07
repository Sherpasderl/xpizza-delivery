/* ── PAY RATE — the ONE pure reader of the platform driver pay rate (PROPOSAL-driver-pay-rate-reader r2) ───────────────────
 *
 * CANONICAL FILE: <repo>/platform/client/pay-rate.js. Committed copies, byte-identical, are written by `npm run sync:client`
 * (xpizza-functions/tools/sync-client.js) into xpizza-functions/pay-rate.js (the ledger, the owner CLI) and
 * xpizza-driver/pay-rate.js (earnings display). xpizza-functions/pay-rate.test.js fails on any drift.
 * A classic script (no module syntax): Node requires it; the browser loads it with a plain <script src> and finds it at
 * `window.PayRate`.
 *
 * The node: RTDB platform_rates/driver_per_delivery/{pushId} = { cents, effective_from } (admin-write-only; drivers and
 * dispatch read). A rate change is a NEW entry; old entries stay, so a past delivery keeps the rate it was paid at.
 *
 *   rateCentsInEffect(entries, t)   the cents of the entry with the GREATEST effective_from ≤ t, else null.
 *     - entries: the RTDB map { pushId: { cents, effective_from } } (or an array of such entries);
 *     - an entry counts only if it is VALID (validEntry, the ONE bounds contract below); anything else is skipped, never thrown;
 *     - a tie on effective_from: the later pushId (push keys sort chronologically) wins, so the answer is deterministic;
 *     - t not a finite number, no entries, or t before every effective_from → null (never retro-apply a later rate).
 *   shiftEarningsCents(deliveries, entries)   the sum of EACH delivery's own in-effect rate at its delivered_at.
 *     - null when entries is absent, or when ANY delivery has no in-effect rate (never a partial / invented total);
 *     - 0 for no deliveries with entries present.
 *
 * THE BOUNDS CONTRACT (one source; the owner CLI, this reader and the RTDB .validate all enforce it):
 *   cents           a safe integer, MIN_CENTS ≤ cents ≤ MAX_CENTS (L 1 – L 1,000 per delivery);
 *   effective_from  an integer epoch ms ≥ MIN_EFFECTIVE_FROM (2026-01-01T00:00:00Z);
 *                   AT WRITE ONLY also ≤ now + MAX_AHEAD_MS (366 days) — writableEntry(e, now). The reader never uses the clock,
 *                   so a stored entry's validity does not change with time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PayRate = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_CENTS = 100;                         // L 1
  var MAX_CENTS = 100000;                      // L 1,000
  var MIN_EFFECTIVE_FROM = 1767225600000;      // 2026-01-01T00:00:00Z
  var MAX_AHEAD_MS = 366 * 24 * 3600 * 1000;   // a write may schedule at most 366 days ahead

  function validEntry(e) {
    return !!e && typeof e === 'object'
      && typeof e.cents === 'number' && Number.isSafeInteger(e.cents) && e.cents >= MIN_CENTS && e.cents <= MAX_CENTS
      && typeof e.effective_from === 'number' && Number.isSafeInteger(e.effective_from) && e.effective_from >= MIN_EFFECTIVE_FROM;
  }

  // the WRITE gate: a valid entry that takes effect no later than now + MAX_AHEAD_MS (now = the writer's clock, ms)
  function writableEntry(e, now) {
    return validEntry(e) && typeof now === 'number' && Number.isFinite(now) && e.effective_from <= now + MAX_AHEAD_MS;
  }

  function rateCentsInEffect(entries, t) {
    if (!entries || typeof entries !== 'object' || typeof t !== 'number' || !Number.isFinite(t)) return null;
    var keys = Object.keys(entries).sort();
    var best = null;
    for (var i = 0; i < keys.length; i++) {
      var e = entries[keys[i]];
      if (!validEntry(e) || e.effective_from > t) continue;
      if (best === null || e.effective_from >= best.effective_from) best = e;   // >= : the later key wins a tie
    }
    return best === null ? null : best.cents;
  }

  function shiftEarningsCents(deliveries, entries) {
    if (!entries || typeof entries !== 'object') return null;
    var list = deliveries || [];
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var at = d && typeof d.delivered_at === 'number' ? d.delivered_at : null;
      var c = at === null ? null : rateCentsInEffect(entries, at);
      if (c === null) return null;
      total += c;
    }
    return total;
  }

  return {
    rateCentsInEffect: rateCentsInEffect, shiftEarningsCents: shiftEarningsCents, validEntry: validEntry, writableEntry: writableEntry,
    MIN_CENTS: MIN_CENTS, MAX_CENTS: MAX_CENTS, MIN_EFFECTIVE_FROM: MIN_EFFECTIVE_FROM, MAX_AHEAD_MS: MAX_AHEAD_MS
  };
}));
