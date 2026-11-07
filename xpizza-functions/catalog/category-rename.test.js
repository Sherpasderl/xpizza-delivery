'use strict';
// PLAN-public-menu-display r2 T1 — a category NAME is the one category field the edit path may change.
//
// The exception lives in the SHARED structural comparison (compareToActive), so the save and the publish judge a rename
// identically. Same count, same id at every index, every other field equal; only `name` may differ, and a draft that
// renames must change nothing else (rename_not_alone), so the reviewed diff shows the rename alone. The validator keeps
// La Musa's per-category REQUIRED name and adds all-or-nothing only where names are optional (x_pizza today).
//
// Run: node catalog/category-rename.test.js
const assert = require('assert');
const A = require('./add-product');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs, canonicalize, validateSource, rendererContract } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { catalogDiff, issueEditToken } = require('./catalog-edit');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const build = (rid, src) => {
  const i = sourceToBuildInputs(src);
  const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable });
  return { items: b.items, extras: b.extras, structure: b.structure };
};
const SRC = { x_pizza: canonicalize(buildSourceFromCode('x_pizza')), la_musa: canonicalize(buildSourceFromCode('la_musa')) };
const throwsCode = (fn, code, msg) => assert.throws(fn, (e) => e instanceof A.AddProductError && e.code === code, msg || code);
const cmpBuilt = (rid, draftBuilt, activeBuilt = build(rid, SRC[rid])) => A.compareToActive({
  draftBuilt, activeBuilt, draftAuthored: new Set(Object.keys(SRC[rid].structure)), renderedCategories: rendererContract(rid).renderedCategories,
});
const cmp = (rid, draftSrc, activeSrc = SRC[rid]) => cmpBuilt(rid, build(rid, draftSrc), build(rid, activeSrc));
const named = (src, names) => { const s = clone(src); s.structure.categories.forEach((c, i) => { if (names[i] !== undefined) c.name = names[i]; }); return s; };

// ── the comparison: a name-only change passes, on both brands ────────────────────────────────────────────
{
  const xp = named(SRC.x_pizza, ['Pizzas 12', 'NY 18']);
  assert.deepStrictEqual(cmp('x_pizza', xp), { additions: [], removals: [] }, 'x_pizza: naming both categories passes');
  const lm = named(SRC.la_musa, ['Dim Sum Nuevo']);
  assert.deepStrictEqual(cmp('la_musa', lm), { additions: [], removals: [] }, 'la_musa: renaming one category passes');
  // the active side named, the draft renaming again — a change of an EXISTING name, not only an addition of one
  assert.deepStrictEqual(cmp('x_pizza', named(xp, ['Pizzas Doce']), xp), { additions: [], removals: [] }, 'x_pizza: renaming an existing name passes');
  ok('compareToActive: a category NAME change passes — added (x_pizza), changed (la_musa), changed again');
}

// ── everything else about a category is still frozen ─────────────────────────────────────────────────────
{
  const rid = 'la_musa';
  const id = clone(SRC[rid]); id.structure.categories[0].id = 'dim_sum_2';
  // an id change cannot even build (the dishes still point at the old id), so the comparator's own rule is exercised on the built shape
  const b0 = build(rid, SRC[rid]);
  const withCats = (cats) => ({ ...b0, structure: { ...b0.structure, categories: cats } });
  const cats = () => clone(b0.structure.categories);
  { const c = cats(); c[0].id = 'dim_sum_2'; throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'an id changed'); }
  { const c = cats(); [c[0], c[1]] = [c[1], c[0]]; throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'two categories swapped'); }
  { const c = cats(); c.push({ id: 'nueva', name: 'Nueva' }); throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'a category added'); }
  { const c = cats(); c.pop(); throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'a category removed'); }
  { const c = cats(); const b = c.find((x) => Array.isArray(x.subcats)); b.subcats = [...b.subcats].reverse(); throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'subcats changed'); }
  { const c = cats(); const b = c.find((x) => x.layout); b.layout = 'grid'; throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'layout changed'); }
  { const c = cats(); c[0].layout = 'grid'; throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'a field present on the draft side only'); }
  { const c = cats(); const b = c.find((x) => x.layout); delete b.layout; throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'a field present on the active side only'); }
  { const c = cats(); c[0].name = 'Otro'; c[1].layout = 'list'; throwsCode(() => cmpBuilt(rid, withCats(c)), 'structure_changed', 'a rename does not license another field'); }
  // the refusal names the field, as every structure refusal does
  { const c = cats(); c[0].id = 'x'; assert.throws(() => cmpBuilt(rid, withCats(c)), (e) => e.field === 'categories', 'field: categories'); }
  void id;
  ok('compareToActive: id, order, count, subcats, layout and one-sided fields are still refused (structure_changed, field categories)');
}

