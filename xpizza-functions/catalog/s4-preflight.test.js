'use strict';
// S4 (PLAN-structure-S4-r4 R3.1, R2.5/R3.6, R3.3/R4.2, R3.5) — the save/publish EDIT PREFLIGHT under the sections switch: every
// declared category is renderable (R3.1); typed subcat refusals before validation (R2.5, every affected member R3.6); declared
// categories never empty (R3.3); promotion order verified against the STORED draft (R4.2); new ids re-derived (R3.5).
// Real seeds → real build for `live`; the draft is the source being saved. Run: node catalog/s4-preflight.test.js
const assert = require('assert');
const STRUCT = { sections: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: false, sections: STRUCT.sections }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { rendererContract } = require('./source-store');
const PF = require('./edit-preflight');
const ST = require('./section-transitions');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const LM = buildSourceFromCode('la_musa');
const liveOf = (src) => { const b = buildSourceCandidate('la_musa', src).built; return { items: b.items, structure: b.structure }; };
const LIVE = liveOf(LM);
const item = (src, key) => src.items.find((i) => i.key === key);
const ON = (fn) => { STRUCT.sections = true; try { return fn(); } finally { STRUCT.sections = false; } };
const pf = (draft, live = LIVE, extra = {}) => PF.editPreflight({ draft, live, renderedCategories: rendererContract('la_musa').renderedCategories, ...extra });
const err = (r) => (r ? r.body.error : null);

cell('S4PF-RENDER (R3.1): a move into a declared NEW category passes ON; OFF → category_not_renderable', (L) => {
  const d = clone(LM); d.structure.categories.push({ id: 'postres', name: 'Postres' }); item(d, 'dimsum_01').display.cat = 'postres';
  assert.strictEqual(err(ON(() => pf(d))), null, `${L}: ON`);
  assert.strictEqual(err(pf(d)), 'category_not_renderable', `${L}: OFF`);
});
cell('S4PF-RENDER-UNDECLARED: ON never authorizes an UNdeclared category', (L) => {
  const d = clone(LM); item(d, 'dimsum_01').display.cat = 'ghost';
  assert.notStrictEqual(err(ON(() => pf(d))), null, L);
});

