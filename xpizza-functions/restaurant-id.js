'use strict';

const { MENU_BY_RESTAURANT } = require('./menu-pricing');

// Restaurants the platform can ACCEPT an order for = those with a server price table. This is the
// first of two gates: getIdentity then requires a config-plane identity (fail-closed) AND active,
// so a "known" restaurant that is inactive (la_musa pre-launch) is still rejected at intake.
const KNOWN_RESTAURANTS = new Set(Object.keys(MENU_BY_RESTAURANT));
const DEFAULT_RESTAURANT_ID = 'x_pizza';

// Resolve the posted restaurant_id at the TOP of the handler — before pricing/idempotency/getIdentity.
//   missing / blank  → x_pizza (the live X. Pizza form sends none; keeps it working until the
//                      strict-flip in plan step 23a). `defaulted:true` so the caller can log it.
//   known            → itself.
//   unknown          → { error } → the handler returns 400 (never price/persist an unknown).
// Returns { restaurantId, error, defaulted }.
// 2a Task 8: `knownSet` is the live registry set (code floor ∪ the onboarded merchants), threaded in
// like every other catalog-derived input so this stays pure and synchronous — it runs at the very top
// of the handler, before pricing exists, so it cannot read anything itself. Omitted ⇒ the code set,
// which is today's exact behaviour. The registry can only ever ADD to that set, never subtract, so an
// unknown id is still fail-closed here and a registry outage can never un-know a live brand.
function resolveRestaurantId(raw, knownSet = null) {
  const known = (knownSet && typeof knownSet.has === 'function') ? knownSet : KNOWN_RESTAURANTS;
  const rid = String(raw == null ? '' : raw).trim();
  if (!rid) {
    return { restaurantId: DEFAULT_RESTAURANT_ID, error: null, defaulted: true };
  }
  if (!known.has(rid)) {
    return { restaurantId: null, error: `unknown restaurant_id: ${rid.slice(0, 40)}`, defaulted: false };
  }
  return { restaurantId: rid, error: null, defaulted: false };
}

// Idempotency / reuse compare. A stored order with NO restaurant_id is a pre-Phase-0 X. Pizza order,
// so a strict !== would 409 a legit idempotent retry — normalize the legacy value to x_pizza.
function sameRestaurant(existingRestaurantId, validatedRestaurantId) {
  return (existingRestaurantId || DEFAULT_RESTAURANT_ID) === validatedRestaurantId;
}

module.exports = { KNOWN_RESTAURANTS, DEFAULT_RESTAURANT_ID, resolveRestaurantId, sameRestaurant };
