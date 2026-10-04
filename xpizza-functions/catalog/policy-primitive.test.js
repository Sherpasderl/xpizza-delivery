'use strict';
// Portal 1D · D4-a — the typed policy primitive, and the LEGACY UNTYPED UNIONS it must leave untouched.
//
// 🔴 THE GOLDEN IS THE PRE-D4-a CODE, FROZEN HERE VERBATIM. The three `legacy*` functions below are
// copied character-for-character from catalog/menu-gates.js at main 06353c7 (the bodies D4-a replaced).
// Comparing the refactored functions against THEM — members AND insertion order — over the two real
// catalogs plus malformed shapes is what "the legacy untyped union stays byte-identical" means. A
// sensitivity partner proves the comparison can fail.
const assert = require('assert');
const P = require('./policy-primitive');
const G = require('./menu-gates');
const { catalogSnapshot } = require('./generate-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── FROZEN: catalog/menu-gates.js @ 06353c7, lines 37-56 and 64-81, verbatim ──────────────────────
function legacyWeekendOnlyKeysFrom(restaurantId, built) {
  const cats = new Set((built && built.structure && built.structure.weekend_only_cats) || []);
  const keys = new Set();
  if (cats.size === 0) return keys;
  for (const it of (built && built.items) || []) {
    if (it && it.display && cats.has(it.display.cat)) keys.add(it.key);
  }
  return keys;
}
function legacyPickupOnlyKeysFrom(restaurantId, built) {
  const cats = new Set((built && built.structure && built.structure.pickup_only_cats) || []);
  const keys = new Set();
  if (cats.size === 0) return keys;
  for (const it of (built && built.items) || []) {
    if (it && it.display && cats.has(it.display.cat)) keys.add(it.key);
  }
  return keys;
}
function legacyRedeemEligibleFrom(restaurantId, built) {
  const st = (built && built.structure) || {};
  const allow = new Set();
  const cats = new Set(st.redeem_eligible_cats || []);
  if (cats.size > 0) for (const it of (built && built.items) || []) {
    if (it && it.display && cats.has(it.display.cat)) allow.add(it.key);
  }
  for (const k of st.redeem_eligible_items || []) allow.add(k);
  for (const k of st.redeem_eligible_extras || []) allow.add(k);
  return { restaurantId, allow };
}
// ────────────────────────────────────────────────────────────────────────────────────────────────

const seq = (set) => JSON.stringify([...set]);   // members AND order
const outcome = (fn) => { try { return { v: fn() }; } catch (e) { return { threw: e.constructor.name }; } };
const same = (a, b) => JSON.stringify(a.threw ? a : { v: a.v instanceof Set ? seq(a.v) : { rid: a.v.restaurantId, allow: seq(a.v.allow) } })
  === JSON.stringify(b.threw ? b : { v: b.v instanceof Set ? seq(b.v) : { rid: b.v.restaurantId, allow: seq(b.v.allow) } });

try {
  const real = ['x_pizza', 'la_musa'].map((rid) => [rid, catalogSnapshot(rid)]);
  const item = (key, cat) => ({ key, price: 100, display: { cat, name: key } });
  const shapes = [
    ['no structure', { items: [item('a', 'c')] }],
    ['null built', null],
    ['empty arrays', { items: [item('a', 'c')], structure: { weekend_only_cats: [], pickup_only_cats: [], redeem_eligible_cats: [], redeem_eligible_items: [], redeem_eligible_extras: [] } }],
    ['string (malformed) cats', { items: [item('a', 'c'), item('b', 'x')], structure: { weekend_only_cats: 'cx', pickup_only_cats: 'c', redeem_eligible_cats: 'c' } }],
    ['string (malformed) items/extras', { items: [item('a', 'c')], structure: { redeem_eligible_items: 'ab', redeem_eligible_extras: 'zz' } }],
    ['number (malformed) redeem items', { items: [item('a', 'c')], structure: { weekend_only_cats: ['c'], redeem_eligible_items: 7 } }],
    ['overlap + order', { items: [item('b', 'c'), item('a', 'c'), item('z', 'd')], structure: { redeem_eligible_cats: ['c'], redeem_eligible_items: ['z', 'a'], redeem_eligible_extras: ['a', 'q'] } }],
    ['items not iterable', { items: 5, structure: { weekend_only_cats: ['c'] } }],
  ];
  const all = [...real, ...shapes];
  let compared = 0;
  for (const [label, built] of all) {
    for (const rid of ['x_pizza', 'la_musa', 'synthetic_3']) {
      for (const [name, legacy, now] of [
        ['weekendOnlyKeysFrom', legacyWeekendOnlyKeysFrom, G.weekendOnlyKeysFrom],
        ['pickupOnlyKeysFrom', legacyPickupOnlyKeysFrom, G.pickupOnlyKeysFrom],
        ['redeemEligibleFrom', legacyRedeemEligibleFrom, G.redeemEligibleFrom],
      ]) {
        const want = outcome(() => legacy(rid, built));
        const got = outcome(() => now(rid, built));
        assert.ok(same(want, got), `🔴 ${name} on "${label}" (${rid}) diverged from the frozen pre-D4-a body: ${JSON.stringify(want.threw || [...(want.v.allow || want.v)])} vs ${JSON.stringify(got.threw || [...(got.v.allow || got.v)])}`);
        compared += 1;
      }
    }
  }
  // the real catalogs are not vacuous: the derivations produce non-empty sets
  assert.ok(G.weekendOnlyKeysFrom('x_pizza', real[0][1]).size > 0, 'premise — x_pizza has weekend-only dishes');
  assert.ok(G.redeemEligibleFrom('la_musa', real[1][1]).allow.size > 0, 'premise — la_musa has redeemable objects');
  ok(`the legacy UNTYPED unions are byte-identical (members, order, and throw-or-not) to the frozen pre-D4-a bodies: ${compared} comparisons over both real catalogs + ${shapes.length} malformed/edge shapes × 3 rids`);

  // Sensitivity partner: the comparison CAN fail — a reordered union is caught.
  const reordered = (rid, built) => { const r = legacyRedeemEligibleFrom(rid, built); return { restaurantId: rid, allow: new Set([...r.allow].reverse()) }; };
  const edge = shapes.find(([l]) => l === 'overlap + order')[1];
  assert.ok(!same(outcome(() => legacyRedeemEligibleFrom('x', edge)), outcome(() => reordered('x', edge))), 'the order-sensitive comparison detects a reordered union');
  ok('sensitivity: a union with the same members in a different order is detected as a divergence');

  // Authored / unauthored / explicit-empty — the typed view keeps "not said" apart from "nothing".
  const unauth = P.policyOf({ items: [item('a', 'c')], structure: {} });
  const empty = P.policyOf({ items: [item('a', 'c')], structure: { weekend_only_cats: [], redeem_eligible_items: [] } });
  const authored = P.policyOf({ items: [item('a', 'c')], structure: { weekend_only_cats: ['c'], pickup_only_cats: ['c'] } });
  assert.deepStrictEqual(P.membershipsFor(unauth, 'dish', 'a'), { weekend_only: null, pickup_only: null, redeem_eligible: null }, 'UNAUTHORED → null (unknown)');
  assert.deepStrictEqual(P.membershipsFor(empty, 'dish', 'a'), { weekend_only: false, pickup_only: null, redeem_eligible: false }, 'EXPLICIT EMPTY → false');
  assert.deepStrictEqual(P.membershipsFor(authored, 'dish', 'a'), { weekend_only: true, pickup_only: true, redeem_eligible: null });
  assert.deepStrictEqual(P.ruleSummary(empty).redeem_eligible, { authored: true, provenance: ['redeem_eligible_items'] }, 'provenance names the authored field');
  assert.deepStrictEqual(P.ruleSummary(unauth).weekend_only, { authored: false, provenance: [] });
  ok('typed: unauthored → null, explicit-empty → false, authored → membership; provenance names the authored fields');

  // A same-name dish and extra are DISTINCT memberships (the untyped union cannot tell them apart).
  const shared = { items: [item('Pepperoni', 'p')], structure: { redeem_eligible_extras: ['Pepperoni'] } };
  const pol = P.policyOf(shared);
  assert.strictEqual(P.membershipsFor(pol, 'dish', 'Pepperoni').redeem_eligible, false, 'the DISH is not redeemable');
  assert.strictEqual(P.membershipsFor(pol, 'extra', 'Pepperoni').redeem_eligible, true, 'the EXTRA is');
  assert.ok(G.redeemEligibleFrom('x_pizza', shared).allow.has('Pepperoni'), '…while the legacy untyped union (unchanged) holds the shared name once');
  ok('a same-name dish and extra are distinct typed memberships; the legacy union is unchanged');

  // Brand-free: the typed derivation behaves identically for any rid (it takes none).
  assert.strictEqual(P.policyOf.length, 1, 'policyOf takes the built catalog only — no restaurant id to branch on');
  ok('the primitive takes no restaurant id, so it cannot branch on brand');

  console.log(`policy-primitive: OK (${n})`);
} catch (e) {
  console.error('policy-primitive FAILED:', e);
  process.exit(1);
}
