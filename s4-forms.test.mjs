// S4 (PLAN-structure-S4-r4 §1.6, §5, R2.9) — the FROZEN forms, actually rendered (validateMenu checks membership, not what a form draws):
// each form boots on the published menu, live-applies the post-S4 body, and renders. Run: node s4-forms.test.mjs
//   S4-FORMS-LM: la_musa (categoriesGeneric) draws the new category as a tab + section, in the served order, holding its dish; a STAGED
//                category is in neither the body nor the DOM
//   S4-FORMS-XP: x_pizza (not generic) keeps its tabs (individual, ny); a dish moved into a new category is ABSENT from its rendered menu —
//                the «Solo en la app Sherpa» truth — while the others render; its dish order follows item_order
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, loadForm, serve, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { makeDb } = require('./catalog/firestore-fake');
const { publishVersion } = require('./catalog/catalog-publish');
const { buildSourceCandidate } = require('./catalog/candidate-validate');
const { buildPublicMenu } = require('./catalog/public-menu');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('s4-forms: FAILED — watchdog'); process.exit(1); }, 240000);
const clone = (v) => JSON.parse(JSON.stringify(v));
const KNOWN = new Set(['x_pizza', 'la_musa']);
const DIR = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };
const quiet = async (fn) => { const l = console.log, wn = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = wn; } };
async function publish(db, rid, source, expected) {
  const { inputs, built } = buildSourceCandidate(rid, source);
  return (await quiet(() => publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's4f',
    ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }, { expected: { activeVersionId: expected } }))).versionId;
}
const served = async (db, rid) => { const m = await quiet(() => buildPublicMenu(db, rid, { known: KNOWN, isActive: async () => true })); return { rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) }; };
async function rendered(rid, before, after) {
  const db = makeDb(); const v1 = await publish(db, rid, before, null); const b = await served(db, rid);
  await publish(db, rid, after, v1); const a = await served(db, rid);
  const w = loadForm(DIR[rid]); await settle(); await serve(w, b); await settle(); await serve(w, a); await settle();
  return { w, body: a.menu };
}

(async () => {
  // S4-FORMS-LM
  {
    const LM = buildSourceFromCode('la_musa');
    const after = clone(LM); after.structure.categories.splice(2, 0, { id: 'postres', name: 'Postres' });
    const moved = after.items.find((i) => i.key === 'dimsum_01'); moved.display.cat = 'postres';
    after.structure.staged_categories = [{ id: 'cafe', name: 'Café', after: 'crudo' }];
    const { w, body } = await rendered('la_musa', LM, after);
    assert.ok(!('staged_categories' in body) && !body.categories.some((c) => c.id === 'cafe'), 'S4-FORMS-LM: a staged category is never served');
    assert.deepStrictEqual(w.liveMenuGlobalGet('CATEGORIES').map((c) => c.id), after.structure.categories.map((c) => c.id), 'S4-FORMS-LM: the form applied the served section order');
    const doc = w.document;
    const tabs = [...doc.querySelectorAll('.cat-tab')].map((t) => t.getAttribute('data-cat'));
    assert.deepStrictEqual(tabs, after.structure.categories.map((c) => c.id), 'S4-FORMS-LM: one tab per served category, in order');
    const sec = doc.getElementById('cat-postres');
    assert.ok(sec && /Postres/.test(sec.textContent), 'S4-FORMS-LM: the new section is drawn with its name');
    assert.ok(sec.textContent.includes(moved.display.name), 'S4-FORMS-LM: …holding the moved dish');
    assert.ok(!doc.getElementById('cat-cafe'), 'S4-FORMS-LM: the staged category is not drawn');
    closeAll();
  }
  ok('S4-FORMS-LM: la_musa draws the new category (tab + section, served order, its dish); a staged one is neither served nor drawn');

  // S4-FORMS-XP
  {
    const XP = buildSourceFromCode('x_pizza'); XP.structure.categories.forEach((c) => { c.name = c.id === 'ny' ? 'NY' : 'Individual'; });
    const after = clone(XP); after.structure.categories.push({ id: 'postres', name: 'Postres' });
    const moved = after.items.find((i) => i.display.cat === 'individual' && i.display.variantOf == null); moved.display.cat = 'postres';
    const ind = after.items.filter((i) => i.display.cat === 'individual' && i.display.variantOf == null).map((i) => i.key);
    const o = after.structure.item_order; const i0 = o.indexOf(ind[0]); const i1 = o.indexOf(ind[1]); [o[i0], o[i1]] = [o[i1], o[i0]];
    const { w, body } = await rendered('x_pizza', XP, after);
    assert.ok(body.categories.some((c) => c.id === 'postres'), 'S4-FORMS-XP: premise — the body serves the new category');
    const doc = w.document;
    const idOf = (k) => String(after.items.find((i) => i.key === k).display.id);
    assert.ok(!doc.getElementById(`card-${String(moved.display.id)}`), 'S4-FORMS-XP: the dish moved into the new category is NOT drawn (app-only)');
    for (const k of ind) assert.ok(doc.getElementById(`card-${idOf(k)}`), `S4-FORMS-XP: ${k} still drawn`);
    const cards = [...doc.querySelectorAll('[id^="card-"]')].map((c) => c.id.slice(5));
    assert.ok(cards.indexOf(idOf(ind[1])) < cards.indexOf(idOf(ind[0])), 'S4-FORMS-XP: dish order follows item_order (the swap is drawn)');
    closeAll();
  }
  ok('S4-FORMS-XP: x_pizza keeps its tabs; a dish in a new category is absent (app-only), the rest drawn in item_order');

  clearTimeout(WATCHDOG);
  console.log('\ns4-forms: OK');
})().catch((e) => { console.error('s4-forms: FAILED —', e && e.message); process.exit(1); });
