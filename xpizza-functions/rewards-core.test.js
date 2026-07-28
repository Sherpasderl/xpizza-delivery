'use strict';
// Unit test for the pure rewards earn core (rewards-core.js). Run: node rewards-core.test.js
const assert = require('assert');
const { computeEarn, shouldEarnOnStatus, ledgerEntry, REWARDS_CONFIG, REWARDS_CONFIG_VERSION } = require('./rewards-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// x_pizza: 1 punch per pizza (sum of qty)
assert.deepStrictEqual(computeEarn({ items: [{ qty: 2 }, { qty: 3 }], restaurantId: 'x_pizza' }), { delta: 5, unit: 'punch' }); ok('x_pizza Σqty → punches');
assert.deepStrictEqual(computeEarn({ items: [], restaurantId: 'x_pizza' }), { delta: 0, unit: 'punch' }); ok('x_pizza empty → 0');
assert.deepStrictEqual(computeEarn({ items: [{ qty: 1 }, { qty: 0 }, { qty: -2 }, { qty: 1.5 }], restaurantId: 'x_pizza' }), { delta: 1, unit: 'punch' }); ok('x_pizza only positive-integer qty count');

// la_musa: 10 pts / 3000 cents (30 L); L700 = 70000 cents → floor(70000/3000)=23 → 230
assert.deepStrictEqual(computeEarn({ subtotalCents: 70000, restaurantId: 'la_musa' }), { delta: 230, unit: 'point' }); ok('la_musa 70000c → 230 pts');
assert.deepStrictEqual(computeEarn({ subtotalCents: 3000, restaurantId: 'la_musa' }), { delta: 10, unit: 'point' }); ok('la_musa exactly 30 L → 10 pts');
assert.deepStrictEqual(computeEarn({ subtotalCents: 2900, restaurantId: 'la_musa' }), { delta: 0, unit: 'point' }); ok('la_musa < 30 L → 0');
assert.deepStrictEqual(computeEarn({ subtotalCents: 9500, restaurantId: 'la_musa' }), { delta: 30, unit: 'point' }); ok('la_musa 95 L → floor(3.16)*10 = 30 (partial dropped)');

// fail-safe — never throws
assert.deepStrictEqual(computeEarn({ restaurantId: 'unknown' }), { delta: 0, unit: 'point' }); ok('unknown restaurant → 0');
assert.deepStrictEqual(computeEarn({ items: 'x', restaurantId: 'x_pizza' }), { delta: 0, unit: 'punch' }); ok('x_pizza non-array items → 0');
assert.deepStrictEqual(computeEarn({ subtotalCents: NaN, restaurantId: 'la_musa' }), { delta: 0, unit: 'point' }); ok('la_musa NaN cents → 0');
assert.deepStrictEqual(computeEarn(), { delta: 0, unit: 'point' }); ok('no args → 0 (no throw)');

// terminal-state gate: earn ONLY on delivered/completed (ready is pre-collection)
assert.strictEqual(shouldEarnOnStatus('delivered'), true); ok('gate: delivered → earn');
assert.strictEqual(shouldEarnOnStatus('completed'), true); ok('gate: completed → earn');
assert.strictEqual(shouldEarnOnStatus('ready'), false); ok('gate: ready → NO earn (pre-collection)');
['new', 'preparing', 'out_for_delivery', 'cancelled', null, undefined, ''].forEach((s) =>
  assert.strictEqual(shouldEarnOnStatus(s), false)); ok('gate: every non-terminal status → NO earn');

// welcome config locked
assert.strictEqual(REWARDS_CONFIG.x_pizza.welcome, 2); ok('x_pizza welcome = 2 punches');
assert.strictEqual(REWARDS_CONFIG.la_musa.welcome, 100); ok('la_musa welcome = 100 points');

// ledger entry: stamps version + ts, drops null keys
const e = ledgerEntry({ type: 'earn', delta: 5, orderId: 'O1', now: 100 });
assert.strictEqual(e.type, 'earn'); assert.strictEqual(e.delta, 5); assert.strictEqual(e.order_id, 'O1');
assert.strictEqual(e.ts, 100); assert.strictEqual(e.config_version, REWARDS_CONFIG_VERSION);
assert.ok(!('redemption_id' in e) && !('note' in e)); ok('ledgerEntry drops null keys, stamps ts + config_version');
const w = ledgerEntry({ type: 'welcome', delta: 2, now: 5 });
assert.ok(!('order_id' in w) && !('redemption_id' in w)); ok('welcome entry has no order_id/redemption_id');

console.log(`\nrewards-core: ${n} assertions passed`);
