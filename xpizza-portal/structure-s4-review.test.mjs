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
export const S4_REF = '3f8017d02';   // 5f 11-13 tip: subcat renames by MEMBERS (290fa5baa) + choicesGeneric → row.app_only (437ce1ef4) + label_too_long (66b2b0239)
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const freq = s4Snapshot(S4_REF);
const SW = { choiceEdit: false, choicesGeneric: null };
installSwitches(freq, () => ({ sections: true, choiceEdit: SW.choiceEdit }));
// the GENERATED renderer contract, as it reads once a form stops rendering choices generically (choicesGeneric false — the state the old
// forms were in before the shared picker shipped): the server DERIVES app_only from it (review-diff withChoiceAppOnly); null = as shipped
{ const p = freq.resolve('./catalog/renderer-contract.generated'); const real = freq('./catalog/renderer-contract.generated');
  const ex = { ...real }; Object.defineProperty(ex, 'la_musa', { enumerable: true, get: () => (SW.choicesGeneric === null ? real.la_musa : { ...real.la_musa, choicesGeneric: SW.choicesGeneric }) });
  freq.cache[p] = { id: p, filename: p, loaded: true, exports: ex }; }
for (const f of ['extras-eligibility.js', 'exposure-transitions.js', 'choice-transitions.js', 'section-transitions.js']) runInThisContext(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
const E = await import('./editor.js');
const { editCatalog } = await import('./api.js');
const { reviewModel, renderReview } = await import('./review.js');
const ON = { sections: true };
const { s4Copy } = await import('./render.js'); const { s3Copy } = await import('./item-edit-logic.js');
const P = (k, v) => s4Copy(k, v);   // the shipped string (⟦s4.key⟧ while a key is still null)
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
    ['Dim Sum', P('rowSubcat'), 'Nuevo', P('subAddedRow', { sub: 'Al vapor', nprod: '4 productos' }), false],
    ['Bebidas', P('rowSubcat'), 'Cambio', 'Sodas → Refrescos', false],
    ['Starters', 'Categoría', 'Orden', 'pasa al 1.º lugar', false],
    ['Salsas', 'Categoría', 'Nuevo', 'categoría vacía · se muestra cuando tenga productos', false],
    ['Postres', P('rowCatNew'), 'Nuevo', P('promoteRow', { nprod: '1 producto', anterior: 'Bebidas' }), false],
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
    ['Postres', P('rowCatNew'), 'Nuevo', P('promoteRow', { nprod: '1 producto', anterior: 'Bebidas' }), false],
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
    ['Cervezas', P('rowCatSubcat', { categoria: 'Bebidas' }), 'Orden', 'pasa al 1.º lugar', false],
  ], '🔴 the reorder survives a same-save rename');
});

