'use strict';

// Unit test for restaurant_id acceptance (restaurant-id.js): the resolve policy
// (missing → x_pizza, known → itself, unknown → 400) and the legacy-normalized idempotency
// compare (a stored order with no restaurant_id is a pre-Phase-0 x_pizza order).
// Run: node restaurant-id.test.js
const assert = require('assert');
const { MENU_BY_RESTAURANT } = require('./menu-pricing');
const { KNOWN_RESTAURANTS, DEFAULT_RESTAURANT_ID, resolveRestaurantId, sameRestaurant } = require('./restaurant-id');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── resolveRestaurantId ──
assert.deepStrictEqual(resolveRestaurantId(undefined), { restaurantId: 'x_pizza', error: null, defaulted: true }); ok('missing (undefined) → x_pizza, defaulted');
assert.deepStrictEqual(resolveRestaurantId(null), { restaurantId: 'x_pizza', error: null, defaulted: true }); ok('missing (null) → x_pizza, defaulted');
assert.deepStrictEqual(resolveRestaurantId(''), { restaurantId: 'x_pizza', error: null, defaulted: true }); ok('blank → x_pizza, defaulted');
assert.deepStrictEqual(resolveRestaurantId('   '), { restaurantId: 'x_pizza', error: null, defaulted: true }); ok('whitespace-only → x_pizza, defaulted (trim, not 400)');
assert.deepStrictEqual(resolveRestaurantId('x_pizza'), { restaurantId: 'x_pizza', error: null, defaulted: false }); ok('explicit x_pizza → x_pizza, not defaulted');
assert.deepStrictEqual(resolveRestaurantId('la_musa'), { restaurantId: 'la_musa', error: null, defaulted: false }); ok('la_musa → la_musa (accepted at id layer; active-gate enforces dark)');

const bad = resolveRestaurantId('taco_bell');
assert.equal(bad.restaurantId, null); assert.equal(bad.defaulted, false);
assert.equal(bad.error, 'unknown restaurant_id: taco_bell'); ok('unknown → error, null id (→ 400)');
assert.equal(resolveRestaurantId({}).error, 'unknown restaurant_id: [object Object]'); ok('non-string coerced + rejected (no crash)');

// ── DEFAULT can only be a known restaurant ──
assert.ok(KNOWN_RESTAURANTS.has(DEFAULT_RESTAURANT_ID)); ok('DEFAULT_RESTAURANT_ID is a known restaurant');

// ── sameRestaurant (legacy-normalized idempotency compare) ──
assert.equal(sameRestaurant('x_pizza', 'x_pizza'), true); ok('x_pizza == x_pizza');
assert.equal(sameRestaurant(undefined, 'x_pizza'), true); ok('legacy (no restaurant_id) treated as x_pizza → idempotent retry stays idempotent');
assert.equal(sameRestaurant('', 'x_pizza'), true); ok('empty-string legacy → x_pizza');
assert.equal(sameRestaurant('la_musa', 'la_musa'), true); ok('la_musa == la_musa');
assert.equal(sameRestaurant('x_pizza', 'la_musa'), false); ok('x_pizza order vs la_musa request → conflict');
assert.equal(sameRestaurant('la_musa', 'x_pizza'), false); ok('la_musa order vs x_pizza request → conflict');
assert.equal(sameRestaurant(undefined, 'la_musa'), false); ok('legacy (x_pizza) vs la_musa request → conflict (no false idempotent)');

// ── consistency: the accept-set is exactly the priced restaurants (single source) ──
assert.deepStrictEqual([...KNOWN_RESTAURANTS].sort(), Object.keys(MENU_BY_RESTAURANT).sort()); ok('KNOWN_RESTAURANTS === MENU_BY_RESTAURANT keys (no drift)');

console.log(`restaurant-id: OK (${n} cases)`);
