'use strict';
// S2-6 (D4c-grill/item-s1/S2-DESIGN.md §1.3 + §2 r1 D; advisor rulings G3 + Codex r2 #1) — the review's EXTRAS consequences, from
// the ONE shared evaluator (catalog/extras-eligibility.js): one entry per plain product or GROUP, on the LAUNCHER only; the entry
// is the UNION of every member's own deltas (launcher and each option, each with its own overrides); a record «accepts group X»
// iff it may take at least one extra of category X. Deterministic: entries by key, lists sorted; nothing ⇒ [].
// Run: node catalog/extras-consequences.test.js
const assert = require('assert');
const { extrasConsequences } = require('./extras-consequences');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// a tiny built catalog: two extra groups; section `a` allows both, `b` allows only Salsas, `c` allows none
const extras = [{ key: 'Roja', display: { id: 'e1', cat: 'Salsas' } }, { key: 'Mozza', display: { id: 'e2', cat: 'Quesos' } }];
const cat = (allow) => ({ extra_categories: ['Salsas', 'Quesos'], exposure: { category_allow: { a: ['Salsas', 'Quesos'], b: ['Salsas'], c: [] }, item_overrides: allow || {} } });
const item = (key, id, c, extra = {}) => ({ key, display: { id, cat: c, ...extra } });
const cons = (liveItems, draftItems, overrides) => extrasConsequences({ live: { items: liveItems, extras, structure: cat(overrides) }, draft: { items: draftItems, extras, structure: cat(overrides) } });

// ── a plain product moved: what it stops and starts accepting ──
{
  assert.deepStrictEqual(cons([item('P', 1, 'a')], [item('P', 1, 'b')]), [{ key: 'P', kind: 'extras', gained: [], lost: ['Quesos'] }], 'XC-MOVE a → b loses Quesos');
  assert.deepStrictEqual(cons([item('P', 1, 'b')], [item('P', 1, 'a')]), [{ key: 'P', kind: 'extras', gained: ['Quesos'], lost: [] }], 'XC-MOVE b → a gains Quesos');
  assert.deepStrictEqual(cons([item('P', 1, 'a')], [item('P', 1, 'a')]), [], 'XC-NONE nothing changed → []');
  ok('a plain product: gained / lost groups; nothing changed → no entry');
}
// ── a product that accepted none of a group never «loses» it ──
{
  const ov = { P: { deny: ['*'] } };
  assert.deepStrictEqual(cons([item('P', 1, 'a')], [item('P', 1, 'c')], ov), [], 'XC-DENIED-ALL a denied-all product moved away produces no line');
  ok('a product that accepted nothing reports nothing (Codex r1 P1-2 counterexample)');
}
// ── a group: ONE entry on the launcher, the UNION of its members' own deltas ──
{
  const L = (c) => item('L', 10, c); const O1 = (c) => item('O1', 11, c, { variantOf: 10, choice: 'Uno' }); const O2 = (c) => item('O2', 12, c, { variantOf: 10, choice: 'Dos' });
  // Codex's probe: the launcher denies '*' (accepts nothing before or after); option O1 carries its own legacy add → it loses Salsas
  const probe = cons([L('a'), O1('a')], [L('c'), O1('c')], { L: { deny: ['*'] }, O1: { add: ['Quesos'] } });
  assert.deepStrictEqual(probe, [{ key: 'L', kind: 'extras', gained: [], lost: ['Salsas'] }], 'XC-PROBE the option\'s own loss is reported on the launcher\'s entry');
  // one member keeps X while another loses X → lost: ['X'] (the union of member deltas, never the delta of the aggregate)
  const keepLose = cons([L('a'), O1('a'), O2('a')], [L('b'), O1('b'), O2('b')], { O2: { add: ['Quesos'] } });
  assert.deepStrictEqual(keepLose, [{ key: 'L', kind: 'extras', gained: [], lost: ['Quesos'] }], 'XC-UNION O2 keeps Quesos while L and O1 lose it → lost [Quesos]');
  assert.ok(keepLose.every((e) => e.key === 'L'), 'XC-LAUNCHER-ONLY no option row ever carries an entry');
  ok('a group: one entry on the launcher = the union of every member\'s own deltas (the Codex probe; keep-X / lose-X)');
}
// ── deterministic ──
{
  const r = cons([item('Z', 2, 'a'), item('M', 1, 'b')], [item('Z', 2, 'b'), item('M', 1, 'a')]);
  assert.deepStrictEqual(r.map((e) => e.key), ['M', 'Z'], 'XC-ORDER entries by key');
  const both = extrasConsequences({ live: { items: [item('P', 1, 'c')], extras, structure: cat() }, draft: { items: [item('P', 1, 'a')], extras, structure: cat() } });
  assert.deepStrictEqual(both[0].gained, ['Quesos', 'Salsas'], 'XC-ORDER lists sorted');
  assert.deepStrictEqual(cons([], [item('New', 9, 'a')]), [], 'XC-ADDITION a new product has no live acceptance to compare → no entry');
  ok('deterministic: entries by key, lists sorted; additions report nothing');
}
console.log(`\nextras-consequences: OK (${n})`);
