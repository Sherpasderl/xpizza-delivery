'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-a — THE TYPED POLICY PRIMITIVE: which catalog objects each authored rule covers.
//
// One derivation, two projections:
//   • the TYPED one (this module): per RULE, per KIND (dish / extra), with whether the rule is
//     AUTHORED on this version and WHICH structure fields it came from. The resolved catalog context
//     carries this, so a dish and an extra that share a name are two distinct memberships.
//   • the legacy UNTYPED one: the Sets menu-gates.js has always returned (weekendOnlyKeysFrom,
//     pickupOnlyKeysFrom, redeemEligibleFrom). Those functions now CALL this primitive and flatten it,
//     and their output — members AND insertion order — is byte-identical to before (menu-gates.test.js
//     pins the old values; policy-primitive.test.js pins the flattening against the pre-D4-a bodies).
//
// 🔴 THE EXPRESSIONS ARE THE OLD ONES, VERBATIM. `x || []` fed to `new Set(...)` / `for…of` is what
// menu-gates did, including for a malformed non-array field; a "cleaner" Array.isArray guard here would
// change the legacy union for exactly the malformed versions nobody tests, which is the silent drift
// D4-a promises not to introduce. Authoredness is computed SEPARATELY, by gateAuthored's rule
// (Array.isArray), so the typed view can still say "this rule is not authored" without perturbing the
// legacy view.
//
// 🔴 UNAUTHORED IS NOT EMPTY. A rule whose field is absent derives an empty member set, but its
// per-object membership is `null` (unknown), never `false`: an empty redeem list means "nothing is
// redeemable", an absent one means "this version does not say". menu-gates draws the same line with its
// static fallbacks; the typed view draws it with null.
// ---------------------------------------------------------------------------

const RULES = Object.freeze(['weekend_only', 'pickup_only', 'redeem_eligible']);

const isAuthoredField = (structure, field) => Array.isArray(structure && structure[field]);

// Dish keys whose display.cat is in `cats` — the derivation weekend/pickup/redeem-by-category share.
function dishesInCats(built, catsField) {
  const cats = new Set((built && built.structure && built.structure[catsField]) || []);
  const keys = new Set();
  if (cats.size === 0) return keys;
  for (const it of (built && built.items) || []) {
    if (it && it.display && cats.has(it.display.cat)) keys.add(it.key);
  }
  return keys;
}

// ONE RULE PER FUNCTION, so each legacy menu-gates function evaluates only the fields it always read.
// A malformed redeem field must not be able to throw out of the WEEKEND derivation; composing all three
// inside one call would have made it so.
const authoredFields = (st, fields) => fields.filter((f) => isAuthoredField(st, f));

function weekendRule(built) {
  const st = (built && built.structure) || {};
  const prov = authoredFields(st, ['weekend_only_cats']);
  return { authored: prov.length > 0, provenance: prov, dish: dishesInCats(built, 'weekend_only_cats'), extra: new Set() };
}

function pickupRule(built) {
  const st = (built && built.structure) || {};
  const prov = authoredFields(st, ['pickup_only_cats']);
  return { authored: prov.length > 0, provenance: prov, dish: dishesInCats(built, 'pickup_only_cats'), extra: new Set() };
}

// Redemption: the three authored sources in the SAME order redeemEligibleFrom unioned them, so the
// flattened Set iterates identically: category-derived dishes, then explicit items, then extras.
function redeemRule(built) {
  const st = (built && built.structure) || {};
  const dish = new Set();
  const cats = new Set(st.redeem_eligible_cats || []);
  if (cats.size > 0) for (const it of (built && built.items) || []) {
    if (it && it.display && cats.has(it.display.cat)) dish.add(it.key);
  }
  for (const k of st.redeem_eligible_items || []) dish.add(k);
  const extra = new Set();
  for (const k of st.redeem_eligible_extras || []) extra.add(k);
  const prov = authoredFields(st, ['redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras']);
  return { authored: prov.length > 0, provenance: prov, dish, extra };
}

// policyOf(built) → { weekend_only, pickup_only, redeem_eligible }, each
//   { authored: boolean, provenance: [authored structure field names], dish: Set, extra: Set }
function policyOf(built) {
  return { weekend_only: weekendRule(built), pickup_only: pickupRule(built), redeem_eligible: redeemRule(built) };
}

// The legacy UNTYPED union for a rule: dish members then extra members, in insertion order.
function untypedUnion(rule) {
  const out = new Set();
  for (const k of rule.dish) out.add(k);
  for (const k of rule.extra) out.add(k);
  return out;
}

// One object's memberships. null = the rule is not authored on this version (unknown, not "no").
function membershipsFor(policy, kind, key) {
  const out = {};
  for (const r of RULES) {
    const rule = policy[r];
    out[r] = rule.authored ? rule[kind].has(key) : null;
  }
  return out;
}

// The rule-level summary carried once per context (Sets are not serialisable; members are per object).
function ruleSummary(policy) {
  const out = {};
  for (const r of RULES) out[r] = { authored: policy[r].authored, provenance: [...policy[r].provenance] };
  return out;
}

module.exports = { policyOf, weekendRule, pickupRule, redeemRule, untypedUnion, membershipsFor, ruleSummary, isAuthoredField, RULES };
