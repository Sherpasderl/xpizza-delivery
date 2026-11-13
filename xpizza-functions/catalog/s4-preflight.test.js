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

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
