// STRUCTURE S4-E — the review's «Estructura» rows for the server's S4 lines (MOCKUP-portal-structure-S4-addendum S4-E; copy PENDING the
// owner: every proposed string is a ⟦s4.key⟧ placeholder). The diff is the REAL one: 5f's save core at the pinned S4_REF (approach (A),
// advisor 11-13 — a `git archive` snapshot in a temp dir, nothing written in any worktree), fed by THIS portal's S4 writer. The staged
// lines that need a PUBLISHED staged entry (drop / rename / move / promote) are pinned at the documented shape (review-diff.js:45-48)
// until the harness can publish a stored draft. Run: node --test --test-force-exit structure-s4-review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { makeBackend, installSwitches, s4Snapshot } from './real-backend.mjs';

// 5f's S4 server (feat/structure-s4-5f): switch to the repo copy once both ride one train (the MC_REF pattern)
export const S4_REF = '290fa5baa';   // 5f 11-13: subsection renames paired by MEMBERS (section-compare.subcatRenames)
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const freq = s4Snapshot(S4_REF);
installSwitches(freq, () => ({ sections: true }));
for (const f of ['extras-eligibility.js', 'exposure-transitions.js', 'choice-transitions.js', 'section-transitions.js']) runInThisContext(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
const E = await import('./editor.js');
const { editCatalog } = await import('./api.js');
const { reviewModel, renderReview } = await import('./review.js');
const ON = { sections: true };
const P = (k) => `⟦s4.${k}⟧`;
const clone = (v) => JSON.parse(JSON.stringify(v));

// the review's names, as app.js productReviewCtx gives them: the draft's (the adopted source), a loaded row for what left
function ctxOf(adopted, loaded) {
  const cats = [...(adopted.structure.categories || []), ...(adopted.structure.staged_categories || []), ...(loaded.structure.categories || []), ...(loaded.structure.staged_categories || [])];
  const rowOf = (k) => adopted.items.find((x) => x.key === k) || loaded.items.find((x) => x.key === k);
  const categoryName = (id) => { const c = cats.find((x) => x && String(x.id) === String(id)); return c && c.name ? c.name : String(id); };
  return { structure: { nameOf: (k) => (rowOf(k) || { display: { name: k } }).display.name, categoryName,
    sectionOf: (k) => { const r = rowOf(k); return r ? { cat: r.display.cat, subcat: r.display.subcat || null } : { cat: null, subcat: null }; },
    dishesIn: (id, sub = null) => adopted.items.filter((i) => i.display && String(i.display.cat) === String(id) && i.display.variantOf == null && (sub == null || i.display.subcat === sub)).length } };
}
const rowsOf = (m) => m.structure.map((r) => [r.name, r.sub, r.kind, r.parts.join(' '), !!r.appOnly]);

test('the snapshot is 5f\'s pinned server, and its section rules are the portal\'s byte copy', () => {
  assert.ok(readFileSync(new URL('./section-transitions.js', import.meta.url)).equals(readFileSync(freq.resolve('./catalog/section-transitions'))));
});

test('S4-E (REAL diff) — a new section with its dish, the order, a subsection added and one renamed, a new empty section: ONE row each; the per-dish subsection lines and the dish move are those rows', async () => {
  const B = await makeBackend(freq, 'la_musa');
  const d = E.createDraft(clone(B.read.source));
  assert.equal(E.addCategory(d, 'Postres', {}, ON).ok, true);
  const pid = E.draftSource(d).structure.staged_categories[0].id;
  assert.equal(E.moveItem(d, 'dimsum_01', { cat: pid }, ON).ok, true);
  assert.equal(E.addCategory(d, 'Salsas', {}, ON).ok, true);
  const dims = E.draftSource(d).items.filter((i) => i.display.cat === 'dim_sum' && i.display.variantOf == null).map((i) => i.key);
  assert.equal(E.addSubcat(d, 'dim_sum', 'Al vapor', dims, ON).ok, true);
  assert.equal(E.renameSubcat(d, 'bebidas', 'Sodas', 'Refrescos', ON).ok, true);
  const ids = E.draftSource(d).structure.categories.map((c) => c.id); [ids[0], ids[1]] = [ids[1], ids[0]];
  assert.equal(E.reorderSections(d, ids, ON).ok, true);
  globalThis.fetch = B.fetch;
  const res = await editCatalog({ rid: 'la_musa', source: E.draftSource(d), baseSourceUpdateTime: B.read.sourceUpdateTime, token: async () => 't', loadedBase: B.read.deletionBase });
  assert.ok(res.diff.sections, 'premise: the server sent its S4 lines');
  const m = reviewModel(res.diff, ctxOf(res.source, B.read.source));
  const wonton = B.read.source.items.find((i) => i.key === 'dimsum_01').display.name;
  assert.deepEqual(rowsOf(m), [
    ['Dim Sum', P('rowSubcat'), 'Nuevo', P('subAddedRow'), false],
    ['Bebidas', P('rowSubcat'), 'Cambio', 'Sodas → Refrescos', false],
    ['Starters', 'Categoría', 'Orden', 'pasa al 1.º lugar', false],
    ['Salsas', 'Categoría', 'Nuevo', 'categoría vacía · se muestra cuando tenga productos', false],
    ['Postres', P('rowCatNew'), 'Nuevo', P('promoteRow'), false],
    [wonton, 'Dim Sum', 'Cambio', 'Dim Sum → Postres', false],
  ], '🔴 one row per S4 line, in the mockup\'s order (la_musa renders categories generically: no app-only mark)');
  const said = (c) => (c.field === 'subcat') || (c.key === 'dimsum_01' && c.field === 'cat');
  assert.equal(m.rows.filter(said).length, 0, 'no per-dish subsection line, no dish-move line in the price rows');
  assert.equal(m.products.flatMap((p) => p.lines || []).filter((l) => l.kind === 'cat' || l.kind === 'subcat').length, 0, 'nor in «Productos»');
});

test('S4-E (REAL diff) — a PUBLISHED staged entry: dropped, renamed, and one promoted by a dish moved in (drop / rename / promote rows)', async () => {
  const B = await makeBackend(freq, 'la_musa');
  const d1 = E.createDraft(clone(B.read.source));
  for (const n of ['Combos', 'Antojitos', 'Postres']) assert.equal(E.addCategory(d1, n, {}, ON).ok, true, n);
  globalThis.fetch = B.fetch;
  const r1 = await editCatalog({ rid: 'la_musa', source: E.draftSource(d1), baseSourceUpdateTime: B.read.sourceUpdateTime, token: async () => 't', loadedBase: B.read.deletionBase });
  assert.ok(r1.updateTime, 'premise: the staged entries saved');
  const pub = await B.publish(r1.token);
  assert.equal(pub.status, 200, `premise: published (${JSON.stringify(pub.body).slice(0, 160)})`);
  const read2 = await B.reread();
  const staged = read2.source.structure.staged_categories || [];
  assert.deepEqual(staged.map((c) => c.name), ['Combos', 'Antojitos', 'Postres'], 'premise: published as staged');
  const id = (n) => staged.find((c) => c.name === n).id;
  const d2 = E.createDraft(clone(read2.source));
  assert.equal(E.dropStagedCategory(d2, id('Combos'), ON).ok, true);
  assert.equal(E.renameCategory(d2, id('Antojitos'), 'Entradas', ON).ok, true);
  assert.equal(E.moveItem(d2, 'dimsum_01', { cat: id('Postres') }, ON).ok, true);
  const r2 = await editCatalog({ rid: 'la_musa', source: E.draftSource(d2), baseSourceUpdateTime: read2.sourceUpdateTime, token: async () => 't', loadedBase: read2.deletionBase });
  const m = reviewModel(r2.diff, ctxOf(r2.source, read2.source));
  const wonton = read2.source.items.find((i) => i.key === 'dimsum_01').display.name;
  assert.deepEqual(rowsOf(m), [
    ['Combos', P('rowCatEmpty'), 'Quitado', P('neverShown'), false],
    ['Antojitos', P('rowCatEmpty'), 'Cambio', 'Antojitos → Entradas', false],
    ['Postres', P('rowCatNew'), 'Nuevo', P('promoteRow'), false],
    [wonton, 'Dim Sum', 'Cambio', 'Dim Sum → Postres', false],
  ], '🔴 the published staged lines, one row each');
});

test('S4-E (REAL diff) — a subsection renamed AND reordered in one save (5f 290fa5baa: renames paired by members): ONE rename row + the order row', async () => {
  const B = await makeBackend(freq, 'la_musa');
  const d = E.createDraft(clone(B.read.source));
  assert.equal(E.renameSubcat(d, 'bebidas', 'Sodas', 'Refrescos', ON).ok, true);
  assert.equal(E.reorderSubcats(d, 'bebidas', ['Cervezas', 'Refrescos'], ON).ok, true);
  globalThis.fetch = B.fetch;
  const res = await editCatalog({ rid: 'la_musa', source: E.draftSource(d), baseSourceUpdateTime: B.read.sourceUpdateTime, token: async () => 't', loadedBase: B.read.deletionBase });
  assert.deepEqual(res.diff.sections.subcats, [{ cat: 'bebidas', change: 'renamed', old: 'Sodas', new: 'Refrescos' }], '🔴 accepted: the rename by its members');
  const m = reviewModel(res.diff, ctxOf(res.source, B.read.source));
  assert.deepEqual(rowsOf(m), [
    ['Bebidas', P('rowSubcat'), 'Cambio', 'Sodas → Refrescos', false],
    ['Cervezas', P('rowCatSubcat'), 'Orden', 'pasa al 1.º lugar', false],
  ], '🔴 the reorder survives a same-save rename');
});

test('S4-E (documented shape) — the published staged entry: drop / rename / anchor move / two promotions from one anchor (the second names the first); app_only marks', () => {
  const sections = { added: [], subcats: [], subcat_order: [{ cat: 'pizzas', old: ['Clásicas', 'Especiales'], new: ['Especiales', 'Clásicas'] }], items: [],
    categories: { order: { old: ['a', 'b'], new: ['a', 'b', 'postres', 'helados'] }, app_only: true },
    staged: [{ change: 'drop', id: 'combos' }, { change: 'rename', id: 'antojitos', old: 'Antojitos', new: 'Entradas' },
      { change: 'move', id: 'antojitos', old_after: 'a', new_after: 'b', old_rank: 0, new_rank: 0 },
      { change: 'promote', id: 'postres', at: 2 }, { change: 'promote', id: 'helados', at: 3 }] };
  const names = { a: 'Dim Sum', b: 'Ensaladas', combos: 'Combos', antojitos: 'Entradas', postres: 'Postres', helados: 'Helados', pizzas: 'Pizzas' };
  const m = reviewModel({ added: [], removed: [], renamed: [], changed: [], sections }, { structure: { categoryName: (id) => names[id] || id, dishesIn: () => 1 } });
  assert.deepEqual(rowsOf(m), [
    ['Especiales', P('rowCatSubcat'), 'Orden', 'pasa al 1.º lugar', true],
    ['Combos', P('rowCatEmpty'), 'Quitado', P('neverShown'), false],
    ['Antojitos', P('rowCatEmpty'), 'Cambio', 'Antojitos → Entradas', false],
    ['Entradas', P('rowCatEmpty'), 'Orden', P('afterRow'), false],
    ['Postres', P('rowCatNew'), 'Nuevo', P('promoteRow'), true],
    ['Helados', P('rowCatNew'), 'Nuevo', P('promoteRow'), true],
  ]);
});

test('S4-E render — a renamed subsection draws F\'s was → now spans; an app-only row carries «Solo en la app Sherpa»', async () => {
  const freqJ = freq('jsdom');
  const w = new freqJ.JSDOM('<!doctype html><div id="r"></div>').window;
  const prev = globalThis.document; globalThis.document = w.document;
  try {
    const sections = { added: [], subcats: [{ cat: 'pizzas', change: 'renamed', old: 'Clásicas', new: 'Tradicionales' }], subcat_order: [], items: [], staged: [], categories: { order: { old: ['pizzas'], new: ['pizzas'] }, app_only: true } };
    const m = reviewModel({ added: [], removed: [], renamed: [], changed: [], sections }, { structure: { categoryName: () => 'Pizzas', dishesIn: () => 2 } });
    renderReview(w.document.getElementById('r'), m);
    const r = w.document.querySelector('.mgroup .prow.mk-srow');
    assert.deepEqual([...r.querySelectorAll('.pval > span')].map((x) => [x.className, x.textContent]),
      [['bchip chg', 'Cambio'], ['was', 'Clásicas'], ['arr', '→'], ['now', 'Tradicionales'], ['mk-apponly', 'Solo en la app Sherpa']]);
  } finally { globalThis.document = prev; }
});
