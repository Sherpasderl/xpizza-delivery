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
const { X_PIZZA_REDEEM_ELIGIBLE, LA_MUSA_ACOMP, REDEMPTION_CONFIG } = require('../rewards-redeem-config');

// What the CODE says is redeemable today, per brand, for MENU items. This is the only place the old
// answer is consulted, and only to reproduce it exactly when authoring the store.
//
// la_musa's rule is a DENYLIST ("every dish except these prefixes"), which is the landmine: a namespace
// invented after the globs were written escapes them silently. Reading it here — once, at authoring
// time — converts it into an explicit allowlist that no future namespace can slip past.
const LA_MUSA_EXCLUDE_PREFIXES = (REDEMPTION_CONFIG.la_musa.exclude || []).map((g) => g.replace(/\*$/, ''));
function eligibleTodayFor(restaurantId, key) {
  if (restaurantId === 'x_pizza') return X_PIZZA_REDEEM_ELIGIBLE.has(key);
  if (restaurantId === 'la_musa') return !LA_MUSA_EXCLUDE_PREFIXES.some((p) => key.startsWith(p));
  return false;
}

// Compress today's per-item answer into (whole categories) + (individual leftovers). A category is
// authored only when EVERY item in it is eligible; a category with a mix contributes its eligible items
// one by one. `bebidas` is exactly that case — 8 beers and 4 soft drinks — which is why the per-item
// half is not optional: authoring the category would comp free beer, omitting it would refuse the softs.
//
// The result is verified to reproduce today's answer EXACTLY, in both directions, before it is returned.
function deriveRedeemAllow(restaurantId, items) {
  const byCat = new Map();
  for (const it of items) {
    const c = it.display && it.display.cat;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(it);
  }
  const cats = [], loose = [];
  for (const [cat, group] of byCat) {
    if (group.every((it) => eligibleTodayFor(restaurantId, it.key))) cats.push(cat);
    else for (const it of group) if (eligibleTodayFor(restaurantId, it.key)) loose.push(it.key);
  }
  cats.sort(); loose.sort();
  assertRedeemAllowMatchesToday(restaurantId, items, { cats, items: loose });
  return { cats, items: loose };
}

// The no-op proof, as a standalone check so it can be tested against a WRONG answer rather than only
// against the one the derivation happens to produce. Both directions matter and they are different
// bugs: over-derivation comps something for free, under-derivation refuses a legitimate redemption.
// The store is authored from this result exactly once, so a silent mis-derivation would be permanent.
function assertRedeemAllowMatchesToday(restaurantId, items, allow) {
  const catSet = new Set((allow && allow.cats) || []), looseSet = new Set((allow && allow.items) || []);
  const derived = new Set(items.filter((it) => catSet.has(it.display && it.display.cat) || looseSet.has(it.key)).map((it) => it.key));
  const today = new Set(items.filter((it) => eligibleTodayFor(restaurantId, it.key)).map((it) => it.key));
  const over = [...derived].filter((k) => !today.has(k));
  const under = [...today].filter((k) => !derived.has(k));
  if (over.length) throw new Error(`redeem_allow_over_derived: ${restaurantId} — ${over.join(', ')} would become redeemable`);
  if (under.length) throw new Error(`redeem_allow_under_derived: ${restaurantId} — ${under.join(', ')} would stop being redeemable`);
  return true;
}

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
  if (restaurantId !== 'x_pizza' && restaurantId !== 'la_musa') return structure;
  const { cats, items: loose } = deriveRedeemAllow(restaurantId, items);
  structure.redeem_eligible_cats = cats;
  if (loose.length) structure.redeem_eligible_items = loose;                        // omitted when empty (x_pizza)
  if (restaurantId === 'la_musa') structure.redeem_eligible_extras = redeemExtrasForLaMusa(extrasTable);
  // x_pizza's allowlist has always been whole categories; keep asserting it, so a code-side change that
  // breaks that shape is a loud failure at authoring time rather than a quiet per-item list.
  if (restaurantId === 'x_pizza') redeemCatsForXPizza(items);
  return structure;
}

module.exports = { attachRedeemFields, deriveRedeemAllow, assertRedeemAllowMatchesToday, redeemCatsForXPizza, redeemExtrasForLaMusa, eligibleTodayFor };
