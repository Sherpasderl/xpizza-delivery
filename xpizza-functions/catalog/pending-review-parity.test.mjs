// S3 r1 PS-REVIEW-PARITY (PLAN-5f-inicio-s3-pending-rebase-r0, owner 11-23): the has_pending S3 STORES on the real save === «Revisar y
// publicar» does NOT draw its empty state, judged by the RENDERED screen (jsdom over the portal's real renderReview, the context exactly as
// app.js builds it). Every diff is the REAL one: the portal's own editor ops, sent through this tree's save core by the portal's
// real-backend.mjs (read only — 5f edits no portal file); the stored answer is read back with S3's own fresh-only reader.
// portal-ui's review-lines.test.mjs pins the model's answer over the choice (CHOICE_EDIT) and section (S4) facets; this file pins that S3
// stores exactly that answer, on this tree, over the de-dup and net-zero facets. Run: node --test catalog/pending-review-parity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const PORTAL = new URL('../../xpizza-portal/', import.meta.url);
const { makeBackend, installSwitches } = await import(new URL('real-backend.mjs', PORTAL));
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const base = createRequire(new URL('../package.json', import.meta.url));
// this tree's functions, with the ONE Firestore fake the backend makes captured (S3's record lands there)
const made = [];
const freq = Object.assign((id) => {
  if (id === './catalog/firestore-fake') { const real = base(id); return { ...real, makeDb: (...a) => { const d = real.makeDb(...a); made.push(d); return d; } }; }
  return base(id);
}, { cache: base.cache, resolve: base.resolve });
const SW = { extrasCatalog: true, choiceEdit: false };
installSwitches(freq, () => ({ sections: true, extrasCatalog: SW.extrasCatalog, choiceEdit: SW.choiceEdit }));
for (const f of ['extras-eligibility.js', 'exposure-transitions.js', 'choice-transitions.js', 'section-transitions.js']) runInThisContext(readFileSync(new URL(f, PORTAL), 'utf8'));
const E = await import(new URL('editor.js', PORTAL));
const { editCatalog } = await import(new URL('api.js', PORTAL));
const { reviewModel, renderReview, reviewCtxFromSource } = await import(new URL('review.js', PORTAL));
const { JSDOM } = base('jsdom');
const PS = base('./catalog/pending-summary');
const clone = (v) => JSON.parse(JSON.stringify(v));

// app.js's context (productReviewCtx → reviewCtxFromSource) over the saved draft and the loaded menu — as portal-ui's test builds it
const ctxOpts = (adopted, loaded) => {
  const cats = [...(adopted.structure.categories || []), ...(adopted.structure.staged_categories || []), ...(loaded.structure.categories || []), ...(loaded.structure.staged_categories || [])];
  return { productRemoval: false, categoryName: (id) => { const c = cats.find((x) => x && String(x.id) === String(id)); return c && c.name ? c.name : String(id); }, removedRowFor: (k) => loaded.items.find((x) => x.key === k) || null };
};
const EMPTY = 'No hay cambios sin publicar.';
const drawsEmpty = (m) => {
  const w = new JSDOM('<!doctype html><div id="r"></div>').window; const prev = globalThis.document; globalThis.document = w.document;
  try { const r = w.document.getElementById('r'); renderReview(r, m); const e = r.querySelector('.empty'); return !!(e && e.textContent === EMPTY); } finally { globalThis.document = prev; }
};
async function world() { made.length = 0; const B = await makeBackend(freq, 'la_musa'); assert.equal(made.length >= 1, true, 'premise: the backend\'s Firestore is captured'); return { B, fs: made[0] }; }
async function save(d, B, baseTime) {
  globalThis.fetch = B.fetch;
  return editCatalog({ rid: 'la_musa', source: E.draftSource(d), baseSourceUpdateTime: baseTime || B.read.sourceUpdateTime, token: async () => 't', loadedBase: B.read.deletionBase });
}
// THE contract: what S3 stored for this save === the screen draws lines (and the premise says which one it is)
async function assertParity(W, res, what, wantLines) {
  const empty = drawsEmpty(reviewModel(res.diff, reviewCtxFromSource(res.source, ctxOpts(res.source, W.B.read.source))));
  assert.equal(empty, !wantLines, `premise (${what}): the screen ${wantLines ? 'draws lines' : 'draws its empty state'}`);
  assert.equal(await PS.readHasPending(W.fs, 'la_musa', { warn() {} }), !empty, `🔴 PS-REVIEW-PARITY (${what}): S3's stored has_pending === the review does NOT draw «${EMPTY}»`);
}

test('PS-REVIEW-PARITY — EXTRAS_CATALOG on: an extra added, one removed, one repriced (the de-dup duplicates a raw sum over-counts)', async () => {
  const W = await world(); const d = E.createDraft(clone(W.B.read.source)); const src = E.draftSource(d);
  const gone = src.extras.find((x) => x.display && x.display.cat === 'Acompañamientos');
  const other = src.extras.find((x) => x.display && x.display.cat !== 'Acompañamientos' && x.display.cat !== 'Salsas' && Number.isInteger(x.price));
  assert.ok(gone && other, 'premise: two extras in two groups');
  assert.equal(E.applyExposureOps(d, [{ op: 'extra.remove', key: gone.key }, { op: 'extra.add', group: 'Salsas', ref: 'tmp:ps-new-0001', name: 'Salsa de mango', price: 25 }], { extrasCatalog: true }).ok, true);
  E.setExtraPrice(d, other.key, String(other.price + 5));
  const res = await save(d, W.B);
  assert.deepEqual((res.diff.extras || []).map((r) => r.change).sort(), ['added', 'removed', 'repriced'], 'premise: the S2 extras lines');
  assert.ok(res.diff.added.some((r) => r.surface === 'extra') && res.diff.removed.some((r) => r.surface === 'extra'), 'premise: the generic arrays carry them too');
  await assertParity(W, res, 'extras add / remove / reprice', true);
});
test('PS-REVIEW-PARITY — a dish price', async () => {
  const W = await world(); const d = E.createDraft(clone(W.B.read.source));
  const s = clone(E.draftSource(d)); const it = s.items.find((r) => r.display && r.display.variantOf == null && Number.isInteger(r.price)); it.price += 10; it.display.price = it.price;
  const res = await save(E.createDraft(s), W.B);
  await assertParity(W, res, 'a dish price', true);
});
test('PS-REVIEW-PARITY — nothing to publish: an untouched draft, and an edit undone by the next save ⇒ false, exactly where the screen is empty', async () => {
  const W = await world();
  const res0 = await save(E.createDraft(clone(W.B.read.source)), W.B);
  await assertParity(W, res0, 'untouched', false);
  const s = clone(W.B.read.source); const it = s.items.find((r) => r.display && r.display.variantOf == null && Number.isInteger(r.price)); it.price += 10; it.display.price = it.price;
  const res1 = await save(E.createDraft(s), W.B, res0.updateTime);
  await assertParity(W, res1, 'a price changed', true);
  it.price -= 10; it.display.price = it.price;
  const res2 = await save(E.createDraft(s), W.B, res1.updateTime);
  await assertParity(W, res2, 'the price restored (net zero)', false);
});
