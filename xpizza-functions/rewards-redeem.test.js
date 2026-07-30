'use strict';
// Unit test for the v2 redemption calculator (rewards-redeem.js). Run: node rewards-redeem.test.js
const assert = require('assert');
const { computeRedemption, laMusaPriceCents, costPtsFor, redemptionFingerprint } = require('./rewards-redeem');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const XCART = [{ name: 'Pepperoni', qty: 1 }];                 // any non-empty paid cart (reward is chosen, not from cart)
const LCART = [{ id: 'noodle_02', qty: 1, name: 'Broccoli Beef' }];
const xp = (redeem) => computeRedemption({ redeem, items: XCART, restaurantId: 'x_pizza' });
const lm = (redeem) => computeRedemption({ redeem, items: LCART, restaurantId: 'la_musa' });

// ── costPtsFor — round(price_L × 10/3) ──
assert.strictEqual(costPtsFor(22300), 743);   // L223 dim sum
assert.strictEqual(costPtsFor(4000), 133);    // L40 soft
assert.strictEqual(costPtsFor(5000), 167);    // L50 rice_white
assert.strictEqual(costPtsFor(58800), 1960);  // L588 special
ok('costPtsFor = round(price_L × 10/3): 223→743, 40→133, 50→167, 588→1960');

// ── X. Pizza — choose ANY 12" individual, added free ──
{
  const r = xp({ type: 'free_pizza_choice', item_id: 'Margherita' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model, 'add_free');
  assert.strictEqual(r.cost, 8);
  assert.strictEqual(r.discount_cents, 0); ok('xp: model add_free, cost 8 punches, discount_cents 0 (total unchanged)');
  assert.deepStrictEqual(r.freeItems, [{ item_id: 'Margherita', qty: 1, price_cents: 29900, added: true }]); ok('xp: freeItems = the chosen pizza @ full price_cents (L299 → Ahorrás L299)');
  assert.deepStrictEqual(r.canonical, { restaurant_id: 'x_pizza', model: 'add_free', type: 'free_pizza_choice',
    config_version: 2, cost: 8, discount_cents: 0, free_item_key: 'Margherita' }); ok('xp: canonical = single-item shape { free_item_key:<name> }');
}
assert.strictEqual(xp({ type: 'free_pizza_choice', item_id: 'Margherita NY' }).reason, 'ineligible_item'); ok('xp: an 18" NY pie → ineligible_item (can never be freed)');
assert.strictEqual(xp({ type: 'free_pizza_choice', item_id: 'Nope' }).reason, 'ineligible_item');
assert.strictEqual(xp({ type: 'free_pizza_choice' }).reason, 'bad_request'); ok('xp: unknown pizza → ineligible; missing item_id → bad_request');

// ── La Musa — MULTISET à la carte ──
{
  const r = lm({ type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 2 }, { id: 'soft_01', qty: 1 }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model, 'add_free');
  assert.strictEqual(r.discount_cents, 0);
  assert.strictEqual(r.cost, 743 * 2 + 133); ok(`lm: cost = Σ(cost_pts × qty) = 743×2 + 133 = ${743 * 2 + 133}`);
  assert.deepStrictEqual(r.freeItems, [
    { item_id: 'dimsum_01', qty: 2, price_cents: 22300, cost_pts: 743, added: true },
    { item_id: 'soft_01', qty: 1, price_cents: 4000, cost_pts: 133, added: true },
  ]); ok('lm: freeItems sorted by id, per-unit cost_pts + price_cents');
  assert.deepStrictEqual(r.canonical.items, [
    { free_item_key: 'dimsum_01', cost: 743, qty: 2, price_cents: 22300 },
    { free_item_key: 'soft_01', cost: 133, qty: 1, price_cents: 4000 },
  ]);
  assert.strictEqual(r.canonical.total_cost, 743 * 2 + 133);
  assert.strictEqual(r.canonical.type, 'points_ala_carte');
  assert.strictEqual(r.canonical.config_version, 2); ok('lm: canonical = multiset { total_cost, items:[sorted] }');
}
// cross-namespace price (acompañamiento lives in EXTRAS)
assert.strictEqual(laMusaPriceCents('rice_white'), 5000);
{
  const r = lm({ type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1 }] });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.cost, 167); ok('lm: acompañamiento (extras namespace) priced cross-namespace → 167 pts');
}
// duplicate coalescing
{
  const r = lm({ type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1 }, { id: 'dimsum_01', qty: 2 }] });
  assert.deepStrictEqual(r.canonical.items, [{ free_item_key: 'dimsum_01', cost: 743, qty: 3, price_cents: 22300 }]);
  assert.strictEqual(r.cost, 743 * 3); ok('lm: duplicate ids COALESCE (1+2 → qty 3)');
}
// exclusions
assert.strictEqual(lm({ type: 'points_ala_carte', items: [{ id: 'beer_01', qty: 1 }] }).reason, 'ineligible_item'); ok('lm: alcohol (beer_*) → ineligible_item');
assert.strictEqual(lm({ type: 'points_ala_carte', items: [{ id: 'sauce_aioli', qty: 1 }] }).reason, 'ineligible_item');
assert.strictEqual(lm({ type: 'points_ala_carte', items: [{ id: 'protein_beef', qty: 1 }] }).reason, 'ineligible_item'); ok('lm: modifiers (sauce_*/protein_*) → ineligible_item');
// bad requests
assert.strictEqual(lm({ type: 'points_ala_carte', items: [] }).reason, 'bad_request');
assert.strictEqual(lm({ type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 0 }] }).reason, 'bad_request');
assert.strictEqual(lm({ type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1.5 }] }).reason, 'bad_request');
assert.strictEqual(lm({ type: 'points_ala_carte', items: [{ qty: 1 }] }).reason, 'bad_request');
assert.strictEqual(lm({ type: 'points_ala_carte', items: Array.from({ length: 100 }, () => ({ id: 'dimsum_01', qty: 1 })) }).reason, 'bad_request'); ok('lm: empty / bad-qty / missing-id / over-bound → bad_request');