// S3 × Q-B (5f 437ce1ef4): «Solo en la app Sherpa» on a choice facet follows the diff's OWN row.app_only — a dish gaining its choice and a
// new option carry it; a label, a removed option and a «Recomendada» row never do (no portal rule)
// which S3 copy a facet row carries, read from the SHIPPED strings (s3Copy): the gained choice (revLauncher), a first / changed mark
// (revRecNew / revRecChanged); otherwise a renamed label (was → now) or an option row
const s3Key = (t) => (/^elección .* · \d+ opciones · desde L /.test(t) ? 'revLauncher' : t.startsWith('Recomendada · ') ? (t.includes(' → ') ? 'revRecChanged' : 'revRecNew') : null);
const choiceFacets = (m) => m.structure.filter((r) => r.src && typeof r.src.launcher === 'string').map((r) => { const t = r.parts.join(' '); return [r.kind, s3Key(t) || (r.kind === 'Cambio' && r.parts.includes('→') ? 'label' : 'option'), !!r.appOnly]; });
async function choiceSave(generic) {
  SW.choiceEdit = true; SW.choicesGeneric = generic;
  try {
    const B = await makeBackend(freq, 'la_musa');
    const d = E.createDraft(clone(B.read.source));
    const src = E.draftSource(d);
    const l = src.items.find((i) => i.key === 'noodle_01');
    const members = src.structure.variant_items[String(l.display.id)].variantIds.map((id) => src.items.find((i) => String(i.display.id) === String(id) || i.ref === id).key);
    const BEER = src.items.find((i) => /^beer_/.test(i.key) && i.display.variantOf == null).key;
    const r = E.applyChoiceOps(d, [
      { op: 'choice.label', launcher: 'noodle_01', label: 'Proteína a elegir' },
      { op: 'option.add', launcher: 'noodle_01', ref: 'tmp:nnnnnnnn', choice: 'Tofu', price: 330 },
      { op: 'option.remove', key: members[2] },
      { op: 'choice.recommended', launcher: 'noodle_01', option: members[1] },
      { op: 'choice.add', key: BEER, label: 'Tamaño', options: [{ ref: 'tmp:aaaaaaaa', choice: 'Botella' }, { ref: 'tmp:bbbbbbbb', choice: 'Cubeta', price: 480 }] },
    ], { choiceEdit: true });
    assert.equal(r.ok, true, `premise: the ops apply ${JSON.stringify(r)}`);
    globalThis.fetch = B.fetch;
    const res = await editCatalog({ rid: 'la_musa', source: E.draftSource(d), baseSourceUpdateTime: B.read.sourceUpdateTime, token: async () => 't', loadedBase: B.read.deletionBase });
    return { res, m: reviewModel(res.diff, ctxOf(res.source, B.read.source)) };
  } finally { SW.choiceEdit = false; SW.choicesGeneric = null; }
}
test('S3 × Q-B (REAL diff, 5f 437ce1ef4) — a form that cannot render choices: «Solo en la app Sherpa» on the new choice and the new option ONLY', async () => {
  const { res, m } = await choiceSave(false);
  assert.deepEqual(res.diff.choices.map((c) => [!!c.became, c.app_only === undefined ? 'absent' : c.app_only]), [[true, true], [false, true]], 'premise: the server marks the gained choice and the row with a new option');
  assert.deepEqual(choiceFacets(m), [
    ['Nuevo', 'revLauncher', true],
    ['Cambio', 'label', false],
    ['Nuevo', 'option', true],
    ['Quitado', 'option', false],
    ['Nuevo', 'revRecNew', false],
  ], '🔴 the app-only mark follows row.app_only: the gained choice and the NEW option; never the label, the removal or the mark');
});
test('S3 × Q-B (REAL diff, as shipped: both forms render choices generically) — no «Solo en la app Sherpa» on any choice facet', async () => {
  const { res, m } = await choiceSave(null);
  assert.ok(res.diff.choices.every((c) => c.app_only !== true), 'premise: as shipped, the server marks nothing');
  assert.ok(choiceFacets(m).length === 5 && choiceFacets(m).every((f) => f[2] === false), '🔴 as shipped: no app-only mark on a choice facet');
});
// S3 × Q-A (5f 66b2b0239): a group label over 40 is the server's label_too_long — its line lands on the choice's card
test('S3 × Q-A (REAL refusal) — a 41-character group label: the server refuses label_too_long; the drawer line is the card\'s labelTooLong (owner 11-19)', async () => {
  SW.choiceEdit = true;
  try {
    const IE = await import('./item-edit-logic.js');
    const B = await makeBackend(freq, 'la_musa');
    const d = E.createDraft(clone(B.read.source));
    assert.equal(E.applyChoiceOps(d, [{ op: 'choice.label', launcher: 'noodle_01', label: 'P'.repeat(41) }], { choiceEdit: true }).ok, true, 'premise: the shared transitions take it (the cap is the server compare)');
    globalThis.fetch = B.fetch;
    let err = null;
    try { await editCatalog({ rid: 'la_musa', source: E.draftSource(d), baseSourceUpdateTime: B.read.sourceUpdateTime, token: async () => 't', loadedBase: B.read.deletionBase }); } catch (e) { err = e; }
    assert.ok(err && err.body && err.body.error === 'label_too_long', `premise: the REAL server refuses ${err && JSON.stringify(err.body)}`);
    const line = IE.refusalLine(err.body);
    assert.deepEqual(line && [line.code, line.field, line.message], ['label_too_long', 'options', s3Copy('labelTooLong')], '🔴 label_too_long lands on the choice card');
  } finally { SW.choiceEdit = false; }
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
    ['Especiales', P('rowCatSubcat', { categoria: 'Pizzas' }), 'Orden', 'pasa al 1.º lugar', true],
    ['Combos', P('rowCatEmpty'), 'Quitado', P('neverShown'), false],
    ['Antojitos', P('rowCatEmpty'), 'Cambio', 'Antojitos → Entradas', false],
    ['Entradas', P('rowCatEmpty'), 'Orden', P('afterRow', { categoria: 'Ensaladas' }), false],
    ['Postres', P('rowCatNew'), 'Nuevo', P('promoteRow', { nprod: '1 producto', anterior: 'Ensaladas' }), true],
    ['Helados', P('rowCatNew'), 'Nuevo', P('promoteRow', { nprod: '1 producto', anterior: 'Postres' }), true],
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