const cat = (src, id) => src.structure.categories.find((c) => c.id === id);
const sub = (src, key, subcat) => { const d = item(src, key).display; if (subcat === undefined) delete d.subcat; else d.subcat = subcat; return src; };
cell('S4PF-SUB-GROUPED (R2.5): a new subcat with a member moved in passes; an EMPTY new subcat → subcat_empty', (L) => {
  const d = clone(LM); cat(d, 'bebidas').subcats.push('Jugos'); sub(d, 'soft_04', 'Jugos');
  assert.strictEqual(err(ON(() => pf(d))), null, `${L}: populated`);
  const e = clone(LM); cat(e, 'bebidas').subcats.push('Jugos');
  assert.strictEqual(err(ON(() => pf(e))), 'subcat_empty', `${L}: empty`);
});
cell('S4PF-SUB-FIRST (R2.5/R3.6): the FIRST subcats of an ungrouped section must place EVERY member (incl. ones that did not move)', (L) => {
  const keys = LM.items.filter((i) => i.display.cat === 'dim_sum').map((i) => i.key);
  const d = clone(LM); cat(d, 'dim_sum').subcats = ['Vapor', 'Fritos']; keys.forEach((k, i) => sub(d, k, i % 2 ? 'Fritos' : 'Vapor'));
  assert.strictEqual(err(ON(() => pf(d))), null, `${L}: all placed`);
  const e = clone(LM); cat(e, 'dim_sum').subcats = ['Vapor', 'Fritos']; keys.slice(1).forEach((k, i) => sub(e, k, i % 2 ? 'Fritos' : 'Vapor'));
  const r = ON(() => pf(e)); assert.strictEqual(err(r), 'subcat_partial', `${L}: one left`); assert.deepStrictEqual(r.body.missing, [keys[0]], `${L}: names the unplaced member`);
});
cell('S4PF-EMPTY (R3.3): a declared NEW category with no dish → section_emptied; a promoted-and-published one emptied → section_emptied', (L) => {
  const d = clone(LM); d.structure.categories.push({ id: 'postres', name: 'Postres' });
  assert.strictEqual(err(ON(() => pf(d))), 'section_emptied', `${L}: declared empty`);
  const pub = clone(LM); pub.structure.categories.push({ id: 'postres', name: 'Postres' }); item(pub, 'dimsum_01').display.cat = 'postres';
  const back = clone(pub); item(back, 'dimsum_01').display.cat = 'dim_sum';
  assert.strictEqual(err(ON(() => pf(back, liveOf(pub)))), 'section_emptied', `${L}: published S4 category emptied`);
});
const P = (id, name, after = 'crudo') => ({ id, name, after });
const withStaged = (src, list) => { const s = clone(src); if (list.length) s.structure.staged_categories = list; else delete s.structure.staged_categories; return s; };
cell('S4PF-SLUG (R3.5): new ids are re-derived against the STORED draft; stored ids are immutable (a rename never re-derives)', (L) => {
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres', 'Postres')]), LIVE, { stored: LM }))), null, `${L}: derived`);
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres_x', 'Postres')]), LIVE, { stored: LM }))), 'category_id_mismatch', `${L}: not the slug`);
  const st = withStaged(LM, [P('postres', 'Postres')]);
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres', 'Dulces')]), LIVE, { stored: st }))), null, `${L}: rename keeps the id`);
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres', 'Postres'), P('postres_2', 'Póstres!')]), LIVE, { stored: LM }))), null, `${L}: two colliding, in order`);
  // advisor 11-13 ruling 3 (R3.5 narrowed): the check is order-independent, so the swapped allocation (another creation order) is VALID
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres_2', 'Postres'), P('postres', 'Póstres!')]), LIVE, { stored: LM }))), null, `${L}: swapped = another creation order, accepted`);
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('c_2x1', '2x1')]), LIVE, { stored: LM }))), null, `${L}: digit-leading`);
});
const promote = (src, ids, order) => { const s = clone(src); for (const id of ids) { const e = s.structure.staged_categories.find((x) => x.id === id); s.structure.staged_categories = s.structure.staged_categories.filter((x) => x.id !== id); s.structure.categories.push({ id, name: e.name }); } if (!s.structure.staged_categories.length) delete s.structure.staged_categories;
  s.structure.categories = order.map((id) => s.structure.categories.find((c) => c.id === id)); return s; };
const ids = (src) => src.structure.categories.map((c) => c.id);
cell('S4PF-PROMOTE (R4.2): one save promoting A and B on one anchor → …crudo, A, B…; any other order → staged_promotion_mismatch', (L) => {
  const stored = withStaged(LM, [P('aa', 'Aa'), P('bb', 'Bb')]);
  const base = ids(LM); const at = base.indexOf('crudo') + 1;
  const good = [...base.slice(0, at), 'aa', 'bb', ...base.slice(at)]; const bad = [...base.slice(0, at), 'bb', 'aa', ...base.slice(at)];
  const mv = (s, k, c) => { item(s, k).display.cat = c; return s; };
  assert.strictEqual(err(ON(() => pf(mv(mv(promote(stored, ['aa', 'bb'], good), 'dimsum_01', 'aa'), 'dimsum_02', 'bb'), LIVE, { stored }))), null, `${L}: rule order`);
  assert.strictEqual(err(ON(() => pf(mv(mv(promote(stored, ['aa', 'bb'], bad), 'dimsum_01', 'aa'), 'dimsum_02', 'bb'), LIVE, { stored }))), 'staged_promotion_mismatch', `${L}: swapped`);
});
cell('S4PF-PROMOTE-TWO-SAVES (R4.2): A then B on one anchor in separate saves → …crudo, B, A…; …crudo, A, B… at save 2 → mismatch', (L) => {
  const s0 = withStaged(LM, [P('aa', 'Aa'), P('bb', 'Bb')]);
  const base = ids(LM); const at = base.indexOf('crudo') + 1;
  const mv = (s, k, c) => { item(s, k).display.cat = c; return s; };
  const s1 = mv(promote(s0, ['aa'], [...base.slice(0, at), 'aa', ...base.slice(at)]), 'dimsum_01', 'aa');
  assert.strictEqual(err(ON(() => pf(s1, LIVE, { stored: s0 }))), null, `${L}: save 1`);
  const ok2 = mv(promote(s1, ['bb'], [...base.slice(0, at), 'bb', 'aa', ...base.slice(at)]), 'dimsum_02', 'bb');
  assert.strictEqual(err(ON(() => pf(ok2, LIVE, { stored: s1 }))), null, `${L}: save 2 → B before A`);
  const bad2 = mv(promote(s1, ['bb'], [...base.slice(0, at), 'aa', 'bb', ...base.slice(at)]), 'dimsum_02', 'bb');
  assert.strictEqual(err(ON(() => pf(bad2, LIVE, { stored: s1 }))), 'staged_promotion_mismatch', `${L}: save 2 claiming A before B`);
});
cell('S4PF-NO-STORED (R3.5/R4.2): publish / request pass no stored draft → slug and promotion order are not re-checked there', (L) => {
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres_x', 'Postres')])))), null, L);
});
cell('S4PF-OFF: none of the S4 checks run with the switch OFF (an empty new subcat is left to validateSource, as today)', (L) => {
  const e = clone(LM); cat(e, 'bebidas').subcats.push('Jugos');
  assert.notStrictEqual(err(pf(e)), 'subcat_empty', L);
});