// ── redemptionFingerprint — reorder-stable + coalesce-stable ──
{
  const a = lm({ type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 2 }, { id: 'soft_01', qty: 1 }] }).canonical;
  const b = lm({ type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 1 }, { id: 'dimsum_01', qty: 2 }] }).canonical;      // reordered
  const c = lm({ type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1 }, { id: 'soft_01', qty: 1 }, { id: 'dimsum_01', qty: 1 }] }).canonical; // dup-split
  assert.strictEqual(redemptionFingerprint(a), redemptionFingerprint(b)); ok('redemptionFingerprint: reorder-STABLE (request order can\'t change the hash)');
  assert.strictEqual(redemptionFingerprint(a), redemptionFingerprint(c)); ok('redemptionFingerprint: duplicate-coalesce-STABLE (split qtys hash the same)');
  const d = lm({ type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 3 }, { id: 'soft_01', qty: 1 }] }).canonical;      // different set
  assert.notStrictEqual(redemptionFingerprint(a), redemptionFingerprint(d)); ok('redemptionFingerprint: a DIFFERENT set hashes differently');
}

// ── dispatch guards ──
assert.strictEqual(computeRedemption({ redeem: { type: 'x' }, items: [], restaurantId: 'x_pizza' }).reason, 'bad_request');
assert.strictEqual(computeRedemption({ redeem: { type: 'x' }, items: XCART, restaurantId: 'nope' }).reason, 'bad_request');
assert.strictEqual(computeRedemption({}).reason, 'bad_request'); ok('computeRedemption: empty cart / unknown brand / no redeem → bad_request (never throws)');

console.log(`\nrewards-redeem: ${n} assertions passed`);
