'use strict';
// Unit test for the redemption config module (rewards-redeem-config.js) — v2. Run: node rewards-redeem-config.test.js
const assert = require('assert');
const { REDEMPTION_CONFIG_VERSION, REDEMPTION_CONFIG, REDEEM_POINTS_PER_LEMPIRA,
  isXPizzaEligible, isLaMusaEligible, isRedeemEligible, eligibleKeys, redemptionEnabled } = require('./rewards-redeem-config');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── version + shape (v2) ──
assert.strictEqual(REDEMPTION_CONFIG_VERSION, 2); ok('config version === 2 (v2 model)');
assert.strictEqual(REDEMPTION_CONFIG.x_pizza.kind, 'punch');
assert.strictEqual(REDEMPTION_CONFIG.x_pizza.cost, 8);
assert.strictEqual(REDEMPTION_CONFIG.x_pizza.reward, 'free_pizza_choice'); ok('x_pizza = punch, cost 8, free_pizza_choice (add-free choose-any)');
assert.strictEqual(REDEMPTION_CONFIG.la_musa.kind, 'points');
assert.strictEqual(REDEMPTION_CONFIG.la_musa.reward, 'points_ala_carte');
assert.strictEqual(REDEMPTION_CONFIG.la_musa.tiers, undefined); ok('la_musa = points, points_ala_carte, NO tiers (continuous wallet)');
assert.strictEqual(REDEMPTION_CONFIG.la_musa.rate, REDEEM_POINTS_PER_LEMPIRA);
assert.ok(Math.abs(REDEEM_POINTS_PER_LEMPIRA - 10 / 3) < 1e-12); ok('la_musa rate === REDEEM_POINTS_PER_LEMPIRA === 10/3 (~10% value-back)');

// ── X. Pizza eligible allowlist — 12" individual only, NY (18") EXCLUDED ──
assert.strictEqual(isXPizzaEligible('Margherita'), true);
assert.strictEqual(isXPizzaEligible('Nutella'), true);
assert.strictEqual(isXPizzaEligible('Anchovies'), true); ok('isXPizzaEligible true for 12" individual pizzas');
assert.strictEqual(isXPizzaEligible('Margherita NY'), false);
assert.strictEqual(isXPizzaEligible('Mushroom NY'), false);
assert.strictEqual(isXPizzaEligible('Carnivora NY'), false); ok('isXPizzaEligible FALSE for every 18" NY pie (excluded)');
assert.strictEqual(isXPizzaEligible('Not A Pizza'), false);
assert.strictEqual(isXPizzaEligible(''), false);
assert.strictEqual(isXPizzaEligible(undefined), false); ok('isXPizzaEligible false for unknown/empty (fail-closed allowlist)');
// every NY name is excluded AND every non-NY x_pizza menu key is eligible (canonical list ⊆ menu, NY ⊄ list)
{
  const { MENU_BY_RESTAURANT } = require('./menu-pricing');
  const keys = Object.keys(MENU_BY_RESTAURANT.x_pizza);
  const ny = keys.filter((k) => / NY$/.test(k));
  assert.ok(ny.length >= 6 && ny.every((k) => !isXPizzaEligible(k)), 'all NY pies excluded');
  assert.ok(keys.filter((k) => !/ NY$/.test(k)).every((k) => isXPizzaEligible(k)), 'all non-NY pies eligible');
  ok(`x_pizza eligible === menu minus the ${ny.length} NY pies (allowlist covers every 12" pizza)`);
}

