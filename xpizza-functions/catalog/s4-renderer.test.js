'use strict';
// S4 (PLAN-structure-S4-r4 §1.6, S0-3, Q4/Q9) — categoriesGeneric: does a shipped form draw ANY served category (a generic CATEGORIES walk
// in renderMenu, CATEGORIES booted from the served bundle AND live-applied, no `p.cat === '<literal>'` filter) — derived by
// tools/generate-renderer-contract.js from the forms, never hand-written. It drives ONLY the review's «Solo en la app Sherpa» labels
// (app_only), never authorization (R3.1). Run: node catalog/s4-renderer.test.js
const assert = require('assert');
const STRUCT = { sections: true };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: false, sections: STRUCT.sections }) } }; }
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

if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`OK(${n})`);
