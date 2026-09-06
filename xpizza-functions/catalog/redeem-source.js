'use strict';
// Portal 2a Task 6 — express the code's redemption allowlists as CATALOG data.
//
// Today eligibility is two hand-maintained constants in rewards-redeem-config.js. The store authors it
// instead: x_pizza by CATEGORY (`redeem_eligible_cats`), la_musa by an explicit extras allowlist
// (`redeem_eligible_extras`). Categories are the editable unit a merchant thinks in; the extras
// allowlist stays explicit because "not a modifier" is a heuristic and this gate must be fail-closed.
//
// This module is the SINGLE derivation, used by BOTH the seed (which authors the store) and the
// code-side build (which the pre-flip parity gate compares against). One function, so the two sides
// cannot drift and the cutover stays a provable no-op.
const { X_PIZZA_REDEEM_ELIGIBLE, LA_MUSA_ACOMP } = require('../rewards-redeem-config');

// x_pizza: find the categories that EXACTLY cover the static allowlist. Exact in both directions --
// every eligible pizza is in one of them AND every pizza in them is eligible. If the code's list ever
// stops being expressible as whole categories, that is a genuine surprise and must stop the migration
// rather than silently comp (or refuse) a pizza.
function redeemCatsForXPizza(items) {
  const cats = new Set();
  for (const it of items) if (X_PIZZA_REDEEM_ELIGIBLE.has(it.key)) cats.add(it.display && it.display.cat);
  const covered = items.filter((it) => cats.has(it.display && it.display.cat)).map((it) => it.key);
  const extra = covered.filter((k) => !X_PIZZA_REDEEM_ELIGIBLE.has(k));
  if (extra.length) {
    throw new Error(`redeem_cats_not_category_aligned: x_pizza — categories [${[...cats].sort().join(', ')}] also contain ineligible item(s) ${extra.join(', ')}; the code allowlist is no longer whole categories`);
  }
  const missing = [...X_PIZZA_REDEEM_ELIGIBLE].filter((k) => !covered.includes(k));
  if (missing.length) throw new Error(`redeem_cats_missing_items: x_pizza — ${missing.join(', ')} are eligible in code but in no covered category`);
  return [...cats].sort();
}

// la_musa: the acompanamientos, verified to exist in the extras namespace. A name that prices nothing
// would be an allowlist entry that can never be redeemed -- silent, and worth failing on.
function redeemExtrasForLaMusa(extrasTable) {
  const out = [];
  for (const id of [...LA_MUSA_ACOMP].sort()) {
    if (!Object.prototype.hasOwnProperty.call(extrasTable || {}, id)) throw new Error(`redeem_extra_unpriced: la_musa/${id}`);
    out.push(id);
  }
  return out;
}

// Attach the authored fields to a structure, per brand. The ONLY writer of these two field names.
function attachRedeemFields(restaurantId, structure, items, extrasTable) {
  if (restaurantId === 'x_pizza') structure.redeem_eligible_cats = redeemCatsForXPizza(items);
  else if (restaurantId === 'la_musa') structure.redeem_eligible_extras = redeemExtrasForLaMusa(extrasTable);
  return structure;
}

module.exports = { attachRedeemFields, redeemCatsForXPizza, redeemExtrasForLaMusa };
