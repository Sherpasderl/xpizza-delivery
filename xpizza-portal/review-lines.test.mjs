// THE REVIEW LINE MODEL's contract (PLAN-portal-review-lines-r0; OWNER 11-23 after Codex #296: Inicio shows NO number — «Tenés cambios
// sin publicar» + «Revisar y publicar», else «Todo en orden»). 5f's S3 stores has_pending = hasPending(diff, reviewCtxFromSource(source, …)),
// so it MUST be true exactly when «Revisar y publicar» does NOT draw its empty state («No hay cambios sin publicar.»). The oracle is the
// RENDERED screen (jsdom over the real renderReview), never the model's own numbers. Every diff here is the REAL one: the portal's own
// editor ops, saved through 5f's save core at the pinned S4_REF (real-backend.mjs, the structure-s4-review approach), with EXTRAS_CATALOG /
// CHOICE_EDIT / sections set through the server's own capability switch — plus an untouched draft and an edit undone before the save.
// The server's byte copy (xpizza-functions/catalog/review-lines.js) is asked the same question and must give the same answer.
// Run: node --test review-lines.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { makeBackend, installSwitches, s4Snapshot } from './real-backend.mjs';

process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const S4_REF = 'f58655d67';
const freq = s4Snapshot(S4_REF);
const SW = { extrasCatalog: false, choiceEdit: false };
installSwitches(freq, () => ({ sections: true, extrasCatalog: SW.extrasCatalog, choiceEdit: SW.choiceEdit }));
for (const f of ['extras-eligibility.js', 'exposure-transitions.js', 'choice-transitions.js', 'section-transitions.js']) runInThisContext(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
const E = await import('./editor.js');
const { editCatalog } = await import('./api.js');
const { reviewModel, renderReview, reviewCtxFromSource } = await import('./review.js');
const req = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
const SERVER = req('./catalog/review-lines.js');   // the byte copy the server requires (catalog/review-lines-sync.guard)
const { JSDOM } = req('jsdom');
const clone = (v) => JSON.parse(JSON.stringify(v));
const SECTIONS = { sections: true };

// the context exactly as app.js builds it (productReviewCtx → reviewCtxFromSource), over the saved draft and the loaded menu
function ctxOpts(adopted, loaded) {
  const cats = [...(adopted.structure.categories || []), ...(adopted.structure.staged_categories || []), ...(loaded.structure.categories || []), ...(loaded.structure.staged_categories || [])];
  return { productRemoval: false,
    categoryName: (id) => { const c = cats.find((x) => x && String(x.id) === String(id)); return c && c.name ? c.name : String(id); },
    removedRowFor: (k) => loaded.items.find((x) => x.key === k) || null };
}
async function saved(d, B) {
  globalThis.fetch = B.fetch;
  return editCatalog({ rid: 'la_musa', source: E.draftSource(d), baseSourceUpdateTime: B.read.sourceUpdateTime, token: async () => 't', loadedBase: B.read.deletionBase });
}
// what the screen DRAWS: the empty state's sentence, else the groups (each with at least one line under it)
const EMPTY = 'No hay cambios sin publicar.';
function drawn(m) {
  const w = new JSDOM('<!doctype html><div id="r"></div>').window;
  const prev = globalThis.document; globalThis.document = w.document;
  try {
    const r = w.document.getElementById('r');
    renderReview(r, m);
    const empty = r.querySelector('.empty');
    return { empty: !!(empty && empty.textContent === EMPTY), text: r.textContent,
      groups: [...r.querySelectorAll('.mgroup')].map((g) => ({ label: g.querySelector('.mglabel span:not(.mgn)').textContent, lines: g.querySelectorAll('.prow, .brow').length })) };
  } finally { globalThis.document = prev; }
}
// THE contract: has_pending (client AND the server's copy) === the screen does NOT draw its empty state; never a pending flag over the
// empty sentence, never «Todo en orden» over drawn lines
function assertContract(diff, res, B, what, want) {
  const opts = ctxOpts(res.source, B.read.source);
  const m = reviewModel(diff, reviewCtxFromSource(res.source, opts));
  const d = drawn(m);
  assert.equal(d.empty, !want, `premise (${what}): the screen ${want ? 'draws lines' : 'draws its empty state'} (${JSON.stringify(d.groups)})`);
  if (want) assert.ok(d.groups.length > 0 && d.groups.every((g) => g.lines > 0) && !d.text.includes(EMPTY), `${what}: every drawn group has its lines, never beside the empty sentence`);
  else assert.deepEqual(d.groups, [], `${what}: the empty state alone`);
  const RL = globalThis.ReviewLines;
  assert.equal(RL.hasPending(diff, reviewCtxFromSource(res.source, opts)), !d.empty, `🔴 ${what}: has_pending === the review does NOT draw «${EMPTY}»`);
  assert.equal(SERVER.hasPending(diff, SERVER.reviewCtxFromSource(res.source, opts)), !d.empty, `🔴 ${what}: the server's copy answers the same`);
  return { m, d };
}

test('EXTRAS_CATALOG on — an extra added, one removed and one repriced on the Extras page: ONE «Estructura» row each, never also «Se agregan» / «Se eliminan» / «Precios»; pending === lines drawn', async () => {
  SW.extrasCatalog = true;
  try {
    const B = await makeBackend(freq, 'la_musa');
    const d = E.createDraft(clone(B.read.source));
    const src = E.draftSource(d);
    const gone = src.extras.find((x) => x.display && x.display.cat === 'Acompañamientos');
    const other = src.extras.find((x) => x.display && x.display.cat !== 'Acompañamientos' && x.display.cat !== 'Salsas' && Number.isInteger(x.price));
    assert.ok(gone && other, 'premise: two extras in two groups');
    assert.equal(E.applyExposureOps(d, [{ op: 'extra.remove', key: gone.key }, { op: 'extra.add', group: 'Salsas', ref: 'tmp:rl-new-0001', name: 'Salsa de mango', price: 25 }], { extrasCatalog: true }).ok, true);
    E.setExtraPrice(d, other.key, String(other.price + 5));
    const res = await saved(d, B);
    const x = res.diff.extras || [];
    assert.deepEqual(x.map((r) => r.change).sort(), ['added', 'removed', 'repriced'], 'premise: the server sent its S2 extras lines');
    assert.ok(res.diff.added.some((r) => r.surface === 'extra') && res.diff.removed.some((r) => r.surface === 'extra'), 'premise: the generic arrays carry them too (the over-count a raw sum makes)');
    assert.ok(res.diff.changed.some((c) => c.surface === 'extra' && c.field === 'price'), 'premise: and the price line');
    // each server fact once (the de-duplication S3 relies on) — then the drawn-count contract over the same model
    const m = reviewModel(res.diff, reviewCtxFromSource(res.source, ctxOpts(res.source, B.read.source)));
    assert.equal(m.added.filter((r) => r.surface === 'extra').length + m.removed.filter((r) => r.surface === 'extra').length, 0, '🔴 an Extras-page add / remove is not also «Se agregan» / «Se eliminan»');
    assert.equal(m.rows.filter((r) => r.surface === 'extra' && r.isPrice).length, 0, '🔴 a repriced extra is not also a «Precios» row');
    assert.equal(m.structure.filter((r) => r.src && x.includes(r.src)).length, 3, 'one «Estructura» row per extras line');
    assertContract(res.diff, res, B, 'extras on', true);
  } finally { SW.extrasCatalog = false; }
});

test('CHOICE_EDIT off — the choice ops are refused and the diff has no choices; an option price: pending === lines drawn', async () => {
  const B = await makeBackend(freq, 'la_musa');
  const d = E.createDraft(clone(B.read.source));
  assert.equal(E.applyChoiceOps(d, [{ op: 'choice.label', launcher: 'noodle_01', label: 'Elegí la proteína' }], { choiceEdit: false }).code, 'choice_edit_off');
  const src = E.draftSource(d);
  const opt = src.items.find((i) => String(i.display.variantOf) === String(src.items.find((l) => l.key === 'noodle_01').display.id));
  E.setItemPrice(d, opt.key, String(opt.price + 10));
  const res = await saved(d, B);
  assert.ok(!res.diff.choices || res.diff.choices.length === 0, 'premise: no choice rows with the switch off');
  assertContract(res.diff, res, B, 'choice edit off', true);
});

test('CHOICE_EDIT on — a choice\'s label and its «Recomendada» change: the server\'s choice rows are «Estructura» rows; pending === lines drawn', async () => {
  SW.choiceEdit = true;
  try {
    const B = await makeBackend(freq, 'la_musa');
    const d = E.createDraft(clone(B.read.source));
    const src = E.draftSource(d);
    const L = src.items.find((l) => l.key === 'noodle_01');
    const opts = src.items.filter((i) => String(i.display.variantOf) === String(L.display.id)).map((i) => i.key);
    assert.equal(E.applyChoiceOps(d, [{ op: 'choice.label', launcher: 'noodle_01', label: 'Elegí la proteína' }, { op: 'choice.recommended', launcher: 'noodle_01', option: opts[1] }], { choiceEdit: true }).ok, true);
    const res = await saved(d, B);
    assert.ok(Array.isArray(res.diff.choices) && res.diff.choices.length > 0, 'premise: the server sent its choice rows');
    const { m } = assertContract(res.diff, res, B, 'choice edit on', true);
    assert.ok(m.structure.length >= 1, 'the choice rows are «Estructura» rows');
  } finally { SW.choiceEdit = false; }
});

test('S4 sections — a new section with its dish, a subsection added and one renamed, the order: ONE row each; pending === lines drawn', async () => {
  const B = await makeBackend(freq, 'la_musa');
  const d = E.createDraft(clone(B.read.source));
  assert.equal(E.addCategory(d, 'Postres', {}, SECTIONS).ok, true);
  const pid = E.draftSource(d).structure.staged_categories[0].id;
  assert.equal(E.moveItem(d, 'dimsum_01', { cat: pid }, SECTIONS).ok, true);
  const dims = E.draftSource(d).items.filter((i) => i.display.cat === 'dim_sum' && i.display.variantOf == null).map((i) => i.key);
  assert.equal(E.addSubcat(d, 'dim_sum', 'Al vapor', dims, SECTIONS).ok, true);
  assert.equal(E.renameSubcat(d, 'bebidas', 'Sodas', 'Refrescos', SECTIONS).ok, true);
  const ids = E.draftSource(d).structure.categories.map((c) => c.id); [ids[0], ids[1]] = [ids[1], ids[0]];
  assert.equal(E.reorderSections(d, ids, SECTIONS).ok, true);
  const res = await saved(d, B);
  assert.ok(res.diff.sections, 'premise: the server sent its S4 lines');
  const { m } = assertContract(res.diff, res, B, 'S4 sections', true);
  assert.ok(m.structure.length >= 4, 'the section rows are «Estructura» rows');
});

test('nothing to publish — an untouched draft and an edit undone before the save: has_pending is false, exactly where the screen says «No hay cambios sin publicar.»', async () => {
  for (const undo of [false, true]) {
    const B = await makeBackend(freq, 'la_musa');
    const d = E.createDraft(clone(B.read.source));
    if (undo) {
      const it = E.draftSource(d).items.find((i) => Number.isInteger(i.price) && i.price > 0);
      const { key, price } = it;   // the values, not the live draft row
      E.setItemPrice(d, key, String(price + 15));
      assert.equal(E.draftSource(d).items.find((i) => i.key === key).price, price + 15, 'premise: the edit took');
      E.setItemPrice(d, key, String(price));
    }
    const res = await saved(d, B);
    assertContract(res.diff, res, B, undo ? 'an edit undone' : 'untouched', false);
  }
});
