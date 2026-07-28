'use strict';
// Unit test for the pure two-model redemption calculator (rewards-redeem.js). Run: node rewards-redeem.test.js
const assert = require('assert');
const { computeRedemption, laMusaPriceCents } = require('./rewards-redeem');
const { REDEMPTION_CONFIG, REDEMPTION_CONFIG_VERSION } = require('./rewards-redeem-config');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const xp = (items) => computeRedemption({ redeem: { type: 'discount_cheapest_pizza' }, items, restaurantId: 'x_pizza' });
const lm = (redeem, items = [{ id: 'dimsum_01', qty: 1 }]) => computeRedemption({ redeem, items, restaurantId: 'la_musa' });

// ── X. Pizza: discount the cheapest pizza's BASE UNIT ──
{
  const r = xp([{ name: 'Margherita', qty: 1 }, { name: 'Nutella', qty: 1 }]);   // 299 vs 251 → Nutella cheapest
  assert.strictEqual(r.ok, true); assert.strictEqual(r.model, 'discount'); assert.strictEqual(r.cost, 8);
  assert.strictEqual(r.discount_cents, 25100); assert.strictEqual(r.freeItem.line_key, 'Nutella');
  assert.strictEqual(r.freeItem.unit, true); assert.strictEqual(r.freeItem.line_index, 1); ok('xp: cheapest pizza unit (Nutella 251) → discount 25100, single unit, correct line');
}
{
  const r = xp([{ name: 'Margherita', qty: 3 }]);   // free ONE unit of a qty-3 line, not all three
  assert.strictEqual(r.discount_cents, 29900); assert.strictEqual(r.freeItem.unit, true); ok('xp: qty>1 line → exactly ONE base unit freed (discount = unit price, not ×qty)');
}
{
  // extras never make a line "cheaper" for selection — base unit price only (Anchovies 418 vs Ham 282)
  const r = xp([{ name: 'Anchovies', qty: 1, extras: [{ name: 'Mozzarella' }] }, { name: 'Ham', qty: 1 }]);
  assert.strictEqual(r.freeItem.line_key, 'Ham'); assert.strictEqual(r.discount_cents, 28200); ok('xp: selection uses BASE unit price, ignores extras (Ham 282 beats Anchovies 418+extra)');
}
{
  const r = xp([{ name: 'NotARealPizza', qty: 1 }]);   // no valid pizza line
  assert.deepStrictEqual(r, { ok: false, reason: 'no_eligible_item' }); ok('xp: no eligible pizza → ok:false no_eligible_item');
}

// ── La Musa: add a chosen eligible tier item free (0-price) ──
{
  const r = lm({ type: 'free_item', level: 1, item_id: 'soft_01' });   // menu-namespace, 40 → 4000
  assert.strictEqual(r.ok, true); assert.strictEqual(r.model, 'add_free'); assert.strictEqual(r.cost, 500);
  assert.strictEqual(r.discount_cents, 0); assert.deepStrictEqual(r.freeItem, { item_id: 'soft_01', price_cents: 4000, added: true }); ok('lm L1 soft_01 (menu) → add_free, cost 500, discount 0, price 4000, added');
}
{
  const r = lm({ type: 'free_item', level: 1, item_id: 'rice_white' });   // EXTRAS-namespace, 50 → 5000
  assert.strictEqual(r.ok, true); assert.strictEqual(r.freeItem.price_cents, 5000); assert.strictEqual(r.discount_cents, 0); ok('lm L1 rice_white (EXTRAS namespace) → priced 5000 (cross-namespace lookup works)');
}
{
  const r = lm({ type: 'free_item', level: 5, item_id: 'special_01' });   // 588 → 58800
  assert.strictEqual(r.cost, 3500); assert.strictEqual(r.freeItem.price_cents, 58800); ok('lm L5 special_01 → cost 3500, price 58800');
}
{
  const r = lm({ type: 'free_item', level: 1, item_id: 'special_01' });   // special_01 is L5, not L1
  assert.deepStrictEqual(r, { ok: false, reason: 'ineligible_item' }); ok('lm wrong tier (special_01 @ L1) → ineligible_item');
}
{
  assert.deepStrictEqual(lm({ type: 'free_item', level: 2, item_id: 'not_a_real_id' }), { ok: false, reason: 'ineligible_item' }); ok('lm unknown item id → ineligible_item');
  assert.deepStrictEqual(lm({ type: 'free_item', level: 9, item_id: 'soft_01' }), { ok: false, reason: 'ineligible_item' }); ok('lm unknown tier level → ineligible_item');
}

