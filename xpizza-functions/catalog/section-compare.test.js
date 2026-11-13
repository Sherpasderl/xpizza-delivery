'use strict';
// S4 (PLAN-structure-S4-r4 §1.1–1.7, R2.2/R3.1, R3.2, R3.7, R4.1) — section-compare.compareToActive: the S4 judgment, innermost under
// choice-compare (S0-2). OFF: add-product.compareToActive itself (same call, same answer). ON: the S4 delta — new categories, subcats,
// section / subsection / dish order, moves into new categories — is judged HERE; today's compare judges everything else on the draft
// with that delta reverted; renderability is authorized for every declared category (R3.1); a new category may not enter an AUTHORED
// map (R3.2); a move's projection change in the extras maps is claimed exactly (R4.1).
// Real seeds (buildSourceFromCode) → real build (buildSourceCandidate). The portal-writer-produced drafts are KNOWN_RED until portal-ui's
// «S4 portal writer» lands (R2.9) — these cells edit the SOURCE the way that writer must, and are labelled server-built.
// Run: node catalog/section-compare.test.js
const assert = require('assert');
const STRUCT = { sections: false, choiceEdit: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: STRUCT.choiceEdit, sections: STRUCT.sections }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { rendererContract } = require('./source-store');
const { projectExtrasMaps } = require('./extras-projection');
const AP = require('./add-product');
const SC = require('./section-compare');
const CC = require('./choice-compare');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const built = (rid, src) => { const b = buildSourceCandidate(rid, src).built; return { items: b.items, extras: b.extras, structure: b.structure }; };
const args = (rid, active, draft, over = {}) => ({ draftBuilt: built(rid, draft), activeBuilt: built(rid, active), draftAuthored: Object.keys(draft.structure || {}),
  renderedCategories: rendererContract(rid).renderedCategories, deletedIds: [], textEdit: true, ...over });
const outcome = (fn) => { try { const r = fn(); return { ok: true, additions: r.additions, removals: r.removals }; } catch (e) { return { code: e.code, field: e.field }; } };
const judge = (rid, a, d, over) => outcome(() => SC.compareToActive(args(rid, a, d, over)));
const today = (rid, a, d, over) => outcome(() => AP.compareToActive(args(rid, a, d, over)));
const ON = (fn) => { STRUCT.sections = true; try { return fn(); } finally { STRUCT.sections = false; } };
const refused = (o, code, L) => assert.strictEqual(o.code, code, `${L}: expected ${code}, got ${JSON.stringify(o)}`);
const accepted = (o, L) => assert.ok(o.ok, `${L}: expected accepted, got ${JSON.stringify(o)}`);

const LM = buildSourceFromCode('la_musa');
const XP = buildSourceFromCode('x_pizza');
const item = (src, key) => src.items.find((i) => i.key === key);
// the S4 writer's source edits (what portal-ui's mutators must produce)
const addCat = (src, c, at = src.structure.categories.length) => { src.structure.categories.splice(at, 0, c); return src; };
const move = (src, key, cat, subcat) => { const d = item(src, key).display; d.cat = cat; if (subcat === undefined) delete d.subcat; else d.subcat = subcat; return src; };
// the extras maps follow membership: the writer re-projects them (accountAuthored proves they equal the projection)
const reproject = (rid, src) => { const b = built(rid, src); const m = projectExtrasMaps({ items: b.items, extras: b.extras, structure: b.structure }); src.structure.extras_by_category = m.byCategory; src.structure.extras_by_item = m.byItem; return src; };
const newDish = (src, fromKey, key, cat) => { const f = clone(item(src, fromKey)); f.key = key; f.display = { ...f.display, id: key, name: `${f.display.name} Nuevo`, cat }; delete f.display.subcat; src.items.push(f); src.structure.item_order.push(key); return src; };
const postres = () => reproject('la_musa', move(addCat(clone(LM), { id: 'postres', name: 'Postres' }), 'dimsum_01', 'postres'));

