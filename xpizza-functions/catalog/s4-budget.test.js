'use strict';
// S4 (PLAN-structure-S4-r4 R2.8, R3.4) — the sections op budget. structure-budget.enforce dispatches to the S4 count BEFORE its extras-OFF
// exit, so both existing call sites (the save, edit-catalog-handler; the manager request / publish, structure-gate) cover it unchanged.
// S4 ops: one per new / renamed declared category, per staged add / drop / rename / move / promote, per added or renamed subcat, per
// changed section order, per changed subcat order, per dish whose section, subcat or rank (among the dishes both carry) changed.
// sections ON alone: S4 ops ≤ 60. With extrasCatalog ON too: S2 ops + S4 ops ≤ 60 (one draft, one budget). Counted on the ORIGINAL draft
// the caller passes (choice-compare's S3 reduction is internal to its own copy). Run: node catalog/s4-budget.test.js
const assert = require('assert');
const STRUCT = { sections: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: false, sections: STRUCT.sections }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { projectExtrasMaps } = require('./extras-projection');
const B = require('./structure-budget');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const ON = (fn) => { STRUCT.sections = true; try { return fn(); } finally { STRUCT.sections = false; } };
const LM = buildSourceFromCode('la_musa');
const built = (src) => { const b = buildSourceCandidate('la_musa', src).built; return { items: b.items, extras: b.extras, structure: b.structure }; };
const item = (src, key) => src.items.find((i) => i.key === key);
const swap = (src, a, b) => { const o = src.structure.item_order; const i = o.indexOf(a); const j = o.indexOf(b); [o[i], o[j]] = [o[j], o[i]]; return src; };
const ops = (d, a = LM) => B.sectionOpsOf(built(d), built(a));
const run = (d, over = {}) => { try { return { ok: B.enforce({ rid: 'la_musa', source: d, draft: built(d), active: built(LM), extrasCatalog: false, ...over }) }; } catch (e) { return { code: e.code, field: e.field }; } };

cell('BUD-COUNT: each S4 change counts as R2.8 says', (L) => {
  assert.strictEqual(ops(swap(clone(LM), 'dimsum_01', 'dimsum_02')), 2, `${L}: two dishes swap rank`);
  const nc = clone(LM); nc.structure.categories.push({ id: 'postres', name: 'Postres' }); item(nc, 'dimsum_01').display.cat = 'postres';
  assert.strictEqual(ops(nc), 2, `${L}: a new category + its dish (section changed); dim_sum's other ranks are relative and unchanged`);
  const sc = clone(LM); const c = sc.structure.categories; [c[0], c[1]] = [c[1], c[0]];
  assert.strictEqual(ops(sc), 1, `${L}: one section-order change`);
  const st = clone(LM); st.structure.staged_categories = [{ id: 'postres', name: 'Postres', after: null }];
  assert.strictEqual(ops(st), 1, `${L}: a staged add`);
  const sub = clone(LM); sub.structure.categories.find((x) => x.id === 'bebidas').subcats.push('Jugos'); item(sub, 'soft_04').display.subcat = 'Jugos';
  assert.strictEqual(ops(sub), 2, `${L}: a subcat added + its dish's subcat`);
  const rn = clone(LM); rn.structure.categories.find((x) => x.id === 'crudo').name = 'Crudos';
  assert.strictEqual(ops(rn), 1, `${L}: a live category rename`);
  const pr = clone(LM); pr.structure.categories.push({ id: 'postres', name: 'Postres' }); item(pr, 'dimsum_01').display.cat = 'postres';
  assert.strictEqual(ops(pr, st), 2, `${L}: a promotion (1) + its dish (1)`);
  assert.strictEqual(ops(clone(LM)), 0, `${L}: nothing`);
});
cell('BUD-SUBCAT-RENAME-MOVE (portal-ui repro): Sodas → Refrescos + the order [Cervezas, Refrescos] → 2 ops (the rename, the subcat order) + its 4 dishes\' subcat', (L) => {
  const d = clone(LM); d.structure.categories.find((x) => x.id === 'bebidas').subcats = ['Cervezas', 'Refrescos'];
  for (const it of d.items) if (it.display.subcat === 'Sodas') it.display.subcat = 'Refrescos';
  assert.strictEqual(ops(d), 6, L);
});
cell('BUD-OFF: sections OFF → nothing S4 is measured (extras OFF: enforce is today\'s null)', (L) => {
  const d = clone(LM); d.structure.item_order.reverse();
  assert.deepStrictEqual(run(d), { ok: null }, L);
});
cell('BUD-S4-ONLY (R3.4): sections ON, extrasCatalog OFF → S4 ops > the cap refuse structure_caps {ops}; at the cap passes', (L) => {
  const d = swap(swap(clone(LM), 'dimsum_01', 'dimsum_02'), 'starter_01', 'starter_02');
  assert.strictEqual(ON(() => B.sectionOpsOf(built(d), built(LM))), 4, `${L}: premise 4 ops`);
  assert.deepStrictEqual(ON(() => run(d, { limits: { ...B.LIMITS, ops: 3 } })), { code: 'structure_caps', field: 'ops' }, `${L}: 4 > 3`);
  assert.ok(ON(() => run(d, { limits: { ...B.LIMITS, ops: 4 } })).ok !== undefined, `${L}: 4 ≤ 4`);
});
cell('BUD-COMBINED (R3.4): both switches ON → S2 ops + S4 ops share ONE cap', (L) => {
  const d = swap(clone(LM), 'dimsum_01', 'dimsum_02');   // 2 S4 ops
  d.structure.exposure.category_allow.dim_sum = [...d.structure.exposure.category_allow.dim_sum, 'Proteínas'];   // 1 S2 op
  const b = built(d); const m = projectExtrasMaps(b); d.structure.extras_by_category = m.byCategory; d.structure.extras_by_item = m.byItem;
  assert.strictEqual(B.opsOf(built(d), built(LM)), 1, `${L}: premise S2 1`);
  assert.deepStrictEqual(ON(() => run(d, { extrasCatalog: true, limits: { ...B.LIMITS, ops: 2 } })), { code: 'structure_caps', field: 'ops' }, `${L}: 1 + 2 > 2`);
  assert.ok(ON(() => run(d, { extrasCatalog: true, limits: { ...B.LIMITS, ops: 3 } })).ok, `${L}: 1 + 2 ≤ 3`);
  assert.ok(run(d, { extrasCatalog: true, limits: { ...B.LIMITS, ops: 2 } }).ok, `${L}: sections OFF → S2 alone (1 ≤ 2)`);
});
cell('BUD-ORIGINAL (R3.4): a new option appended under an existing dish (S3) does not distort the count of the original draft', (L) => {
  const d = swap(clone(LM), 'dimsum_01', 'dimsum_02');
  const opt = clone(item(d, 'dimsum_03')); opt.key = 'dimsum_03_x'; opt.display = { ...opt.display, id: 'dimsum_03_x', name: `${opt.display.name} X` }; d.items.push(opt); d.structure.item_order.push('dimsum_03_x');
  assert.strictEqual(ops(d), 2, L);
});

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
