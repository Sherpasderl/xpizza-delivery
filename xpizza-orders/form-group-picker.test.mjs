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
    [{ L: { basePrice: 5, variantIds: [] } }, /apply_variant_ids_missing/], [{ L: { basePrice: 5, variantIds: [7] } }, /apply_variant_id_type/],
    [{ L: { basePrice: 5, variantIds: ['zz'] } }, /apply_variant_id_orphan@supplied:L:zz/], [{ Q: { basePrice: 5, variantIds: ['a'] } }, /apply_variant_launcher_orphan@supplied:Q/],
  ];
  for (const [vi, re] of bad) assert.throws(() => GP.validateVariantBlock(vi, dishes, 'supplied'), re, JSON.stringify(vi));
});

test('choiceRowsHtml: the label row + one row per choice, the selected one marked, text through the form’s escapers', () => {
  const menu = [{ id: 'a', choice: 'Pollo <b>', price: 342 }, { id: 'b', choice: 'Sin', price: 307 }];
  const html = GP.choiceRowsHtml({ cfg: { label: 'Proteína', basePrice: 307, variantIds: ['b', 'a', 'gone'] }, menu, stagedId: 'a', escapeHtml: esc, safeText: esc });
  assert.ok(html.startsWith('<div class="detail-cat-label">Proteína <span class="detail-req">· Requerido</span></div><div class="detail-extras-list">'));
  assert.strictEqual((html.match(/detail-variant-row/g) || []).length, 2, 'one row per RESOLVED choice (an unresolvable id renders nothing)');
  assert.ok(/data-id="a"[\s\S]*Pollo &lt;b&gt;/.test(html), 'the choice label is escaped');
  assert.ok(/detail-variant-row sel" data-act="variant" data-id="a"/.test(html) && !/sel" data-act="variant" data-id="b"/.test(html), 'only the staged choice is marked');
  assert.ok(/\+L 35/.test(html) && /L 307/.test(html), 'today’s labels: +L delta above "desde", the price otherwise (step 1 = la_musa’s exact rule)');
});

test('ctaDecision: choose → soldout → add (the chosen price + the staged extras)', () => {
  const menu = [{ id: 'a', price: 342 }, { id: 'b', price: 307 }];
  const extras = [{ id: 'e1', price: 30 }, { id: 'e2', price: 15 }];
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: null, menu, extras }), { kind: 'choose' });
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: 'a', menu, extras, isSoldOut: (v) => v.id === 'a' }), { kind: 'soldout' });
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: 'a', menu, extras, stagedExtras: { e1: 2, e2: 1, gone: 3 } }), { kind: 'add', total: 342 + 60 + 15 });
  assert.deepStrictEqual(GP.ctaDecision({ stagedId: 'b', menu, extras, isSoldOut: null }), { kind: 'add', total: 307 }, 'no sold-out reader → never sold out (fail-open, as today)');
});
