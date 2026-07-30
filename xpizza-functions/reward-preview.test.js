'use strict';
// Reward-card display layer (v2): summaryLines (menu-pricing) + earnPreview (rewards-core). Money-adjacent —
// summaryLines cents MUST foot to computeServerTotal (never drift from the charged total). v2 is ADD-FREE for
// both brands: every redeemed item is a 0-cents line, so Σ === the (unchanged) total. Run: node reward-preview.test.js
const assert = require('assert');
const { computeServerTotal, summaryLines } = require('./menu-pricing');
const { earnPreview, computeEarn, REWARDS_CONFIG } = require('./rewards-core');
const { REDEMPTION_CONFIG } = require('./rewards-redeem-config');
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

// ── FOOTS to the UNCHANGED total for redeemed orders (v2 add-free: free lines are 0-cents) ──
{
  // X. Pizza add_free: paid items + the chosen free pizza as a 0-cents line → Σ === full (total unchanged)
  const items = [{ name: 'Margherita', qty: 1 }, { name: 'Anchovies', qty: 1 }];
  const full = Math.round(computeServerTotal(items, 'x_pizza').total * 100);
  const ls = summaryLines(items, 'x_pizza', { model: 'add_free', items: [{ name: 'Pepperoni', qty: 1 }] });
  assert.strictEqual(sum(ls), full); ok('xp redeemed: Σ === full (add-free pizza is a 0-cents line, total unchanged)');
  assert.ok(ls.some((l) => l.cents === 0 && l.name === 'Pepperoni' && l.qty === 1)); ok('xp redeemed: the free pizza is a 0-cents line (no negative discount line)');
}
{
  // La Musa MULTISET add_free: paid item + N 0-cents free lines (qty-aware) → Σ === full (unchanged)
  const items = [{ id: 'dimsum_01', qty: 1, name: 'Wonton' }];
  const full = Math.round(computeServerTotal(items, 'la_musa').total * 100);
  const ls = summaryLines(items, 'la_musa', { model: 'add_free', items: [{ name: 'Coca-Cola', qty: 2 }, { name: 'Papas', qty: 1 }] });
  assert.strictEqual(sum(ls), full); ok('lm redeemed: Σ === full (all free lines 0-cents, multiset)');
  assert.ok(ls.some((l) => l.cents === 0 && l.name === 'Coca-Cola' && l.qty === 2)); ok('lm redeemed: a 0-cents free line per redeemed item, qty carried (×2)');
  assert.strictEqual(ls.filter((l) => l.cents === 0).length, 2); ok('lm redeemed: N free lines for an N-item multiset');
}

// ── fail-safe: bad cart / bad free-line qty → null (tracker falls back to items_text) ──
{
  assert.strictEqual(summaryLines([{ name: 'NopeNotAPizza', qty: 1 }], 'x_pizza'), null);
  assert.strictEqual(summaryLines([{ name: 'Margherita', qty: 0 }], 'x_pizza'), null);
  assert.strictEqual(summaryLines([], 'x_pizza'), null);
  assert.strictEqual(summaryLines([{ id: 'dimsum_01', qty: 1, name: 'X' }], 'la_musa', { model: 'add_free', items: [{ name: 'X', qty: 0 }] }), null);
  ok('summaryLines: unknown item / bad qty / empty / bad free-line qty → null (fail-open)');
}

// ── earnPreview = { unit, delta, welcome, goal } (drift-proof — tracker embeds no constants) ──
{
  const xp = earnPreview({ items: [{ name: 'Margherita', qty: 3 }], subtotalCents: 78000, restaurantId: 'x_pizza' });
  assert.deepStrictEqual(xp, { unit: 'punch', delta: 3, welcome: 2, goal: 8 }); ok('earnPreview xp: {punch, delta=pizza count, welcome 2, goal 8}');
  const lm = earnPreview({ items: [{ id: 'dimsum_01', qty: 1 }], subtotalCents: 94200, restaurantId: 'la_musa' });
  assert.deepStrictEqual(lm, { unit: 'point', delta: Math.floor(94200 / 3000) * 10, welcome: 100, goal: 300 }); ok('earnPreview lm: {point, delta=floor(sub/3000)*10, welcome 100, goal 300}');
  assert.strictEqual(earnPreview({ restaurantId: 'x_pizza' }).delta, 0); ok('earnPreview: missing items → delta 0 (still returns the shape)');
}

// ── earn-preview === computeEarn === credited (v2: NO redemption adjustment) ──
{
  const items = [{ name: 'Margherita', qty: 3 }, { name: 'Anchovies', qty: 1 }];   // 4 PAID pizzas
  const raw = computeEarn({ items, restaurantId: 'x_pizza' }).delta;
  assert.strictEqual(raw, 4);
  assert.strictEqual(earnPreview({ items, restaurantId: 'x_pizza' }).delta, raw); ok('xp: earnPreview.delta === computeEarn (NO −1 — the add-free pizza is never in order.items, so it earns 0)');
  const lmItems = [{ id: 'dimsum_01', qty: 1 }];
  assert.strictEqual(
    earnPreview({ items: lmItems, subtotalCents: 94200, restaurantId: 'la_musa' }).delta,
    computeEarn({ items: lmItems, subtotalCents: 94200, restaurantId: 'la_musa' }).delta,
  ); ok('lm: earnPreview.delta === computeEarn (add-free 0-cents line absent from subtotal → already correct)');
}

// ── goal parity (CI drift guard) ──
{
  assert.strictEqual(REWARDS_CONFIG.x_pizza.goal, REDEMPTION_CONFIG.x_pizza.cost); ok(`goal parity: x_pizza.goal (${REWARDS_CONFIG.x_pizza.goal}) === REDEMPTION_CONFIG.x_pizza.cost (fill-the-card)`);
  // v2: La Musa redemption is a CONTINUOUS wallet (no tier) → goal is a decoupled display milestone; assert it's a sane positive constant.
  assert.ok(Number.isInteger(REWARDS_CONFIG.la_musa.goal) && REWARDS_CONFIG.la_musa.goal > 0); ok(`goal parity: la_musa.goal (${REWARDS_CONFIG.la_musa.goal}) is a positive display milestone (continuous wallet — no tier coupling)`);
  assert.strictEqual(REDEMPTION_CONFIG.la_musa.tiers, undefined); ok('la_musa has no tiers in v2 (goal↔tier coupling retired)');
}

console.log(`\nreward-preview: ${n} assertions passed`);
