'use strict';

// Unit + golden test for the restaurant-keyed server pricing (menu-pricing.js).
// Proves: (a) X. Pizza behavior is byte-identical to the original inline computeServerTotal
// (name-keyed, default restaurantId, same error strings, same qty bounds, extras fold once);
// (b) the #1 contract — x_pizza keys by NAME ONLY (a posted id is ignored, no reroute), la_musa
// keys by id; (c) cross-restaurant isolation; (d) the La Musa 40-item menu prices exactly.
// Run: node menu-pricing.test.js
const assert = require('assert');
const { MENU_BY_RESTAURANT, computeServerTotal } = require('./menu-pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── X. Pizza: byte-identical behavior (name-keyed, default restaurantId) ──
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 1 }]), { total: 299, error: null }); ok('x_pizza single item by name');
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 2 }, { name: 'Carnivora', qty: 1 }]), { total: 299 * 2 + 340, error: null }); ok('x_pizza multi-item');
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella' }, { name: 'Hongos' }] }]), { total: 299 + 50 + 61, error: null }); ok('x_pizza extras add once each');
assert.deepStrictEqual(computeServerTotal([{ name: 'Pepperoni', qty: 3 }]), computeServerTotal([{ name: 'Pepperoni', qty: 3 }], 'x_pizza')); ok('default restaurantId === x_pizza');

// rejections — exact error strings preserved from the original
assert.deepStrictEqual(computeServerTotal([]), { total: NaN, error: 'items must be a non-empty array' }); ok('empty items rejected');
assert.deepStrictEqual(computeServerTotal([{ name: 'Nope', qty: 1 }]), { total: NaN, error: 'unknown menu item: Nope' }); ok('x_pizza unknown item rejected');
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 0 }]), { total: NaN, error: 'invalid quantity for Margherita' }); ok('x_pizza qty < 1 rejected');
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 51 }]), { total: NaN, error: 'invalid quantity for Margherita' }); ok('x_pizza qty > 50 rejected');
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 1, extras: [{ name: 'Nope' }] }]), { total: NaN, error: 'unknown extra: Nope' }); ok('x_pizza unknown extra rejected');

// ── #1 contract: x_pizza keys by NAME ONLY — a posted id is ignored (no reroute) ──
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', id: 'dimsum_01', qty: 1 }]), { total: 299, error: null }); ok('x_pizza ignores a posted id (matches name)');
assert.equal(computeServerTotal([{ id: 'dimsum_01', qty: 1 }]).error, 'unknown menu item: undefined'); ok('x_pizza with no name → unknown (id never consulted)');

// ── La Musa: id-keyed ──
assert.deepStrictEqual(computeServerTotal([{ id: 'dimsum_01', qty: 1 }], 'la_musa'), { total: 223, error: null }); ok('la_musa single item by id');
assert.deepStrictEqual(computeServerTotal([{ id: 'beer_07', qty: 2 }, { id: 'soft_01', qty: 1 }], 'la_musa'), { total: 81 * 2 + 40, error: null }); ok('la_musa multi-item by id');
assert.equal(computeServerTotal([{ name: 'Sichuan Spicy Wonton', qty: 1 }], 'la_musa').error, 'unknown menu item: undefined'); ok('la_musa by name → unknown (id required)');
assert.equal(computeServerTotal([{ id: 'dimsum_01', qty: 1, extras: [{ name: 'Mozzarella' }] }], 'la_musa').error, 'unknown extra: Mozzarella'); ok('la_musa rejects extras (none defined)');

// ── cross-restaurant isolation ──
assert.ok(computeServerTotal([{ name: 'Margherita', qty: 1 }], 'la_musa').error.startsWith('unknown menu item')); ok('x_pizza item not priceable under la_musa');
assert.ok(computeServerTotal([{ id: 'dimsum_01', qty: 1 }], 'x_pizza').error.startsWith('unknown menu item')); ok('la_musa id not priceable under x_pizza');

// ── unknown restaurant → fail closed ──
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 1 }], 'taco_bell'), { total: NaN, error: 'unknown restaurant: taco_bell' }); ok('unknown restaurant rejected');

// ── table integrity ──
assert.equal(Object.keys(MENU_BY_RESTAURANT.x_pizza).length, 23); ok('x_pizza table has 23 items (unchanged)');

// ── La Musa 40-item table — REGRESSION SNAPSHOT (NOT a form-parity guard) ──
// Pins the la_musa table against accidental edits, like the COMBOS hash guard. This is NOT a
// form-vs-table parity check: there is no la-musa-orders/index.html in this repo yet (that's
// Proposal B). LA_MUSA_SNAPSHOT is the executor's transcription of the finalized menu; the real
// form ⊆ table parity test ships with Proposal B when the form exists. Until then la_musa is dark
// (no la_musa order flows), so the table is provisional but safe.
const LA_MUSA_SNAPSHOT = {
  dimsum_01: 223, dimsum_02: 248, dimsum_03: 198, dimsum_04: 237, dimsum_05: 260,
  starter_01: 262, starter_02: 252, starter_03: 265, starter_04: 378, starter_05: 413, starter_06: 409,
  special_01: 588, special_02: 478, special_04: 624, special_05: 384,
  crudo_01: 452, crudo_02: 346, crudo_03: 337,
  noodle_01: 414, noodle_02: 492, noodle_03: 340,
  rice_01: 270, rice_02: 456, rice_03: 448, rice_04: 392,
  soup_01: 255, soup_02: 288, soup_03: 192,
  beer_01: 102, beer_02: 102, beer_03: 102, beer_04: 98, beer_05: 102, beer_06: 102, beer_07: 81, beer_08: 81,
  soft_01: 40, soft_02: 40, soft_03: 40, soft_04: 40,
};
assert.deepStrictEqual(MENU_BY_RESTAURANT.la_musa, LA_MUSA_SNAPSHOT); ok('la_musa table matches pinned snapshot (regression guard; form⊆table parity ships with Proposal B)');
assert.equal(Object.keys(MENU_BY_RESTAURANT.la_musa).length, 40); ok('la_musa has exactly 40 items');
for (const [id, price] of Object.entries(LA_MUSA_SNAPSHOT)) {
  assert.deepStrictEqual(computeServerTotal([{ id, qty: 1 }], 'la_musa'), { total: price, error: null });
}
ok('all 40 la_musa ids price exactly');
const fullCart = Object.keys(LA_MUSA_SNAPSHOT).map((id) => ({ id, qty: 1 }));
const expectedSum = Object.values(LA_MUSA_SNAPSHOT).reduce((a, b) => a + b, 0);
assert.deepStrictEqual(computeServerTotal(fullCart, 'la_musa'), { total: expectedSum, error: null }); ok(`la_musa full-menu cart sums to L${expectedSum}`);

console.log(`menu-pricing: OK (${n} cases)`);
