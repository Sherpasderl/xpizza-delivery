'use strict';
// S4 (PLAN-structure-S4-r4 §4, R2.6, Q9) — the canonical review diff's S4 lines: present ONLY when an S4 op is (s4OpPresent), so a draft
// without one keeps today's diff byte for byte and every token issued before the deploy verifies after it. The lines (out.sections):
//   categories.order {old, new} · added [{id, name}] · subcats [{cat, change, old, new}] · subcat_order [{cat, old, new}]
//   items [{key, cat, old_index, new_index}] (a dish whose rank within its section changed) + item_order_sha256 (the WHOLE order, Q9)
//   staged [{change: add|drop|rename|move|promote, …}] (anchor-only and rank-only moves included) + staged_sha256
// Each binds the token through diffHash = sha256(diff) (catalog-edit payloadOf). Real seeds → real build. Run: node catalog/s4-review-diff.test.js
const assert = require('assert');
const STRUCT = { sections: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: false, sections: STRUCT.sections }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { reviewDiff } = require('./review-diff');
const { sha256 } = require('./catalog-edit');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const ON = (fn) => { STRUCT.sections = true; try { return fn(); } finally { STRUCT.sections = false; } };
const LM = buildSourceFromCode('la_musa');
const built = (src) => buildSourceCandidate('la_musa', src).built;
const diffOf = (live, draft) => { const a = built(live); const b = built(draft); return reviewDiff({ live: a, liveExtraRecords: a.extras, draftBuilt: b, draftExtraRecords: b.extras }); };
const item = (src, key) => src.items.find((i) => i.key === key);
const cat = (src, id) => src.structure.categories.find((c) => c.id === id);
const P = (over = {}) => ({ id: 'postres', name: 'Postres', after: 'bebidas', ...over });
const staged = (src, list) => { const s = clone(src); if (list.length) s.structure.staged_categories = list; else delete s.structure.staged_categories; return s; };

