'use strict';
// Reward-card display layer: summaryLines (menu-pricing) + earnPreview (rewards-core). Money-adjacent —
// summaryLines cents MUST foot to computeServerTotal (never drift from the charged total), incl. redeemed
// orders (the redemption footing line makes Σ === the DISCOUNTED total). Run: node reward-preview.test.js
const assert = require('assert');
const { computeServerTotal, summaryLines, MENU_BY_RESTAURANT } = require('./menu-pricing');
const { earnPreview } = require('./rewards-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const sum = (ls) => ls.reduce((s, l) => s + l.cents, 0);

// ── summaryLines FOOTS to computeServerTotal (non-redeemed) ──
{
  const items = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Anchovies', qty: 1 }];
  const ls = summaryLines(items, 'x_pizza');
  assert.strictEqual(sum(ls), Math.round(computeServerTotal(items, 'x_pizza').total * 100)); ok('xp non-redeem: Σ line cents === computeServerTotal*100 (extras included)');
  assert.ok(ls.some((l) => l.name === 'Anchovies' && l.qty === 1)); ok('xp: name = menu key, qty carried');
}
{
  const items = [{ id: 'dimsum_01', qty: 2, name: 'Sichuan Spicy Wonton' }];
  const ls = summaryLines(items, 'la_musa');
  assert.strictEqual(sum(ls), Math.round(computeServerTotal(items, 'la_musa').total * 100)); ok('lm non-redeem: Σ === computeServerTotal*100 (id-priced)');
  assert.strictEqual(ls[0].name, 'Sichuan Spicy Wonton'); ok('lm: name = client display string (server cents)');
  assert.strictEqual(summaryLines([{ id: 'dimsum_01', qty: 1, name: '<script>x</script>Wonton' }], 'la_musa')[0].name.includes('<'), false); ok('lm: name sanitized (no <>)');
}

// ── FOOTS to the DISCOUNTED total for redeemed orders (plan-gate (a)) ──
{
  // X. Pizza discount: full items + a negative Recompensa line → Σ === full − discount
  const items = [{ name: 'Margherita', qty: 1 }, { name: 'Anchovies', qty: 1 }];
  const full = Math.round(computeServerTotal(items, 'x_pizza').total * 100);
  const discount = MENU_BY_RESTAURANT.x_pizza.Margherita * 100;   // cheapest pizza comped
  const ls = summaryLines(items, 'x_pizza', { model: 'discount', discount_cents: discount, name: 'Margherita' });
  assert.strictEqual(sum(ls), full - discount); ok('xp redeemed: Σ === full − discount (discounted total foots)');
  assert.ok(ls.some((l) => l.cents === -discount && /Recompensa/.test(l.name))); ok('xp redeemed: a negative "· Recompensa" footing line');
}
{
  // La Musa add_free: items + the added item as a 0-cents GRATIS line → Σ === full total (unchanged)
  const items = [{ id: 'dimsum_01', qty: 1, name: 'Wonton' }];
  const full = Math.round(computeServerTotal(items, 'la_musa').total * 100);
  const ls = summaryLines(items, 'la_musa', { model: 'add_free', name: 'Coca-Cola' });
  assert.strictEqual(sum(ls), full); ok('lm redeemed: Σ === full (add_free is 0-cents, total unchanged)');
  assert.ok(ls.some((l) => l.cents === 0 && l.name === 'Coca-Cola')); ok('lm redeemed: added item as a 0-cents GRATIS line');
}

// ── fail-safe: bad cart → null (tracker falls back to items_text) ──
{
  assert.strictEqual(summaryLines([{ name: 'NopeNotAPizza', qty: 1 }], 'x_pizza'), null);
  assert.strictEqual(summaryLines([{ name: 'Margherita', qty: 0 }], 'x_pizza'), null);
  assert.strictEqual(summaryLines([], 'x_pizza'), null); ok('summaryLines: unknown item / bad qty / empty → null (fail-open)');
}

// ── earnPreview = { unit, delta, welcome, goal } (drift-proof — tracker embeds no constants) ──
{
  const xp = earnPreview({ items: [{ name: 'Margherita', qty: 3 }], subtotalCents: 78000, restaurantId: 'x_pizza' });
  assert.deepStrictEqual(xp, { unit: 'punch', delta: 3, welcome: 2, goal: 8 }); ok('earnPreview xp: {punch, delta=pizza count, welcome 2, goal 8}');
  const lm = earnPreview({ items: [{ id: 'dimsum_01', qty: 1 }], subtotalCents: 94200, restaurantId: 'la_musa' });
  assert.deepStrictEqual(lm, { unit: 'point', delta: Math.floor(94200 / 3000) * 10, welcome: 100, goal: 300 }); ok('earnPreview lm: {point, delta=floor(sub/3000)*10, welcome 100, goal 300}');
  assert.strictEqual(earnPreview({ restaurantId: 'x_pizza' }).delta, 0); ok('earnPreview: missing items → delta 0 (still returns the shape)');
}

console.log(`\nreward-preview: ${n} assertions passed`);
