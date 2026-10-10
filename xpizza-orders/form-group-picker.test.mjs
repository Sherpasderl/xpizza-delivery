// 1D add-product B — the shared required-choice picker's RULES, in Node. Run: node --test xpizza-orders/form-group-picker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const GP = require('./form-group-picker.js');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('sameDishId: strict WITHIN a type — strings with strings, finite numbers with numbers, never coerced', () => {
  assert.strictEqual(GP.sameDishId('a', 'a'), true);
  assert.strictEqual(GP.sameDishId(7, 7), true);
  for (const [a, b] of [['7', 7], [7, '7'], ['', 0], [NaN, NaN], [null, null], [undefined, undefined], [{}, {}], ['a', 'b'], [1, 2]]) {
    assert.strictEqual(GP.sameDishId(a, b), false, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

test('isLauncher / isVariant read the map and the record, for any id type', () => {
  assert.strictEqual(GP.isLauncher({ id: 'noodle_01' }, { noodle_01: {} }), true);
  assert.strictEqual(GP.isLauncher({ id: 30 }, { 30: {} }), true, 'numeric ids (object keys are strings; lookup coerces the same way the map was built)');
  assert.strictEqual(GP.isLauncher({ id: 'x' }, { noodle_01: {} }), false);
  assert.strictEqual(GP.isLauncher(null, { a: 1 }), false);
  assert.strictEqual(GP.isLauncher({ id: 'a' }, null), false);
  assert.deepStrictEqual([GP.isVariant({ variantOf: 'a' }), GP.isVariant({}), GP.isVariant(null)], [true, false, false]);
});

test('validateVariantBlock: the renderer’s own acceptance test, against the arriving dishes', () => {
  const dishes = [{ id: 'L' }, { id: 'a' }, { id: 'b' }];
  assert.doesNotThrow(() => GP.validateVariantBlock({ L: { basePrice: 5, variantIds: ['a', 'b'] } }, dishes, 'supplied'));
  const bad = [
    [null, /apply_variant_items_malformed@supplied/], [[], /apply_variant_items_malformed/],
    [{ L: null }, /apply_variant_cfg_malformed@supplied:L/], [{ L: { basePrice: 0, variantIds: ['a'] } }, /apply_variant_basePrice/],
    [{ L: { basePrice: 5, variantIds: [] } }, /apply_variant_ids_missing/], [{ L: { basePrice: 5, variantIds: [7] } }, /apply_variant_id_orphan@supplied:L:7/], [{ L: { basePrice: 5, variantIds: [null] } }, /apply_variant_id_type/],
    [{ L: { basePrice: 5, variantIds: ['zz'] } }, /apply_variant_id_orphan@supplied:L:zz/], [{ Q: { basePrice: 5, variantIds: ['a'] } }, /apply_variant_launcher_orphan@supplied:Q/],
  ];
  for (const [vi, re] of bad) assert.throws(() => GP.validateVariantBlock(vi, dishes, 'supplied'), re, JSON.stringify(vi));
});

test('validateVariantBlock: a group is ONE id namespace — numeric groups draw, coerced matches are refused', () => {
  const numeric = [{ id: 30 }, { id: 31 }, { id: 32 }];
  assert.doesNotThrow(() => GP.validateVariantBlock({ 30: { basePrice: 624, variantIds: [31, 32] } }, numeric, 's'), 'x_pizza: numeric dish ids, the key is the JSON string of the launcher id');
  const mixedMenu = [{ id: 'L' }, { id: 'a' }, { id: 7 }];
  for (const [vi, re, why] of [
    [{ 30: { basePrice: 624, variantIds: ['31', '32'] } }, /apply_variant_id_orphan@s:30:31/, 'string ids naming numeric dishes (coercion only)'],
    [{ 30: { basePrice: 624, variantIds: [31, '32'] } }, /apply_variant_id_type@s:30:32/, 'one group, two id types'],
    [{ 30: { basePrice: 624, variantIds: [31, NaN] } }, /apply_variant_id_type/, 'a non-finite number is not an id'],
  ]) assert.throws(() => GP.validateVariantBlock(vi, numeric, 's'), re, why);
  assert.throws(() => GP.validateVariantBlock({ 7: { basePrice: 5, variantIds: ['a'] } }, mixedMenu, 's'), /apply_variant_launcher_orphan@s:7/,
    'a string group whose KEY matches only a NUMERIC dish (after coercion) is refused');
  assert.throws(() => GP.validateVariantBlock({ L: { basePrice: 5, variantIds: [7] } }, mixedMenu, 's'), /apply_variant_launcher_orphan@s:L/,
    'a numeric group whose key names only a STRING dish is refused');
});

test('choiceRows: one row per RESOLVED choice in group order — label, amount, chosen, recommended — decided once', () => {
  const menu = [{ id: 'a', choice: 'Pollo', price: 342, tags: ['recommended'] }, { id: 'b', choice: 'Sin', price: 307 }, { id: 7, choice: 'Num', price: 400 }];
  assert.deepStrictEqual(GP.choiceRows({ variantIds: ['b', 'a', 'gone'] }, menu, 'a'), [
    { id: 'b', choice: 'Sin', delta: null, selected: false, recommended: false },
    { id: 'a', choice: 'Pollo', delta: 35, selected: true, recommended: true },
  ], 'the cheapest shows no amount, a dearer one its delta; an unresolvable id renders nothing');
  assert.deepStrictEqual(GP.choiceRows({ variantIds: ['a', 'b'], basePrice: 9999 }, menu, null).map((r) => r.delta), [35, null],
    'a stale authored basePrice is never an input: deltas come from the choices themselves');
  assert.ok(GP.choiceRows({ variantIds: ['x', 'y'] }, [{ id: 'x', price: 624 }, { id: 'y', price: 624 }], null).every((r) => r.delta === null), 'all equal → no amounts');
  assert.deepStrictEqual(GP.choiceRows({ variantIds: [7] }, menu, '7').map((r) => r.selected), [false], 'chosen is strict too: "7" is not 7');
  assert.deepStrictEqual([GP.isRecommended({ tags: ['recommended'] }), GP.isRecommended({ tags: 'recommended' }), GP.isRecommended({})], [true, false, false]);
  assert.strictEqual(GP.RECOMMENDED_LABEL, 'Recomendada');
});

test('extras_policy: "none" hides extras; absent = today; any other value refuses the snapshot whole', () => {
  assert.deepStrictEqual([GP.noExtras({ extras_policy: 'none' }), GP.noExtras({}), GP.noExtras({ extras_policy: 'None' }), GP.noExtras(null)], [true, false, false, false]);
  assert.doesNotThrow(() => GP.validateExtrasPolicy([{ id: 1 }, { id: 2, extras_policy: 'none' }]));
  for (const bad of ['None', '', null, undefined, 'all', 0]) {
    assert.throws(() => GP.validateExtrasPolicy([{ id: 1 }, { id: 2, extras_policy: bad }]), /apply_dish_extras_policy@1/, JSON.stringify(bad));
  }
});

test('whole-dish availability: a choice is available iff it AND its launcher are', () => {
  const menu = [{ id: 30, name: 'L' }, { id: 31, name: 'L - a', variantOf: 30 }, { id: 32, name: 'L - b', variantOf: 30 }, { id: 'x', name: 'X', variantOf: '30' }];
  const out = new Set();
  const own = (it) => out.has(it.name);
  assert.strictEqual(GP.soldOutWithParent(menu[1], menu, own), false);
  out.add('L - a'); assert.deepStrictEqual([GP.soldOutWithParent(menu[1], menu, own), GP.soldOutWithParent(menu[2], menu, own)], [true, false], 'child-only 86');
  out.clear(); out.add('L'); assert.deepStrictEqual([GP.soldOutWithParent(menu[1], menu, own), GP.soldOutWithParent(menu[2], menu, own)], [true, true], 'parent 86 hides every choice');
  assert.strictEqual(GP.soldOutWithParent(menu[3], menu, own), false, 'the parent is resolved strictly ("30" is not 30)');
  assert.strictEqual(GP.parentOf(menu[0], menu), null, 'a launcher has no parent');
});

test('the price rule is DERIVED from the choices: "L {min}" when equal, else "desde L {min}"', () => {
  const menu = [{ id: 'a', price: 342 }, { id: 'b', price: 307 }, { id: 'c', price: 414 }, { id: 'z', price: 0 }, { id: 'n', price: '9' }];
  assert.deepStrictEqual(GP.priceRange({ variantIds: ['a', 'b', 'c'] }, menu), { min: 307, max: 414 });
  assert.strictEqual(GP.priceText({ variantIds: ['a', 'b', 'c'], basePrice: 1 }, menu), 'desde L 307', 'unequal → "desde", from the cheapest CHOICE (never the stored basePrice)');
  assert.strictEqual(GP.priceText({ variantIds: ['a', 'a'] }, menu), 'L 342', 'equal → the price alone');
  assert.strictEqual(GP.priceText({ variantIds: ['a', 'z', 'n', 'gone'] }, menu), 'L 342', 'unpriceable / unresolvable choices are not inputs');
  assert.strictEqual(GP.priceText({ variantIds: ['z', 'gone'] }, menu), null, 'nothing priceable → null (the form renders its own placeholder)');
  assert.deepStrictEqual([GP.choiceDelta({ price: 342 }, { min: 307 }), GP.choiceDelta({ price: 307 }, { min: 307 }), GP.choiceDelta({ price: 5 }, null)], [35, null, null]);
});

test('promptText: "Elegí tu {label en minúscula}", the same for every restaurant', () => {
  assert.strictEqual(GP.promptText({ label: 'Proteína' }), 'Elegí tu proteína');
  assert.strictEqual(GP.promptText({ label: 'SALSA' }), 'Elegí tu salsa');
});

test('ctaDecision: choose → soldout → add (the chosen price + the staged extras)', () => {
  const menu = [{ id: 'a', price: 342 }, { id: 'b', price: 307 }];
  const extras = [{ id: 'e1', price: 30 }, { id: 'e2', price: 15 }];
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: null, menu, extras }), { kind: 'choose' });
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: 'a', menu, extras, isSoldOut: (v) => v.id === 'a' }), { kind: 'soldout' });
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: 'a', menu, extras, stagedExtras: { e1: 2, e2: 1, gone: 3 } }), { kind: 'add', total: 342 + 60 + 15 });
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: 'b', menu, extras, isSoldOut: null }), { kind: 'add', total: 307 }, 'no sold-out reader → never sold out (fail-open, as today)');
});
