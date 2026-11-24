'use strict';
// S4 (PLAN-structure-S4-r4 R3.5 slug, R3.3/R4.2 promotion order; advisor 11-13: ONE source for server and portal, rule 4) —
// catalog/section-transitions.js: categorySlug / allocateCategoryIds (the id a new category gets) and promotedOrder (where staged
// categories land when their first dish arrives). The server re-derives and re-verifies with THESE functions; the portal's S4 writer
// previews with a byte copy (catalog/section-transitions-sync.guard.test.js). Run: node catalog/section-transitions.test.js
const assert = require('assert');
const ST = require('./section-transitions');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

cell('ST-SLUG-FOLD: accents folded, runs → _, trimmed, lowercase', (L) => {
  assert.strictEqual(ST.categorySlug('Bebidas frías', []), 'bebidas_frias', L);
  assert.strictEqual(ST.categorySlug('  Postres & Café!! ', []), 'postres_cafe', L);
  assert.strictEqual(ST.categorySlug('ÑOQUIS', []), 'noquis', L);
});
cell('ST-SLUG-EMPTY: nothing ASCII left → cat', (L) => {
  for (const s of ['¡¡!!', '寿司', '🍕🍕', '___', '']) assert.strictEqual(ST.categorySlug(s, []), 'cat', `${L}: ${JSON.stringify(s)}`);
});
cell('ST-SLUG-DIGIT: a digit-leading base gets c_ BEFORE the cut — never over 32', (L) => {
  assert.strictEqual(ST.categorySlug('2x1 Promos', []), 'c_2x1_promos', L);
  const long = '1' + 'a'.repeat(39);
  const id = ST.categorySlug(long, []);
  assert.strictEqual(id.length, 32, `${L}: ${id}`); assert.ok(id.startsWith('c_1'), L); assert.ok(ID_RE.test(id), L);
});
cell('ST-SLUG-CUT: a long name is cut to 32 with no trailing _', (L) => {
  const id = ST.categorySlug('Platos fuertes de la casa para compartir en familia', []);
  assert.ok(id.length <= 32 && !id.endsWith('_') && ID_RE.test(id), `${L}: ${id}`);
  assert.strictEqual(id, 'platos_fuertes_de_la_casa_para_c', L);
});
cell('ST-SLUG-COLLIDE: _2, _3 … with the base cut so the whole id stays ≤ 32', (L) => {
  assert.strictEqual(ST.categorySlug('Postres', ['postres']), 'postres_2', L);
  assert.strictEqual(ST.categorySlug('Postres', ['postres', 'postres_2']), 'postres_3', L);
  const base = ST.categorySlug('1' + 'b'.repeat(40), []);
  const id = ST.categorySlug('1' + 'b'.repeat(40), [base]);
  assert.ok(id.length <= 32 && id.endsWith('_2') && ID_RE.test(id), `${L}: ${id}`);
  const big = []; for (let i = 0; i < 12; i++) big.push(i ? `postres_${i + 1}` : 'postres');
  assert.strictEqual(ST.categorySlug('Postres', big), 'postres_13', L);
});
cell('ST-ALLOC: several new categories in one save, in order, each against the ids already allocated', (L) => {
  assert.deepStrictEqual(ST.allocateCategoryIds(['Postres', 'postres', 'Póstres'], ['dim_sum']), ['postres', 'postres_2', 'postres_3'], L);
  assert.deepStrictEqual(ST.allocateCategoryIds([], ['x']), [], L);
});
cell('ST-ORDER-ONE: a promoted category lands right after its anchor', (L) => {
  assert.deepStrictEqual(ST.promotedOrder(['a', 'x', 'b'], [{ id: 'p', after: 'x' }]), ['a', 'x', 'p', 'b'], L);
});
cell('ST-ORDER-SAME-SAVE: two from one anchor in one save keep staged-array order (+ r)', (L) => {
  assert.deepStrictEqual(ST.promotedOrder(['x', 'y'], [{ id: 'A', after: 'x' }, { id: 'B', after: 'x' }]), ['x', 'A', 'B', 'y'], L);
});
cell('ST-ORDER-TWO-SAVES: A then B in separate saves on one anchor ⇒ B before A (R4.2)', (L) => {
  const s1 = ST.promotedOrder(['x', 'y'], [{ id: 'A', after: 'x' }]);
  assert.deepStrictEqual(s1, ['x', 'A', 'y'], L);
  assert.deepStrictEqual(ST.promotedOrder(s1, [{ id: 'B', after: 'x' }]), ['x', 'B', 'A', 'y'], L);
});
cell('ST-ORDER-NULL: a null anchor means first (0 + r)', (L) => {
  assert.deepStrictEqual(ST.promotedOrder(['x'], [{ id: 'A', after: null }, { id: 'B', after: null }]), ['A', 'B', 'x'], L);
});
cell('ST-ORDER-MISSING: an anchor not in the list → appended at the end, in staged order (defensive)', (L) => {
  assert.deepStrictEqual(ST.promotedOrder(['x', 'y'], [{ id: 'A', after: 'gone' }, { id: 'B', after: 'x' }, { id: 'C', after: 'gone2' }]), ['x', 'B', 'y', 'A', 'C'], L);
});
cell('ST-ORDER-MIXED: several anchors in one save', (L) => {
  assert.deepStrictEqual(ST.promotedOrder(['x', 'y'], [{ id: 'A', after: 'y' }, { id: 'B', after: null }, { id: 'C', after: 'x' }, { id: 'D', after: 'y' }]), ['B', 'x', 'C', 'y', 'A', 'D'], L);
});
cell('ST-PURE: inputs never mutated', (L) => {
  const c = ['x']; const p = [{ id: 'A', after: 'x' }]; const t = ['postres'];
  ST.promotedOrder(c, p); ST.categorySlug('Postres', t); ST.allocateCategoryIds(['a'], t);
  assert.deepStrictEqual([c, p, t], [['x'], [{ id: 'A', after: 'x' }], ['postres']], L);
});

cell('ST-FOLD (advisor 11-13 ruling 2a): nameFold ≡ add-product normalizeName over a corpus (the ONE folding, shared with the portal)', (L) => {
  const AP = require('./add-product');
  const corpus = ['Dim Sum', 'dím  sum', '  DIM SUM ', 'Café', 'cafe', 'CAFÉ', 'Ñoquis', 'noquis', 'Soups & Salads', 'soups &\tsalads', 'x\ny', '寿司', '🍕 Pizza', 'Crème brûlée', 'creme brulee', 'Ã', 'İstanbul', 'ß', '', '  ', 'ﬁ', 'Ａｂｃ'];
  for (const x of corpus) assert.strictEqual(ST.nameFold(x), AP.normalizeName(x), `${L}: ${JSON.stringify(x)}`);
  assert.strictEqual(ST.nameFold('Dím  Sum'), ST.nameFold('dim sum'), `${L}: accents + spacing fold together`);
});
if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