cell('SC-OFF-IDENTICAL: switch OFF → add-product.compareToActive itself (same outcome on accepted and refused drafts)', (L) => {
  const price = clone(LM); item(price, 'dimsum_02').price += 1;
  for (const d of [price, postres()]) assert.deepStrictEqual(judge('la_musa', LM, d), today('la_musa', LM, d), L);
  refused(judge('la_musa', LM, postres()), 'category_not_renderable', `${L}: OFF, today's first refusal for a move into an unrendered section (add-product.js:445)`);
});
cell('SC-NEWCAT-MOVE: a new category + a dish moved in → accepted ON (R3.1 authorizes it)', (L) => {
  accepted(ON(() => judge('la_musa', LM, postres())), L);
});
cell('SC-NEWCAT-ADD: a NEW dish added straight into a new category → accepted ON, an addition', (L) => {
  const d = reproject('la_musa', newDish(postres(), 'dimsum_02', 'postre_02', 'postres'));
  const o = ON(() => judge('la_musa', LM, d)); accepted(o, L); assert.deepStrictEqual(o.additions, ['postre_02'], L);
});
cell('SC-AUTH-PERSIST (R3.1): a published S4 category keeps accepting moves and additions; OFF → category_not_renderable', (L) => {
  const live = postres();   // already published: active carries `postres`, outside the frozen renderedCategories
  const mv = reproject('la_musa', move(clone(live), 'dimsum_03', 'postres'));
  accepted(ON(() => judge('la_musa', live, mv)), `${L}: second move`);
  const ad = reproject('la_musa', newDish(clone(live), 'dimsum_02', 'postre_03', 'postres'));
  accepted(ON(() => judge('la_musa', live, ad)), `${L}: second add`);
  refused(judge('la_musa', live, mv), 'category_not_renderable', `${L}: OFF move`);
  refused(judge('la_musa', live, ad), 'category_not_renderable', `${L}: OFF add`);
});
cell('SC-ORDER-SECTIONS: two live sections swapped → ON accepted; OFF structure_changed', (L) => {
  const d = clone(LM); const c = d.structure.categories; [c[0], c[1]] = [c[1], c[0]];
  accepted(ON(() => judge('la_musa', LM, d)), L); refused(judge('la_musa', LM, d), 'structure_changed', L);
});
cell('SC-ORDER-ITEMS: two dishes swapped in item_order → ON accepted; OFF item_order_changed', (L) => {
  const d = clone(LM); const o = d.structure.item_order; [o[0], o[1]] = [o[1], o[0]];
  accepted(ON(() => judge('la_musa', LM, d)), L); refused(judge('la_musa', LM, d), 'item_order_changed', L);
});
cell('SC-NO-DELETE (Q6): a live category removed (its dishes moved out) → structure_changed {categories}', (L) => {
  const d = clone(LM); for (const i of d.items) if (i.display.cat === 'crudo') i.display.cat = 'rice';
  d.structure.categories = d.structure.categories.filter((c) => c.id !== 'crudo'); reproject('la_musa', d);
  const o = ON(() => judge('la_musa', LM, d)); refused(o, 'structure_changed', L); assert.strictEqual(o.field, 'categories', L);
});
cell('SC-LIVE-FIELDS: a live category\'s layout changed → structure_changed', (L) => {
  const d = clone(LM); d.structure.categories.find((c) => c.id === 'bebidas').layout = 'grid';
  refused(ON(() => judge('la_musa', LM, d)), 'structure_changed', L);
});
cell('SC-NEWCAT-SHAPE: id syntax / name required / ≤ 40 / unique case-folded / no other fields', (L) => {
  const mk = (c) => reproject('la_musa', move(addCat(clone(LM), c), 'dimsum_01', c.id));
  refused(ON(() => judge('la_musa', LM, mk({ id: 'Postres', name: 'Postres' }))), 'category_id_invalid', `${L}: id`);
  refused(ON(() => judge('la_musa', LM, mk({ id: 'postres' }))), 'category_name_required', `${L}: no name`);
  refused(ON(() => judge('la_musa', LM, mk({ id: 'postres', name: '   ' }))), 'category_name_required', `${L}: blank`);
  refused(ON(() => judge('la_musa', LM, mk({ id: 'postres', name: 'P'.repeat(41) }))), 'category_name_too_long', `${L}: 41`);
  accepted(ON(() => judge('la_musa', LM, mk({ id: 'postres', name: 'P'.repeat(40) }))), `${L}: 40`);
  refused(ON(() => judge('la_musa', LM, mk({ id: 'postres', name: 'dim  SUM' }))), 'category_name_taken', `${L}: folded dup`);
  refused(ON(() => judge('la_musa', LM, mk({ id: 'postres', name: 'Postres', layout: 'grid' }))), 'structure_changed', `${L}: extra field`);
});
cell('SC-UNNAMED (Q5): x_pizza\'s seed categories are unnamed → a new category is refused categories_unnamed (409)', (L) => {
  const d = clone(XP); addCat(d, { id: 'postres', name: 'Postres' }); move(d, XP.items.find((i) => i.display.cat === 'individual').key, 'postres');
  const o = ON(() => judge('x_pizza', XP, d)); refused(o, 'categories_unnamed', L);
});
cell('SC-RENAME-ALONE (Q8): a LIVE rename beside a new category → rename_not_alone; the rename alone → accepted', (L) => {
  const d = postres(); d.structure.categories.find((c) => c.id === 'crudo').name = 'Crudos';
  refused(ON(() => judge('la_musa', LM, d)), 'rename_not_alone', L);
  const r = clone(LM); r.structure.categories.find((c) => c.id === 'crudo').name = 'Crudos';
  accepted(ON(() => judge('la_musa', LM, r)), `${L}: alone`);
});
cell('SC-RENAME-ALONE-S4 (Q8): a LIVE rename beside ANY S4 op the reverted copy hides (section order, staged, subcats, dish order) → rename_not_alone', (L) => {
  const rn = (d) => { d.structure.categories.find((c) => c.id === 'crudo').name = 'Crudos'; return d; };
  const order = rn(clone(LM)); const c = order.structure.categories; [c[0], c[1]] = [c[1], c[0]];
  const stg = rn(clone(LM)); stg.structure.staged_categories = [{ id: 'postres', name: 'Postres', after: null }];
  const sub = rn(clone(LM)); sub.structure.categories.find((x) => x.id === 'bebidas').subcats.push('Jugos'); move(sub, 'soft_04', 'bebidas', 'Jugos');
  const dish = rn(clone(LM)); const o = dish.structure.item_order; [o[0], o[1]] = [o[1], o[0]];
  for (const [what, d] of Object.entries({ order, stg, sub, dish })) refused(ON(() => judge('la_musa', LM, d)), 'rename_not_alone', `${L}: ${what}`);
});
cell('SC-SUBCAT-ADD: a new subcat on bebidas with a member moved in → ON accepted; OFF structure_changed', (L) => {
  const d = clone(LM); d.structure.categories.find((c) => c.id === 'bebidas').subcats.push('Jugos'); move(d, 'soft_04', 'bebidas', 'Jugos');
  accepted(ON(() => judge('la_musa', LM, d)), L); refused(judge('la_musa', LM, d), 'structure_changed', L);
});
cell('SC-SUBCAT-RENAME (Q3): Sodas → Refrescos at its index, EVERY member rewritten → accepted', (L) => {
  const d = clone(LM); const b = d.structure.categories.find((c) => c.id === 'bebidas'); b.subcats[0] = 'Refrescos';
  for (const i of d.items) if (i.display.subcat === 'Sodas') i.display.subcat = 'Refrescos';
  accepted(ON(() => judge('la_musa', LM, d)), L);
});
cell('SC-SUBCAT-REMOVE (Q6): Sodas removed, its members merged into Cervezas → subcat_removed', (L) => {
  const d = clone(LM); const b = d.structure.categories.find((c) => c.id === 'bebidas'); b.subcats = ['Cervezas'];
  for (const i of d.items) if (i.display.subcat === 'Sodas') i.display.subcat = 'Cervezas';
  refused(ON(() => judge('la_musa', LM, d)), 'subcat_removed', L);
});
cell('SC-SUBCAT-NAMES: ≤ 40, unique case-folded within the category', (L) => {
  const d = clone(LM); d.structure.categories.find((c) => c.id === 'bebidas').subcats.push('sodas '); move(d, 'soft_04', 'bebidas', 'sodas ');
  refused(ON(() => judge('la_musa', LM, d)), 'subcat_name_taken', `${L}: dup`);
  const e = clone(LM); const nm = 'J'.repeat(41); e.structure.categories.find((c) => c.id === 'bebidas').subcats.push(nm); move(e, 'soft_04', 'bebidas', nm);
  refused(ON(() => judge('la_musa', LM, e)), 'subcat_name_too_long', `${L}: 41`);
});
cell('SC-CAPS: the 31st category and the 13th subcat → structure_caps', (L) => {
  const d = clone(LM); const keys = d.items.filter((i) => i.display.cat === 'bebidas').map((i) => i.key);
  for (let k = 0; k < 23; k++) { addCat(d, { id: `cat_${k}`, name: `Cat ${k}` }); move(d, LM.items[k].key, `cat_${k}`); }
  reproject('la_musa', d);
  const o = outcome(() => ON(() => SC.compareToActive(args('la_musa', LM, d)))); refused(o, 'structure_caps', `${L}: 31 categories (8 + 23)`);
  const e = clone(LM); const b = e.structure.categories.find((c) => c.id === 'bebidas');
  for (let k = 0; k < 11; k++) { b.subcats.push(`S${k}`); move(e, keys[k], 'bebidas', `S${k}`); }
  refused(ON(() => judge('la_musa', LM, e)), 'structure_caps', `${L}: 13 subcats`);
});
cell('SC-AUTHORED-GUARD (R3.2): a new category in an AUTHORED map → section_not_attachable_yet (409)', (L) => {
  const a = postres(); a.structure.exposure.category_allow.postres = ['Salsas'];
  refused(ON(() => judge('la_musa', LM, a)), 'section_not_attachable_yet', `${L}: category_allow`);
  const r = postres(); r.structure.redeem_eligible_cats = [...r.structure.redeem_eligible_cats, 'postres'];
  refused(ON(() => judge('la_musa', LM, r)), 'section_not_attachable_yet', `${L}: redeem_eligible_cats`);
});
cell('SC-PERDISH-MOVE (R4.1): rice_03 (item-only Proteínas) → a new category; maps re-projected → accepted ON; OFF refused', (L) => {
  const d = reproject('la_musa', move(addCat(clone(LM), { id: 'postres', name: 'Postres' }), 'rice_03', 'postres'));
  assert.notDeepStrictEqual(d.structure.extras_by_item, LM.structure.extras_by_item, `${L}: premise: the projection moved`);
  accepted(ON(() => judge('la_musa', LM, d)), L);
  refused(judge('la_musa', LM, d), 'category_not_renderable', `${L}: OFF`);
});
cell('SC-PERDISH-NEGATIVE (R4.1): the same move + a hand-edited extras_by_item (≠ the projection) → the SAVE refuses structure_unexplained', (L) => {
  // the builder derives the maps (a hand edit never reaches the built records), so a non-projection map is caught where it is authored:
  // the save's accountAuthored (source-accounting.js, every save, whatever the switches say)
  const d = reproject('la_musa', move(addCat(clone(LM), { id: 'postres', name: 'Postres' }), 'rice_03', 'postres'));
  d.structure.extras_by_item = { ...d.structure.extras_by_item, dimsum_01: ['Salsas'] };
  const b = built('la_musa', d);
  const o = outcome(() => ON(() => { require('./source-accounting').accountAuthored({ next: d, stored: LM, draftRecords: { items: b.items, extras: b.extras, structure: b.structure } }); return { additions: [], removals: [] }; }));
  refused(o, 'structure_unexplained', L);
});
cell('SC-PERDISH-EXPOSURE (R4.1 condition 1): the move + an authored exposure change → no claim, judged as today', (L) => {
  const d = move(addCat(clone(LM), { id: 'postres', name: 'Postres' }), 'rice_03', 'postres');
  d.structure.exposure.item_overrides.dimsum_01 = { deny: ['Salsas'] }; reproject('la_musa', d);
  const o = ON(() => judge('la_musa', LM, d)); assert.ok(!o.ok, `${L}: refused (${JSON.stringify(o)})`);
});
cell('SC-X-MATRIX (R2.3/R3.2, sections × extrasCatalog): attach a group to a LIVE category → S2\'s rule, unchanged by S4; to a NEW category → refused whatever extrasCatalog says', (L) => {
  const live = clone(LM); live.structure.exposure.category_allow.dim_sum = [...live.structure.exposure.category_allow.dim_sum, 'Proteínas']; reproject('la_musa', live);
  for (const xc of [false, true]) {
    const over = { extrasCatalog: xc, extrasAuthoring: true };
    assert.deepStrictEqual(ON(() => judge('la_musa', LM, live, over)), today('la_musa', LM, live, over), `${L}: live attach, extrasCatalog ${xc} — S4 changes nothing`);
    const nw = postres(); nw.structure.exposure.category_allow.postres = ['Proteínas']; reproject('la_musa', nw);
    refused(ON(() => judge('la_musa', LM, nw, over)), 'section_not_attachable_yet', `${L}: new-category attach, extrasCatalog ${xc}`);
    accepted(ON(() => judge('la_musa', LM, postres(), over)), `${L}: the plain new-category move, extrasCatalog ${xc}`);
  }
});
cell('SC-COMPOSE (S0-2): through choice-compare, choiceEdit OFF (:26) and ON (:70), sections ON reaches S4', (L) => {
  for (const ce of [false, true]) {
    STRUCT.choiceEdit = ce;
    try {
      const o = outcome(() => ON(() => CC.compareToActive('la_musa', args('la_musa', LM, postres()))));
      accepted(o, `${L}: choiceEdit ${ce}`);
    } finally { STRUCT.choiceEdit = false; }
  }
});

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