// ── La Musa eligible — any non-alcohol MENU dish + the 3 acompañamientos; modifiers/alcohol excluded ──
assert.strictEqual(isLaMusaEligible('dimsum_01'), true);
assert.strictEqual(isLaMusaEligible('noodle_02'), true);
assert.strictEqual(isLaMusaEligible('soft_01'), true); ok('isLaMusaEligible true for non-alcohol menu dishes (incl. softs)');
assert.strictEqual(isLaMusaEligible('rice_white'), true);
assert.strictEqual(isLaMusaEligible('rice_chinese'), true);
assert.strictEqual(isLaMusaEligible('papas_fritas'), true); ok('isLaMusaEligible true for the 3 acompañamientos (EXTRAS namespace)');
assert.strictEqual(isLaMusaEligible('beer_01'), false);
assert.strictEqual(isLaMusaEligible('beer_08'), false); ok('isLaMusaEligible FALSE for alcohol (beer_*) — hidden from picker (still earns)');
assert.strictEqual(isLaMusaEligible('sauce_aioli'), false);
assert.strictEqual(isLaMusaEligible('protein_beef'), false);
assert.strictEqual(isLaMusaEligible('protein_chicken'), false); ok('isLaMusaEligible FALSE for modifiers (sauce_* / protein_*)');
assert.strictEqual(isLaMusaEligible('not_a_real_id'), false);
assert.strictEqual(isLaMusaEligible(undefined), false); ok('isLaMusaEligible false for unknown/empty');

// ── isRedeemEligible dispatch + eligibleKeys ──
assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita'), true);
assert.strictEqual(isRedeemEligible('x_pizza', 'Margherita NY'), false);
assert.strictEqual(isRedeemEligible('la_musa', 'dimsum_01'), true);
assert.strictEqual(isRedeemEligible('la_musa', 'beer_01'), false);
assert.strictEqual(isRedeemEligible('other', 'x'), false); ok('isRedeemEligible dispatches per brand');
{
  const xk = eligibleKeys('x_pizza'), lk = eligibleKeys('la_musa');
  assert.ok(xk.includes('Margherita') && !xk.includes('Margherita NY'));
  assert.ok(lk.includes('dimsum_01') && lk.includes('papas_fritas') && !lk.some((k) => k.startsWith('beer_')));
  ok('eligibleKeys(brand) returns the full eligible list (x_pizza no NY; la_musa no beer_*, incl. acompañamientos)');
}

// ── redemptionEnabled: default + fail-safe false (unchanged) ──
const dbMock = (flags = {}, throws = false) => ({ ref: (p) => ({ get: async () => { if (throws) throw new Error('boom'); return { val: () => flags[p] }; } }) });
const GLOBAL = 'config/redemption_enabled';
const ALLOW = (u) => `config/redemption_allowlist/${u}`;
(async () => {
  assert.strictEqual(await redemptionEnabled(dbMock({})), false); ok('redemptionEnabled: absent global flag → false (default off)');
  assert.strictEqual(await redemptionEnabled(dbMock({ [GLOBAL]: 'true' })), false);
  assert.strictEqual(await redemptionEnabled(dbMock({ [GLOBAL]: 1 })), false); ok('redemptionEnabled: only strict boolean true enables global');
  assert.strictEqual(await redemptionEnabled(dbMock({ [GLOBAL]: true })), true); ok('redemptionEnabled: strict global true → enabled');
  assert.strictEqual(await redemptionEnabled(dbMock({ [ALLOW('uX')]: true }), 'uX'), true); ok('redemptionEnabled: global OFF + allowlisted uid → enabled (canary)');
  assert.strictEqual(await redemptionEnabled(dbMock({}), 'uX'), false); ok('redemptionEnabled: global OFF + NON-allowlisted uid → off');
  assert.strictEqual(await redemptionEnabled(dbMock({ [ALLOW('uX')]: 1 }), 'uX'), false); ok('redemptionEnabled: non-boolean allowlist value → off');
  assert.strictEqual(await redemptionEnabled(dbMock({ [GLOBAL]: true, [ALLOW('uX')]: false }), 'uX'), true); ok('redemptionEnabled: global true wins regardless of allowlist');
  assert.strictEqual(await redemptionEnabled(dbMock({}, true), 'uX'), false); ok('redemptionEnabled: read throws → fail-closed OFF');
  console.log(`\nrewards-redeem-config: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
