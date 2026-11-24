'use strict';
// S4 (PLAN-structure-S4-r4 §1.6, S0-3, Q4/Q9) — categoriesGeneric: does a shipped form draw ANY served category (a generic CATEGORIES walk
// in renderMenu, CATEGORIES booted from the served bundle AND live-applied, no `p.cat === '<literal>'` filter) — derived by
// tools/generate-renderer-contract.js from the forms, never hand-written. It drives ONLY the review's «Solo en la app Sherpa» labels
// (app_only), never authorization (R3.1). Run: node catalog/s4-renderer.test.js
const assert = require('assert');
const STRUCT = { sections: true, choiceEdit: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: STRUCT.choiceEdit, sections: STRUCT.sections }) } }; }
const G = require('../tools/generate-renderer-contract');
const committed = require('./renderer-contract.generated');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { reviewDiff } = require('./review-diff');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));

cell('RC-GENERIC (S0-3): la_musa\'s form is generic, x_pizza\'s is not — from the shipped forms', (L) => {
  assert.strictEqual(committed.la_musa.categoriesGeneric, true, L);
  assert.strictEqual(committed.x_pizza.categoriesGeneric, false, L);
});
cell('RC-DETECT: all three conditions are required, and any literal filter makes a form non-generic', (L) => {
  const walk = "function renderMenu() { CATEGORIES.forEach(c => { const items = MENU.filter(p => p.cat === c.id); }); }";
  const boot = "let CATEGORIES = _bootSelect('categories', ok, [], true);";
  const live = "const LIVE_MENU_GLOBALS = ['MENU', 'CATEGORIES'];";
  assert.strictEqual(G.categoriesGenericOf(`${boot}\n${live}\n${walk}`), true, `${L}: all three`);
  assert.strictEqual(G.categoriesGenericOf(`${live}\n${walk}`), false, `${L}: no boot`);
  assert.strictEqual(G.categoriesGenericOf(`${boot}\n${walk}`), false, `${L}: not live-applied`);
  assert.strictEqual(G.categoriesGenericOf(`${boot}\n${live}\nfunction renderMenu() { MENU.filter(p => p.cat === 'ny'); }`), false, `${L}: no walk`);
  assert.strictEqual(G.categoriesGenericOf(`${boot}\n${live}\nfunction renderMenu() { MENU.forEach((p) => draw(p)); }`), false, `${L}: no walk and no literal (a flat list draws no section)`);
  assert.strictEqual(G.categoriesGenericOf(`${boot}\n${live}\n${walk.replace('}); }', "}); MENU.filter(p => p.cat === 'ny'); }")}`), false, `${L}: a literal filter beside the walk`);
});
const built = (rid, src) => buildSourceCandidate(rid, src).built;
const diffOf = (rid, live, draft) => { const a = built(rid, live); const b = built(rid, draft); return reviewDiff({ rid, live: a, liveExtraRecords: a.extras, draftBuilt: b, draftExtraRecords: b.extras }); };
cell('RC-APP-ONLY (Q4/Q9): a new category and a section reorder are app_only on x_pizza, shown on la_musa\'s form', (L) => {
  const XP = buildSourceFromCode('x_pizza'); XP.structure.categories.forEach((c) => { c.name = c.id.toUpperCase(); });
  const xd = clone(XP); xd.structure.categories.push({ id: 'postres', name: 'Postres' }); xd.items.find((i) => i.display.cat === 'individual').display.cat = 'postres';
  const xs = diffOf('x_pizza', XP, xd).sections;
  assert.deepStrictEqual([xs.added[0].app_only, xs.categories.app_only], [true, true], `${L}: x_pizza`);
  const LM = buildSourceFromCode('la_musa');
  const ld = clone(LM); ld.structure.categories.push({ id: 'postres', name: 'Postres' }); ld.items[0].display.cat = 'postres';
  const ls = diffOf('la_musa', LM, ld).sections;
  assert.deepStrictEqual([ls.added[0].app_only, ls.categories.app_only], [false, false], `${L}: la_musa`);
});
cell('RC-NO-RID: without rid the label is unknown (null) — never guessed', (L) => {
  const LM = buildSourceFromCode('la_musa'); const ld = clone(LM); const c = ld.structure.categories; [c[0], c[1]] = [c[1], c[0]];
  const a = built('la_musa', LM); const b = built('la_musa', ld);
  const s = reviewDiff({ live: a, liveExtraRecords: a.extras, draftBuilt: b, draftExtraRecords: b.extras }).sections;
  assert.strictEqual(s.categories.app_only, null, L);
});


