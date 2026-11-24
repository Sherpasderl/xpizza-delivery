// THE REVIEW LINE MODEL's contract (PLAN-portal-review-lines-r0, advisor 11-23): 5f's S3 `pending_count` («Tenés N cambios sin publicar»
// / «Todo en orden») stores reviewCount(diff, reviewCtxFromSource(source, …)) — so it MUST equal the sentences «Revisar y publicar» draws.
// Every diff here is the REAL one: the portal's own editor ops, saved through 5f's save core at the pinned S4_REF (real-backend.mjs, the
// structure-s4-review approach), with EXTRAS_CATALOG / CHOICE_EDIT / sections set through the server's own capability switch. The drawn
// count is read from the DOM renderReview builds (jsdom), never from the model: each group's head number, one row per counted line in
// every group but «Productos» (whose rows are the products, their head the sum of their sentences). The server's byte copy
// (xpizza-functions/catalog/review-lines.js) is asked the same question and must answer the same number.
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
// what the screen DRAWS: each group's head, the rows under it
function drawn(m) {
  const w = new JSDOM('<!doctype html><div id="r"></div>').window;
  const prev = globalThis.document; globalThis.document = w.document;
  try {
    renderReview(w.document.getElementById('r'), m);
    return [...w.document.querySelectorAll('.mgroup')].map((g) => ({ label: g.querySelector('.mglabel span:not(.mgn)').textContent, head: Number(g.querySelector('.mgn').textContent), rows: g.querySelectorAll(':scope > .prow').length }));
  } finally { globalThis.document = prev; }
}
// THE contract: the count S3 stores === the sentences the review draws — and the server's copy says the same number
function assertContract(diff, res, B, what) {
  const opts = ctxOpts(res.source, B.read.source);
  const m = reviewModel(diff, reviewCtxFromSource(res.source, opts));
  const gs = drawn(m);
  const sum = gs.reduce((n, g) => n + g.head, 0);
  assert.ok(gs.length > 0 && gs.every((g) => g.rows > 0), `🔴 ${what}: the review draws the diff's lines — never the empty state over a diff that has them (${JSON.stringify(gs)})`);
  assert.equal(m.total, sum, `🔴 ${what}: reviewCount (${m.total}) === the group heads the review draws (${JSON.stringify(gs)})`);
  for (const g of gs) {
    if (g.label === 'Productos') assert.equal(g.rows, m.products.length, `${what}: «Productos» draws one row per product`);
    else assert.equal(g.rows, g.head, `🔴 ${what}: «${g.label}» draws exactly one row per counted line`);
  }
  assert.equal(SERVER.reviewCount(diff, SERVER.reviewCtxFromSource(res.source, opts)), sum, `🔴 ${what}: the server's copy counts the same sentences`);
  return { m, gs };
}

test('EXTRAS_CATALOG on — an extra added, one removed and one repriced on the Extras page: ONE «Estructura» row each, never also «Se agregan» / «Se eliminan» / «Precios»; the count is the drawn rows', async () => {
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
    const raw = ['changed', 'added', 'removed'].reduce((n, k) => n + res.diff[k].length, 0) + x.length;
    assert.ok(raw > m.total, `a raw sum (${raw}) over-counts the review (${m.total})`);
    assertContract(res.diff, res, B, 'extras on');
  } finally { SW.extrasCatalog = false; }
});

test('CHOICE_EDIT off — the choice ops are refused and the diff has no choices; an option price + its dish\'s name: the count is the drawn rows', async () => {
  const B = await makeBackend(freq, 'la_musa');
  const d = E.createDraft(clone(B.read.source));
  assert.equal(E.applyChoiceOps(d, [{ op: 'choice.label', launcher: 'noodle_01', label: 'Elegí la proteína' }], { choiceEdit: false }).code, 'choice_edit_off');
  const src = E.draftSource(d);
  const opt = src.items.find((i) => String(i.display.variantOf) === String(src.items.find((l) => l.key === 'noodle_01').display.id));
  E.setItemPrice(d, opt.key, String(opt.price + 10));
  const res = await saved(d, B);
  assert.ok(!res.diff.choices || res.diff.choices.length === 0, 'premise: no choice rows with the switch off');
  assertContract(res.diff, res, B, 'choice edit off');
});

test('CHOICE_EDIT on — a choice\'s label and its «Recomendada» change: the server\'s choice rows are «Estructura» rows; the count is the drawn rows', async () => {
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
    const { m } = assertContract(res.diff, res, B, 'choice edit on');
    assert.ok(m.structure.length >= 1, 'the choice rows are «Estructura» rows');
  } finally { SW.choiceEdit = false; }
});

test('S4 sections — a new section with its dish, a subsection added and one renamed, the order: ONE row each; the count is the drawn rows', async () => {
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
  const { m } = assertContract(res.diff, res, B, 'S4 sections');
  assert.ok(m.structure.length >= 4, 'the section rows are «Estructura» rows');
});