// ── rename_not_alone: a renaming draft changes nothing else ──────────────────────────────────────────────
{
  for (const rid of ['x_pizza', 'la_musa']) {
    const base = named(SRC[rid], rid === 'x_pizza' ? ['A', 'B'] : ['Otro']);
    const priced = clone(base); priced.items[0].price += 10; priced.items[0].display.price = priced.items[0].price;
    throwsCode(() => cmp(rid, priced), 'rename_not_alone', `${rid}: a rename with an item price change`);
    const exp = clone(base); exp.extras[0].price += 5; if (exp.extras[0].display && 'price' in exp.extras[0].display) exp.extras[0].display.price = exp.extras[0].price;
    throwsCode(() => cmp(rid, exp), 'rename_not_alone', `${rid}: a rename with an extra price change`);
    assert.throws(() => cmp(rid, priced), (e) => e.field === 'categories', 'rename_not_alone names the categories field');
    // the ordinary price edit, with no rename, is exactly as before
    const priceOnly = clone(SRC[rid]); priceOnly.items[0].price += 10; priceOnly.items[0].display.price = priceOnly.items[0].price;
    assert.deepStrictEqual(cmp(rid, priceOnly), { additions: [], removals: [] }, `${rid}: a price-only edit still passes`);
  }
  // a rename beside an ADDITION is refused too (an addition is a change)
  const rid = 'x_pizza';
  const b0 = build(rid, named(SRC[rid], ['A', 'B']));
  const add = { key: 'Probe Pizza', price: 500, display: { ...b0.items[0].display, name: 'Probe Pizza', id: 999 } };
  delete add.display.identity_id;
  const withAdd = { ...b0, items: [...b0.items, add], structure: { ...b0.structure, item_order: [...b0.structure.item_order, add.key] } };
  throwsCode(() => cmpBuilt(rid, withAdd), 'rename_not_alone', 'a rename with a new product');
  ok('rename_not_alone: a rename beside an item price, an extra price or a new product is refused; a price-only edit passes as today');
}

// ── rename_not_alone covers STRUCTURE too (codex build r1 P2): with extras authoring ON, a deny_extras change is an
//    allowed structure edit on its own — beside a rename it is refused, so the reviewed diff never hides it ──────
{
  const cmpX = (rid, draftSrc) => A.compareToActive({ draftBuilt: build(rid, draftSrc), activeBuilt: build(rid, SRC[rid]),
    draftAuthored: new Set(Object.keys(SRC[rid].structure)), renderedCategories: rendererContract(rid).renderedCategories, extrasAuthoring: true });
  const denied = (src) => { const s = clone(src); s.structure.exposure.item_overrides[s.items[0].key] = { deny_extras: [s.extras[0].key] }; return s; };
  for (const rid of ['x_pizza', 'la_musa']) {
    assert.deepStrictEqual(cmpX(rid, denied(SRC[rid])), { additions: [], removals: [] }, `${rid}: premise — a deny_extras change alone passes with authoring ON`);
    const both = denied(named(SRC[rid], rid === 'x_pizza' ? ['A', 'B'] : ['Otro']));
    throwsCode(() => cmpX(rid, both), 'rename_not_alone', `${rid}: a rename with a deny_extras change`);
  }
  ok('rename_not_alone: with extras authoring ON, a rename beside a deny_extras change is refused on both brands; the deny_extras change alone passes');
}

// ── the validator: La Musa keeps REQUIRED names; all-or-nothing only where names are optional ───────────
{
  assert.strictEqual(rendererContract('la_musa').categoriesNamed, true, 'premise: la_musa names are required');
  assert.strictEqual(rendererContract('x_pizza').categoriesNamed, false, 'premise: x_pizza names are optional');
  const v = (src, rid) => validateSource(src, rid);
  const bad = (src, rid, msg) => assert.throws(() => v(src, rid), /source_malformed/, msg);
  v(SRC.x_pizza, 'x_pizza');                                             // none named — today's state
  v(named(SRC.x_pizza, ['Pizzas 12', 'NY 18']), 'x_pizza');              // all named
  bad(named(SRC.x_pizza, ['Pizzas 12']), 'x_pizza', 'x_pizza: one of two named is refused (partial)');
  const lmOne = clone(SRC.la_musa); delete lmOne.structure.categories[0].name;
  bad(lmOne, 'la_musa', 'la_musa: removing ONE name is refused');
  const lmAll = clone(SRC.la_musa); for (const c of lmAll.structure.categories) delete c.name;
  bad(lmAll, 'la_musa', 'la_musa: removing ALL names is refused (required, not all-or-nothing)');
  v(named(SRC.la_musa, ['Dim Sum Nuevo']), 'la_musa');
  ok('validateSource: x_pizza none/all named valid, partial refused; la_musa one or ALL names removed refused, a rename valid');
}

// ── the diff shows each rename, and the token binds it ───────────────────────────────────────────────────
{
  process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'tb_test_secret_0123456789abcdef0123456789';
  const live = build('x_pizza', SRC.x_pizza);
  const draft = build('x_pizza', named(SRC.x_pizza, ['Pizzas 12', 'NY 18']));
  const d = catalogDiff(live, draft);
  assert.deepStrictEqual(d.changed.filter((c) => c.surface === 'category'), [
    { key: 'individual', surface: 'category', field: 'name', old: null, new: 'Pizzas 12' },
    { key: 'ny', surface: 'category', field: 'name', old: null, new: 'NY 18' },
  ], 'both renames are reviewed lines (absent shown as null)');
  assert.deepStrictEqual(catalogDiff(live, live).changed.filter((c) => c.surface === 'category'), [], 'no rename → no category lines');
  const lmLive = build('la_musa', SRC.la_musa);
  const lmD = catalogDiff(lmLive, build('la_musa', named(SRC.la_musa, ['Dim Sum Nuevo'])));
  assert.deepStrictEqual(lmD.changed.filter((c) => c.surface === 'category'), [{ key: 'dim_sum', surface: 'category', field: 'name', old: 'Dim Sum', new: 'Dim Sum Nuevo' }], 'la_musa: old → new');
  const st = { rid: 'x_pizza', baseActiveVersionId: 'v1', sourceUpdateTime: 't1', sourceHash: 'h1' };
  const other = catalogDiff(live, build('x_pizza', named(SRC.x_pizza, ['Pizzas 12', 'NY Grande'])));
  assert.notStrictEqual(issueEditToken({ ...st, diff: d }), issueEditToken({ ...st, diff: other }), 'a different rename is a different token');
  ok('catalogDiff: each rename is a reviewed `category` line (old → new, absent as null); the token binds the exact rename');
}

console.log(`\ncategory-rename: OK (${n})`);
