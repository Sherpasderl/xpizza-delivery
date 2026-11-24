'use strict';
// S4 (PLAN-structure-S4-r4 §1.2, R2.1, S0-1, S0-5, R2.7/R3.3) — STAGED categories: a new category with no dish lives only in
// structure.staged_categories [{ id, name, after }]. It is validated (validateSource), carried source → build → version (R2.1), NEVER
// served (composeServedMenu carries only CARRIED_FROM_STRUCTURE; the form bundle and the KDS manifest are composed from dishes), kept by
// the migration (KNOWN_STRUCTURE_FIELDS), and judged: OFF any change refuses (the key set: assertSameAuthoredFields; a value: the
// residual accounting, S0-1's hole closed); ON section-compare judges it and the save may add / drop the key.
// Real seeds → real build. Run: node catalog/s4-staging.test.js
const assert = require('assert');
const STRUCT = { sections: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: false, sections: STRUCT.sections }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const SS = require('./source-store');
const { composeServedMenu } = require('./public-menu');
const { generateKdsManifest } = require('./generate-form-bundle');
const AP = require('./add-product');
const SC = require('./section-compare');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const ON = (fn) => { STRUCT.sections = true; try { return fn(); } finally { STRUCT.sections = false; } };
const LM = buildSourceFromCode('la_musa');
const built = (src) => { const b = buildSourceCandidate('la_musa', src).built; return { items: b.items, extras: b.extras, structure: b.structure }; };
const staged = (list) => { const s = clone(LM); s.structure.staged_categories = list; return s; };
const P = { id: 'postres', name: 'Postres', after: 'bebidas' };
const valid = (src) => { try { SS.validateSource(src, 'la_musa'); return null; } catch (e) { return e.message; } };
const outcome = (fn) => { try { fn(); return { ok: true }; } catch (e) { return { code: e.code, field: e.field }; } };
const args = (a, d) => ({ draftBuilt: built(d), activeBuilt: built(a), draftAuthored: Object.keys(d.structure), renderedCategories: SS.rendererContract('la_musa').renderedCategories, deletedIds: [], textEdit: true });

cell('STG-VALID: a well-formed staged list validates', (L) => { assert.strictEqual(valid(staged([P, { id: 'cafe', name: 'Café', after: null }])), null, L); });
cell('STG-VALIDATE: every malformed staged entry is refused by validateSource', (L) => {
  const bad = {
    'empty list': [], 'not an array': { x: 1 }, 'extra field': [{ ...P, layout: 'grid' }], 'id syntax': [{ ...P, id: 'Postres' }],
    'id = a category': [{ ...P, id: 'bebidas' }], 'duplicate id': [P, { ...P, name: 'Otra' }], 'no name': [{ ...P, name: '' }],
    'name > 40': [{ ...P, name: 'P'.repeat(41) }], 'name = a category (folded)': [{ ...P, name: 'BEBIDAS ' }],
    'anchor undeclared': [{ ...P, after: 'ghost' }], 'anchor staged (R3.3)': [P, { id: 'cafe', name: 'Café', after: 'postres' }], 'anchor self': [{ ...P, after: 'postres' }],
    'after missing': [{ id: 'postres', name: 'Postres' }],
  };
  for (const [what, list] of Object.entries(bad)) assert.ok(valid(staged(list)), `${L}: ${what} must be refused`);
});
cell('STG-KNOWN: the migration keeps the field (KNOWN_STRUCTURE_FIELDS)', (L) => { assert.ok(SS.KNOWN_STRUCTURE_FIELDS.includes('staged_categories'), L); });
cell('STG-TRANSFER (R2.1): source → build carries staged_categories verbatim into the built structure', (L) => {
  assert.deepStrictEqual(built(staged([P])).structure.staged_categories, [P], L);
  assert.ok(!('staged_categories' in built(LM).structure), `${L}: absent stays absent`);
});
cell('STG-NEVER-SERVED (S0-5): the served body, the form bundle composition and the KDS manifest are byte-identical with and without a staged entry', (L) => {
  const a = built(LM); const b = built(staged([P]));
  assert.strictEqual(JSON.stringify(composeServedMenu('la_musa', b)), JSON.stringify(composeServedMenu('la_musa', a)), `${L}: served`);
  assert.strictEqual(JSON.stringify(generateKdsManifest('la_musa', b)), JSON.stringify(generateKdsManifest('la_musa', a)), `${L}: KDS`);
});
cell('STG-OFF-KEY: sections OFF → a save that ADDS the key refuses structure_changed (assertSameAuthoredFields)', (L) => {
  const o = outcome(() => AP.assertSameAuthoredFields(staged([P]).structure, LM.structure, {}));
  assert.strictEqual(o.code, 'structure_changed', L);
});
cell('STG-OFF-VALUE (S0-1 hole closed): sections OFF, both carry the key, the value differs → structure_unexplained', (L) => {
  const o = outcome(() => AP.compareToActive(args(staged([P]), staged([{ ...P, name: 'Postres y café' }]))));
  assert.strictEqual(o.code, 'structure_unexplained', `${L}: ${JSON.stringify(o)}`);
  assert.ok(outcome(() => SC.compareToActive(args(staged([P]), staged([{ ...P, name: 'Postres y café' }])))).code === 'structure_unexplained', `${L}: section-compare OFF = the same`);
});
cell('STG-ON-KEY: sections ON → the save may add / drop the key (assertSameAuthoredFields stagedFree)', (L) => {
  assert.ok(outcome(() => AP.assertSameAuthoredFields(staged([P]).structure, LM.structure, { stagedFree: true })).ok, `${L}: add`);
  assert.ok(outcome(() => AP.assertSameAuthoredFields(LM.structure, staged([P]).structure, { stagedFree: true })).ok, `${L}: drop`);
});
cell('STG-ON-JUDGE: sections ON → a staged add / rename / re-anchor / drop is accepted by section-compare', (L) => {
  for (const [a, d] of [[LM, staged([P])], [staged([P]), staged([{ ...P, name: 'Postres y café' }])], [staged([P]), staged([{ ...P, after: 'crudo' }])], [staged([P]), LM]]) {
    const o = outcome(() => ON(() => SC.compareToActive(args(a, d)))); assert.ok(o.ok, `${L}: ${JSON.stringify(o)}`);
  }
});
cell('STG-ON-CAPS: categories + staged ≤ 30', (L) => {
  const list = []; for (let k = 0; k < 23; k++) list.push({ id: `cat_${k}`, name: `Cat ${k}`, after: null });
  assert.strictEqual(outcome(() => ON(() => SC.compareToActive(args(LM, staged(list))))).code, 'structure_caps', `${L}: 8 + 23`);
  assert.ok(outcome(() => ON(() => SC.compareToActive(args(LM, staged(list.slice(0, 22)))))).ok, `${L}: 8 + 22`);
});
cell('STG-ON-AUTHORED (R3.2): a STAGED id in an authored map → section_not_attachable_yet', (L) => {
  const d = staged([P]); d.structure.redeem_eligible_cats = [...d.structure.redeem_eligible_cats, 'postres'];
  assert.strictEqual(outcome(() => ON(() => SC.compareToActive(args(LM, d)))).code, 'section_not_attachable_yet', L);
});

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