// ── canonical shape carries config_version + model + server values ──
{
  const rx = xp([{ name: 'Ham', qty: 1 }]).canonical;
  assert.deepStrictEqual(rx, { restaurant_id: 'x_pizza', model: 'discount', type: 'discount_cheapest_pizza', config_version: REDEMPTION_CONFIG_VERSION, cost: 8, discount_cents: 28200, free_item_key: 'Ham' });
  const rl = lm({ type: 'free_item', level: 1, item_id: 'soft_01' }).canonical;
  assert.deepStrictEqual(rl, { restaurant_id: 'la_musa', model: 'add_free', type: 'add_free_item', config_version: REDEMPTION_CONFIG_VERSION, cost: 500, discount_cents: 0, free_item_key: 'soft_01' });
  assert.ok(!('line_index' in rx), 'line_index must NOT leak into canonical (fingerprint stability)'); ok('canonical: full server identity for both brands, config_version + model present, no line_index leak');
}

// ── never trusts client price/cost ──
{
  const r = xp([{ name: 'Margherita', qty: 1, price: 1, unit_price_cents: 1 }]);   // client-sent prices ignored
  assert.strictEqual(r.discount_cents, 29900); ok('xp: client-supplied price fields ignored — server menu price used');
  const r2 = lm({ type: 'free_item', level: 1, item_id: 'soft_01', price_cents: 999999 });
  assert.strictEqual(r2.freeItem.price_cents, 4000); ok('lm: client-supplied price ignored — server menu price used');
}

// ── garbage / malformed → bad_request, never throws ──
{
  assert.deepStrictEqual(computeRedemption({ redeem: null, items: [{ name: 'Ham', qty: 1 }], restaurantId: 'x_pizza' }), { ok: false, reason: 'bad_request' });
  assert.deepStrictEqual(computeRedemption({ redeem: {}, items: [], restaurantId: 'x_pizza' }), { ok: false, reason: 'bad_request' });
  assert.deepStrictEqual(computeRedemption({ redeem: {}, items: [{ name: 'Ham', qty: 1 }], restaurantId: 'unknown' }), { ok: false, reason: 'bad_request' });
  assert.deepStrictEqual(computeRedemption({ redeem: {}, items: null, restaurantId: 'la_musa' }), { ok: false, reason: 'bad_request' });
  assert.deepStrictEqual(lm({ type: 'free_item', level: 'x', item_id: 'soft_01' }), { ok: false, reason: 'bad_request' });
  assert.deepStrictEqual(lm({ type: 'free_item', item_id: 'soft_01' }), { ok: false, reason: 'bad_request' });   // missing level
  assert.deepStrictEqual(computeRedemption(), { ok: false, reason: 'bad_request' });   // no args
  ok('malformed input (null redeem / empty cart / unknown brand / bad level) → bad_request, no throw');
}

// ── invariant guard: EVERY la_musa tier id is priceable across both namespaces (no dead reward) ──
{
  for (const t of REDEMPTION_CONFIG.la_musa.tiers) for (const id of t.items) {
    assert.strictEqual(typeof laMusaPriceCents(id), 'number', `tier item ${id} (L${t.level}) has no price in menu OR extras`);
  }
  ok('every la_musa tier item resolves to a price across menu ∪ extras (no unpriceable reward)');
}

console.log(`\nrewards-redeem: ${n} assertions passed`);
