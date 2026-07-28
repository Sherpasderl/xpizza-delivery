'use strict';
// Unit test for the redemption config module (rewards-redeem-config.js). Run: node rewards-redeem-config.test.js
const assert = require('assert');
const { REDEMPTION_CONFIG_VERSION, REDEMPTION_CONFIG, getTier, itemInTier, redemptionEnabled } = require('./rewards-redeem-config');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── version + shape ──
assert.strictEqual(typeof REDEMPTION_CONFIG_VERSION, 'number'); assert.ok(REDEMPTION_CONFIG_VERSION >= 1); ok('config version is numeric (>=1)');
assert.strictEqual(REDEMPTION_CONFIG.x_pizza.kind, 'punch');
assert.strictEqual(REDEMPTION_CONFIG.x_pizza.cost, 8);
assert.strictEqual(REDEMPTION_CONFIG.x_pizza.reward, 'discount_cheapest_pizza'); ok('x_pizza = punch, cost 8, discount_cheapest_pizza');
assert.strictEqual(REDEMPTION_CONFIG.la_musa.kind, 'points');
assert.deepStrictEqual(REDEMPTION_CONFIG.la_musa.tiers.map((t) => t.cost), [500, 1000, 1500, 2500, 3500]); ok('la_musa tiers cost ladder 500/1000/1500/2500/3500');
assert.deepStrictEqual(REDEMPTION_CONFIG.la_musa.tiers.map((t) => t.level), [1, 2, 3, 4, 5]); ok('la_musa tier levels 1..5');

// ── getTier ──
assert.strictEqual(getTier('la_musa', 1).cost, 500);
assert.strictEqual(getTier('la_musa', 5).cost, 3500);
assert.strictEqual(getTier('la_musa', 9), null); ok('getTier resolves by level; unknown level → null');
assert.strictEqual(getTier('x_pizza', 1), null); ok('getTier on a brand with no tiers → null');

// ── itemInTier true/false ──
assert.strictEqual(itemInTier('la_musa', 1, 'soft_01'), true);
assert.strictEqual(itemInTier('la_musa', 1, 'rice_white'), true);            // acompañamiento (extras namespace) is a valid L1 reward id
assert.strictEqual(itemInTier('la_musa', 3, 'noodle_01_camaron'), true); ok('itemInTier true for a listed item (incl. extras-namespace + protein variant)');
assert.strictEqual(itemInTier('la_musa', 1, 'special_01'), false);          // special_01 is a level-5 item, NOT level-1
assert.strictEqual(itemInTier('la_musa', 3, 'soft_01'), false);
assert.strictEqual(itemInTier('la_musa', 2, 'not_a_real_id'), false);
assert.strictEqual(itemInTier('la_musa', 1, undefined), false);
assert.strictEqual(itemInTier('la_musa', 9, 'soft_01'), false);             // unknown level
assert.strictEqual(itemInTier('x_pizza', 1, 'anything'), false); ok('itemInTier false for wrong-tier / unknown / brand-without-tiers');

// no item appears in two tiers (a redemption level must be unambiguous)
{
  const seen = new Map();
  for (const t of REDEMPTION_CONFIG.la_musa.tiers) for (const id of t.items) {
    assert.ok(!seen.has(id), `item ${id} appears in tiers ${seen.get(id)} and ${t.level}`);
    seen.set(id, t.level);
  }
  ok('every la_musa reward item belongs to exactly ONE tier (no cross-tier ambiguity)');
}

// ── redemptionEnabled: default + fail-safe false ──
const dbWith = (val, throws) => ({ ref: () => ({ get: async () => { if (throws) throw new Error('boom'); return { val: () => val }; } }) });
(async () => {
  assert.strictEqual(await redemptionEnabled(dbWith(undefined)), false); ok('redemptionEnabled: absent flag → false (default off)');
  assert.strictEqual(await redemptionEnabled(dbWith(false)), false);
  assert.strictEqual(await redemptionEnabled(dbWith('true')), false);        // string, not boolean → false
  assert.strictEqual(await redemptionEnabled(dbWith(1)), false); ok('redemptionEnabled: only strict boolean true enables (false/"true"/1 → off)');
  assert.strictEqual(await redemptionEnabled(dbWith(true)), true); ok('redemptionEnabled: strict true → enabled');
  assert.strictEqual(await redemptionEnabled(dbWith(null, true)), false); ok('redemptionEnabled: read throws → fail-safe off');
  console.log(`\nrewards-redeem-config: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