// choicesGeneric (advisor 11-13, Q-B): does a shipped form draw ANY served required-choice group — the shared group picker shipped
// (formShipsPicker, the strict GROUP_PICKER_V1 marker), VARIANT_ITEMS booted from the served bundle, AND live-applied (LIVE_MENU_GLOBALS).
// false ⇒ a new option / a dish gaining or losing its group is «Solo en la app Sherpa». A review label only (choice rows' app_only).
const CT = require('./choice-transitions');
const withOption = (src, lkey, key, choice, price) => {
  const s = clone(src); const l = s.items.find((i) => i.key === lkey);
  s.items.push({ key, price, display: { id: key, variantOf: l.display.id, choice, name: `${l.display.name} - ${choice}`, price, cat: l.display.cat, ...(l.display.subcat != null ? { subcat: l.display.subcat } : {}) } });
  s.structure.variant_items[String(l.display.id)].variantIds.push(key);
  const o = s.structure.item_order; o.splice(o.indexOf(s.structure.variant_items[String(l.display.id)].variantIds.slice(-2)[0]) + 1, 0, key);
  return s;
};
const ON3 = (fn) => { STRUCT.choiceEdit = true; try { return fn(); } finally { STRUCT.choiceEdit = false; } };
const choiceRowsOf = (rid, live, draft, withRid = true) => { const a = built(rid, live); const b = built(rid, draft); return ON3(() => reviewDiff({ ...(withRid ? { rid } : {}), live: a, liveExtraRecords: a.extras, draftBuilt: b, draftExtraRecords: b.extras })).choices; };
const LMc = buildSourceFromCode('la_musa'); const PAD = 'noodle_01';
const facetDrafts = () => ({
  added: withOption(LMc, PAD, 'noodle_01_tofu', 'Tofu', 300),   // a NEW option under an existing dish
  plain: CT.apply(LMc, { op: 'choice.remove', launcher: PAD, price_from: LMc.structure.variant_items[PAD].variantIds[0] }).source,   // a dish LOSING its group
  label: CT.apply(LMc, { op: 'choice.label', launcher: PAD, label: 'Elegí la proteína' }).source,   // a label only: no facet
});

cell('RC-CHOICES-GENERIC (Q-B): both shipped forms draw any served group (picker + boot + live) — from the shipped forms', (L) => {
  assert.deepStrictEqual([committed.x_pizza.choicesGeneric, committed.la_musa.choicesGeneric], [true, true], L);
  assert.deepStrictEqual(G.deriveContracts(), committed, `${L}: the committed contract is the generator's output`);
});
cell('RC-CHOICES-DETECT: the picker, the bundle boot and the live re-apply are ALL required', (L) => {
  const boot = "let VARIANT_ITEMS = _bootSelect('variant_items', _okObj, {}, false);";
  const iife = "let VARIANT_ITEMS = (function(){\n  if (!_MENU_OK) return {};\n  if (_BUNDLE.variant_items === undefined) return {};\n  return _BUNDLE.variant_items;\n})();";
  const live = "const LIVE_MENU_GLOBALS = ['MENU', 'VARIANT_ITEMS'];";
  assert.strictEqual(G.choicesGenericOf(`${boot}\n${live}`, true), true, `${L}: _bootSelect boot`);
  assert.strictEqual(G.choicesGenericOf(`${iife}\n${live}`, true), true, `${L}: the bundle IIFE boot`);
  assert.strictEqual(G.choicesGenericOf(`${boot}\n${live}`, false), false, `${L}: no picker`);
  assert.strictEqual(G.choicesGenericOf(`let VARIANT_ITEMS = {};\n${live}`, true), false, `${L}: a literal map, not booted from the bundle`);
  assert.strictEqual(G.choicesGenericOf(`${boot}\nconst LIVE_MENU_GLOBALS = ['MENU'];`, true), false, `${L}: not live-applied`);
});
cell('RC-CHOICES-APP-ONLY (Q-B): a new option and a dish losing its group carry app_only = !choicesGeneric (false on both brands today); a label-only row carries none', (L) => {
  const f = facetDrafts();
  for (const g of [true, false]) {
    const was = committed.la_musa.choicesGeneric; committed.la_musa.choicesGeneric = g;
    try {
      assert.deepStrictEqual(choiceRowsOf('la_musa', LMc, f.added).map((r) => r.app_only), [!g], `${L}: new option, generic=${g}`);
      assert.deepStrictEqual(choiceRowsOf('la_musa', LMc, f.plain).map((r) => r.app_only), [!g], `${L}: losing its group, generic=${g}`);
      assert.deepStrictEqual(choiceRowsOf('la_musa', LMc, f.label).map((r) => Object.prototype.hasOwnProperty.call(r, 'app_only')), [false], `${L}: a label-only row`);
    } finally { committed.la_musa.choicesGeneric = was; }
  }
  assert.deepStrictEqual(choiceRowsOf('la_musa', LMc, f.added).map((r) => r.app_only), [false], `${L}: today, la_musa`);
});
cell('RC-CHOICES-PER-BRAND: the label each brand\'s rows carry, by rid (x_pizza\'s code catalog ships no group, so its rows are read through the same function)', (L) => {
  const RD = require('./review-diff');
  assert.deepStrictEqual(['x_pizza', 'la_musa', 'no_such_brand', undefined].map((r) => RD.choiceAppOnlyOf(r)), [false, false, null, null], L);
  const was = committed.x_pizza.choicesGeneric; committed.x_pizza.choicesGeneric = false;
  try { assert.strictEqual(RD.choiceAppOnlyOf('x_pizza'), true, `${L}: a non-generic form ⇒ app-only`); } finally { committed.x_pizza.choicesGeneric = was; }
});
cell('RC-CHOICES-NO-RID: without rid a facet row\'s app_only is unknown (null) — never guessed', (L) => {
  assert.deepStrictEqual(choiceRowsOf('la_musa', LMc, facetDrafts().added, false).map((r) => r.app_only), [null], L);
});

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
