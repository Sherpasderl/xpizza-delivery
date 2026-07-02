'use strict';

/**
 * Ready-Time Phase 0 — pure helpers for logOrderLifecycle (lifecycle-event instrumentation).
 *
 * Extracted so the counting + event-shape logic is golden-testable WITHOUT the emulator (the
 * project's extract-then-golden pattern). The trigger wiring — the status reads, the push, and the
 * first-entry transaction — stays in index.js; this module is PURE (no db / no I/O).
 *
 * Observer-only + additive: consumed by a function that READS orders/drivers and WRITES only two NEW
 * top-level trees (order_events, order_timelines). It never changes X. Pizza / La Musa behavior.
 * See READY_TIME_PHASE0.md (design, Codex-APPROVED df565bd).
 */

// kitchen_load_ahead = the count of OTHER `{new, preparing}` orders for THIS restaurant, EXCLUDING the
// order being logged (queue-ahead-at-arrival — the prep-time predictor, design decision 4). Inputs are
// the two indexed status-read maps `{ orderId: orderRecord }`. Legacy pre-Phase-0 orders have no
// `restaurant_id` → normalized to 'x_pizza' (mirrors every other reader). `restaurantId` is already
// normalized by the caller. Explicitly exclusive of self.
function countKitchenLoadAhead(newOrders, preparingOrders, restaurantId, selfOrderId) {
  let n = 0;
  for (const src of [newOrders, preparingOrders]) {
    for (const [id, rec] of Object.entries(src || {})) {
      if (id === selfOrderId) continue;                              // exclude the order being logged
      if (((rec && rec.restaurant_id) || 'x_pizza') !== restaurantId) continue;  // same restaurant only
      n++;
    }
  }
  return n;
}

// Driver supply snapshot — a COARSE proxy, NOT eligibility (design decision 6; real assignability is
// pickEligibleDriver). TWO counts because `available=0` is ambiguous (empty fleet vs all-busy both read
// 0) — `on_shift` disambiguates. Both from a SINGLE /drivers read filtered in memory (small collection;
// graduate to maintained counters at volume). Enum: off_shift|available|assigned|at_restaurant|
// en_route_delivery|returning|on_break (there is no 'online' status). Input is a `{ driverId: rec }` map.
function countDriverSupply(drivers) {
  let available = 0, onShift = 0;
  for (const rec of Object.values(drivers || {})) {
    const s = rec && rec.status;
    if (s === 'available') available++;
    if (s && s !== 'off_shift') onShift++;   // on_shift = working (available OR busy), i.e. not off_shift
  }
  return { drivers_available: available, drivers_on_shift: onShift };
}

// The immutable event record (audit spine) — one per REAL transition. `from` is the previous status
// (null for the first observed transition); `now` is injected (ServerValue.TIMESTAMP in prod).
function buildLifecycleEvent({ from, to, restaurantId, kitchenLoadAhead, driversAvailable, driversOnShift, now }) {
  return {
    from: from == null ? null : from,
    to,
    at: now,
    restaurant_id: restaurantId,
    kitchen_load_ahead: kitchenLoadAhead,
    drivers_available: driversAvailable,
    drivers_on_shift: driversOnShift,
  };
}

// The per-status first-entry timeline key: `order_timelines/{orderId}/{to}_at`.
const timelineStampKey = (to) => `${to}_at`;

module.exports = { countKitchenLoadAhead, countDriverSupply, buildLifecycleEvent, timelineStampKey };
