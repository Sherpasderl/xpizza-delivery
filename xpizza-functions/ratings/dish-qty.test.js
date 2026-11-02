'use strict';
// S-B step 3 — dishQtyOf: the canonical dish-identity snapshot from the charged body lines, both brands, via the ONE resolver.
// Run: node ratings/dish-qty.test.js
const assert = require('assert');
const { dishQtyOf } = require('./dish-qty');
const { MENU_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ctx = (rid, o = {}) => ({ usableAsIdentity: true, objects: Object.keys(MENU_BY_RESTAURANT[rid]).map((k, i) => ({ kind: 'dish', legacyKey: k, canonicalId: `${rid}-c${i}` })), ...o });
const X = Object.keys(MENU_BY_RESTAURANT.x_pizza), L = Object.keys(MENU_BY_RESTAURANT.la_musa);

assert.deepStrictEqual(dishQtyOf([{ name: X[0], qty: 2, price: 1, extras: [{ name: 'x' }] }, { name: X[1], qty: 1 }, { name: X[0], qty: 1 }], 'x_pizza', ctx('x_pizza')), { 'x_pizza-c0': 3, 'x_pizza-c1': 1 });
assert.deepStrictEqual(dishQtyOf([{ id: L[2], name: 'client display', qty: 4 }], 'la_musa', ctx('la_musa')), { 'la_musa-c2': 4 }, 'la_musa keys by id (itemPricingKey), never the display name');
ok('x_pizza by name, la_musa by id (itemPricingKey — the charge\'s own key); repeated lines sum; client fields ignored');

for (const [why, items, c] of [['an unusable context', [{ name: X[0], qty: 1 }], ctx('x_pizza', { usableAsIdentity: false })], ['no context', [{ name: X[0], qty: 1 }], null],
  ['an unmapped line', [{ name: X[0], qty: 1 }, { name: 'NOT ON MENU', qty: 1 }], ctx('x_pizza')], ['a bad qty', [{ name: X[0], qty: 0 }], ctx('x_pizza')],
  ['empty', [], ctx('x_pizza')], ['not an array', 'x', ctx('x_pizza')], ['the other brand\'s context', [{ name: X[0], qty: 1 }], ctx('la_musa')]])
  assert.strictEqual(dishQtyOf(items, 'x_pizza', c), null, `🔴 ${why} ⇒ null (omitted, never partial)`);
ok('unusable / absent context, any unmapped line, a bad qty, empty / malformed, a foreign context ⇒ null — never a partial or guessed identity');
console.log(`dish-qty: OK (${n})`);
