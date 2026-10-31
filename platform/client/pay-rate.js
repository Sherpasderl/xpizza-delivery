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
 *     - an entry counts only if cents is a positive INTEGER and effective_from a finite number; anything else is skipped;
 *     - a tie on effective_from: the later pushId (push keys sort chronologically) wins, so the answer is deterministic;
 *     - t not a finite number, no entries, or t before every effective_from → null (never retro-apply a later rate).
 *   shiftEarningsCents(deliveries, entries)   the sum of EACH delivery's own in-effect rate at its delivered_at.
 *     - null when entries is absent, or when ANY delivery has no in-effect rate (never a partial / invented total);
 *     - 0 for no deliveries with entries present.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PayRate = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function validEntry(e) {
    return !!e && typeof e === 'object'
      && typeof e.cents === 'number' && Number.isInteger(e.cents) && e.cents > 0
      && typeof e.effective_from === 'number' && Number.isFinite(e.effective_from);
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

  return { rateCentsInEffect: rateCentsInEffect, shiftEarningsCents: shiftEarningsCents, validEntry: validEntry };
}));