cell('RD-NO-OP-IDENTICAL: sections ON, drafts with NO S4 op (a price, a live rename, an ordinary move) → today\'s diff byte for byte', (L) => {
  const price = clone(LM); item(price, 'dimsum_02').price += 1;
  const rename = clone(LM); cat(rename, 'crudo').name = 'Crudos';
  const mv = clone(LM); item(mv, 'dimsum_01').display.cat = 'starters';
  for (const d of [price, rename, mv]) assert.strictEqual(JSON.stringify(ON(() => diffOf(LM, d))), JSON.stringify(diffOf(LM, d)), L);
});
cell('RD-OFF: sections OFF → no `sections` key even for an S4-shaped draft', (L) => {
  const d = clone(LM); const c = d.structure.categories; [c[0], c[1]] = [c[1], c[0]];
  assert.ok(!('sections' in diffOf(LM, d)), L);
});
cell('RD-NEWCAT: a new category + a dish moved in → added [{id, name}] and the new section order', (L) => {
  const d = clone(LM); d.structure.categories.push({ id: 'postres', name: 'Postres' }); item(d, 'dimsum_01').display.cat = 'postres';
  const s = ON(() => diffOf(LM, d)).sections;
  assert.deepStrictEqual(s.added, [{ id: 'postres', name: 'Postres' }], L);
  assert.deepStrictEqual(s.categories.order.new, [...LM.structure.categories.map((c) => c.id), 'postres'], L);
});
cell('RD-ORDER-SECTIONS: two live sections swapped → categories.order {old, new}', (L) => {
  const d = clone(LM); const c = d.structure.categories; [c[0], c[1]] = [c[1], c[0]];
  const s = ON(() => diffOf(LM, d)).sections;
  assert.deepStrictEqual(s.categories.order, { old: LM.structure.categories.map((x) => x.id), new: d.structure.categories.map((x) => x.id) }, L);
});
cell('RD-ORDER-ITEMS (Q9): two dishes swapped within a section → a row per dish + the whole order\'s sha256', (L) => {
  const d = clone(LM); const o = d.structure.item_order; const i = o.indexOf('dimsum_01'); const j = o.indexOf('dimsum_02'); [o[i], o[j]] = [o[j], o[i]];
  const s = ON(() => diffOf(LM, d)).sections;
  assert.deepStrictEqual(s.items, [{ key: 'dimsum_01', cat: 'dim_sum', old_index: 0, new_index: 1 }, { key: 'dimsum_02', cat: 'dim_sum', old_index: 1, new_index: 0 }], L);
  assert.strictEqual(s.item_order_sha256, sha256(d.structure.item_order), L);
});
cell('RD-SUBCATS: a subcat added and one renamed → subcats rows; a reorder → subcat_order', (L) => {
  const d = clone(LM); const b = cat(d, 'bebidas'); b.subcats = ['Refrescos', 'Cervezas', 'Jugos'];
  for (const it of d.items) if (it.display.subcat === 'Sodas') it.display.subcat = 'Refrescos';
  item(d, 'soft_04').display.subcat = 'Jugos';
  const s = ON(() => diffOf(LM, d)).sections;
  assert.deepStrictEqual(s.subcats, [{ cat: 'bebidas', change: 'renamed', old: 'Sodas', new: 'Refrescos' }, { cat: 'bebidas', change: 'added', old: null, new: 'Jugos' }], L);
  const r = clone(LM); cat(r, 'bebidas').subcats = ['Cervezas', 'Sodas'];
  assert.deepStrictEqual(ON(() => diffOf(LM, r)).sections.subcat_order, [{ cat: 'bebidas', old: ['Sodas', 'Cervezas'], new: ['Cervezas', 'Sodas'] }], `${L}: order`);
});
cell('RD-STAGED (R2.6): every staged transition has its line AND changes diffHash — anchor-only and rank-only moves included', (L) => {
  const base = staged(LM, [P(), P({ id: 'cafe', name: 'Café' })]);
  const cases = {
    add: [LM, base, { change: 'add', id: 'postres', name: 'Postres', after: 'bebidas' }],
    drop: [base, staged(LM, [P({ id: 'cafe', name: 'Café' })]), { change: 'drop', id: 'postres' }],
    rename: [base, staged(LM, [P({ name: 'Dulces' }), P({ id: 'cafe', name: 'Café' })]), { change: 'rename', id: 'postres', old: 'Postres', new: 'Dulces' }],
    anchor: [base, staged(LM, [P({ after: 'crudo' }), P({ id: 'cafe', name: 'Café' })]), { change: 'move', id: 'postres', old_after: 'bebidas', new_after: 'crudo', old_rank: 0, new_rank: 0 }],
    rank: [base, staged(LM, [P({ id: 'cafe', name: 'Café' }), P()]), { change: 'move', id: 'postres', old_after: 'bebidas', new_after: 'bebidas', old_rank: 0, new_rank: 1 }],
  };
  const hashes = new Set();
  for (const [what, [a, d, line]] of Object.entries(cases)) {
    const out = ON(() => diffOf(a, d));
    assert.ok(out.sections && out.sections.staged.some((x) => JSON.stringify(x) === JSON.stringify(line)), `${L}: ${what} line ${JSON.stringify(out.sections && out.sections.staged)}`);
    assert.strictEqual(out.sections.staged_sha256, sha256(d.structure.staged_categories || []), `${L}: ${what} state sha`);
    hashes.add(sha256(out));
  }
  assert.strictEqual(hashes.size, Object.keys(cases).length, `${L}: every transition gives a different diffHash`);
});
cell('RD-PROMOTE (R2.6): a staged category promoted by its first dish → a promote line {id, at}', (L) => {
  const live = staged(LM, [P()]);
  const d = clone(LM); d.structure.categories.push({ id: 'postres', name: 'Postres' }); item(d, 'dimsum_01').display.cat = 'postres';
  const s = ON(() => diffOf(live, d)).sections;
  assert.ok(s.staged.some((x) => x.change === 'promote' && x.id === 'postres' && x.at === d.structure.categories.length - 1), `${L}: ${JSON.stringify(s.staged)}`);
});

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
