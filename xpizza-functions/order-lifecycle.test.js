'use strict';

// Golden tests for the pure Ready-Time Phase-0 helpers (order-lifecycle.js). Run: node order-lifecycle.test.js
// The counting logic is the training-label's ephemeral context — a wrong count silently poisons every
// future prep-time model, so it's pinned here (the emulator gate proves the trigger wiring separately).
const assert = require('assert');
const { countKitchenLoadAhead, countDriverSupply, buildLifecycleEvent, timelineStampKey } = require('./order-lifecycle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── countKitchenLoadAhead — OTHER {new,preparing} for THIS restaurant, EXCLUDING self ──
{
  const news = {
    O_self: { restaurant_id: 'x_pizza' },   // self — excluded
    O_a:    { restaurant_id: 'x_pizza' },
    O_b:    { restaurant_id: 'la_musa' },    // other restaurant — excluded
    O_leg:  {},                              // legacy (no restaurant_id) → x_pizza
  };
  const prep = {
    O_c: { restaurant_id: 'x_pizza' },
    O_d: { restaurant_id: 'la_musa' },       // other restaurant — excluded
  };
  assert.strictEqual(countKitchenLoadAhead(news, prep, 'x_pizza', 'O_self'), 3); ok('x_pizza: O_a + O_leg(normalized) + O_c = 3 (self, la_musa excluded)');
  assert.strictEqual(countKitchenLoadAhead(news, prep, 'la_musa', 'ZZZ'), 2); ok('la_musa: O_b + O_d = 2');
  assert.strictEqual(countKitchenLoadAhead(news, prep, 'la_musa', 'O_b'), 1); ok('la_musa excluding O_b self = 1');
}
assert.strictEqual(countKitchenLoadAhead(null, null, 'x_pizza', 'X'), 0); ok('empty queues → 0 (no crash)');
assert.strictEqual(countKitchenLoadAhead({ X: { restaurant_id: 'x_pizza' } }, {}, 'x_pizza', 'X'), 0); ok('only self present → 0');
// legacy self with no restaurant_id, restaurant x_pizza
assert.strictEqual(countKitchenLoadAhead({ S: {}, A: {} }, {}, 'x_pizza', 'S'), 1); ok('legacy self excluded, legacy A counted for x_pizza = 1');

// ── countDriverSupply — drivers_available (=='available') + drivers_on_shift (!='off_shift') ──
// Two counts: available=0 is ambiguous (empty fleet vs all-busy both read 0); on_shift disambiguates.
{
  const drivers = {
    d1: { status: 'available' },              // available + on_shift
    d2: { status: 'available' },              // available + on_shift
    d3: { status: 'off_shift' },              // neither
    d4: { status: 'en_route_delivery' },      // busy: on_shift only (NOT available)
    d5: { status: 'on_break' },               // on_shift only
    d6: {},                                   // no status → neither
  };
  assert.deepStrictEqual(countDriverSupply(drivers), { drivers_available: 2, drivers_on_shift: 4 }); ok('available=2 (d1,d2); on_shift=4 (d1,d2,d4,d5) — off_shift + no-status excluded');
}
assert.deepStrictEqual(countDriverSupply(null), { drivers_available: 0, drivers_on_shift: 0 }); ok('no drivers → 0/0 (no crash)');
// the disambiguation the ruling is for: all-busy fleet → available 0 but on_shift > 0
assert.deepStrictEqual(countDriverSupply({ a: { status: 'assigned' }, b: { status: 'en_route_delivery' } }), { drivers_available: 0, drivers_on_shift: 2 }); ok('all-busy: available=0 but on_shift=2 (disambiguates empty-fleet 0/0)');
assert.deepStrictEqual(countDriverSupply({ a: { status: 'off_shift' } }), { drivers_available: 0, drivers_on_shift: 0 }); ok('all off_shift → 0/0');

// ── buildLifecycleEvent — immutable event shape ──
{
  const e = buildLifecycleEvent({ from: 'new', to: 'preparing', restaurantId: 'x_pizza', kitchenLoadAhead: 4, driversAvailable: 2, driversOnShift: 5, now: 1700 });
  assert.deepStrictEqual(e, { from: 'new', to: 'preparing', at: 1700, restaurant_id: 'x_pizza', kitchen_load_ahead: 4, drivers_available: 2, drivers_on_shift: 5 }); ok('event shape exact (from/to/at/restaurant_id/kitchen_load_ahead/drivers_available/drivers_on_shift)');
}
{
  const e = buildLifecycleEvent({ from: null, to: 'new', restaurantId: 'la_musa', kitchenLoadAhead: 0, driversAvailable: 0, driversOnShift: 0, now: 1701 });
  assert.strictEqual(e.from, null); ok('first observed transition → from: null');
  assert.strictEqual(e.to, 'new'); assert.strictEqual(e.at, 1701); ok('to + at carried through');
}
{
  const e = buildLifecycleEvent({ from: undefined, to: 'cancelled', restaurantId: 'x_pizza', kitchenLoadAhead: 1, driversAvailable: 1, driversOnShift: 3, now: 1702 });
  assert.strictEqual(e.from, null); ok('undefined from normalized to null (no undefined in RTDB write)');
}

// ── timelineStampKey — per-status first-entry key ──
assert.strictEqual(timelineStampKey('ready'), 'ready_at'); ok('timeline key ready → ready_at');
assert.strictEqual(timelineStampKey('new'), 'new_at'); ok('timeline key new → new_at (the label anchor)');

console.log(`order-lifecycle: OK (${n} cases)`);