cell('S4PF-NAME-TAKEN (ruling 2b): a staged or new-category name that folds to an existing one → typed category_name_taken BEFORE validateSource', (L) => {
  const st = withStaged(LM, [P('dim_sum_2', 'Dím  Sum')]);
  const r = ON(() => pf(st, LIVE, { stored: LM })); assert.deepStrictEqual([err(r), r && r.body.key], ['category_name_taken', 'dim_sum_2'], `${L}: staged`);
  const d = clone(LM); d.structure.categories.push({ id: 'crudo_2', name: 'CRUDO' }); item(d, 'dimsum_01').display.cat = 'crudo_2';
  assert.strictEqual(err(ON(() => pf(d, LIVE, { stored: LM }))), 'category_name_taken', `${L}: declared new`);
  const two = withStaged(LM, [P('postres', 'Postres'), P('postres_2', 'postres ')]);
  assert.strictEqual(err(ON(() => pf(two, LIVE, { stored: LM }))), 'category_name_taken', `${L}: two new ones`);
  assert.notStrictEqual(err(pf(st, LIVE, { stored: LM })), 'category_name_taken', `${L}: OFF — today's path`);
});
cell('S4PF-SLUG-ANY-ORDER (ruling 3): each new id = categorySlug(name, stored ∪ the OTHER new ids) — any creation order; a three-way collision', (L) => {
  const names = ['Postres!', 'postres?', 'Postres.'];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms) {
    const ids = ST.allocateCategoryIds(p.map((i) => names[i]), [...LM.structure.categories.map((c) => c.id)]);   // a creation order
    const list = p.map((i, k) => P(ids[k], names[i]));
    assert.deepStrictEqual([...ids].sort(), ['postres', 'postres_2', 'postres_3'], `${L}: premise`);
    assert.strictEqual(err(ON(() => pf(withStaged(LM, list), LIVE, { stored: LM }))), null, `${L}: creation order ${p}`);
    // the same entries listed in a DIFFERENT order (a promotion moved one into categories first) — still accepted
    assert.strictEqual(err(ON(() => pf(withStaged(LM, [...list].reverse()), LIVE, { stored: LM }))), null, `${L}: listed reversed, creation ${p}`);
  }
});
cell('S4PF-SLUG-NEG (ruling 3): a non-slug, a duplicated new id, and an id taken by the stored draft are all category_id_mismatch', (L) => {
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres_3', 'Postres')]), LIVE, { stored: LM }))), 'category_id_mismatch', `${L}: postres_3 alone`);
  assert.strictEqual(err(ON(() => pf(withStaged(LM, [P('postres', 'Postres!'), P('postres', 'postres?')]), LIVE, { stored: LM }))), 'category_id_mismatch', `${L}: duplicate new ids`);
  const stored = withStaged(LM, [P('postres', 'Postres')]);
  const d = withStaged(LM, [P('postres', 'Postres'), P('postres', 'Postres?')]);
  assert.strictEqual(err(ON(() => pf(d, LIVE, { stored }))), 'category_id_mismatch', `${L}: a new entry reusing a stored id`);
});

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
