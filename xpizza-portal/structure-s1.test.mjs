// Structure S1 — the drawer's «Opciones» cards: the per-dish extras checklist + «Sin extras» (PLAN-portal-structure-S1-ui r3,
// APPROVED 2026-11-11; MOCKUP-portal-structure-edit.html v2 frame A; PLAN-per-product-extras rev 2.2 §2 / §3 / §8 / §12.3).
// The PURE half: editor.js (extrasBaseline, pendingDishExtras, editItem's denyExtras / extrasPolicy) and item-edit-logic.js (the
// drawer's working copy). Run: node --test xpizza-portal/structure-s1.test.mjs
//
// Fixtures come from the real writers: both brands' REAL seeds (tools/seed-source-store buildSourceFromCode, canonicalized —
// x_pizza keys by name, with Nutella's legacy deny '*'; la_musa keys by id, with the noodle_01 group and rice_03's `add`), and the
// server's own comparison (catalog/add-product.js compareToActive on real builds, catalog/source-store.js validateSource) judges
// what the portal writes. The eligibility rule is the portal's own copy, run as the page runs it (a classic script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDraft, draftSource, pendingCount, editItem, extrasBaseline, pendingDishExtras, setExtraPrice } from './editor.js';
import * as IE from './item-edit-logic.js';

const req = createRequire(import.meta.url);
const AP = req('../xpizza-functions/catalog/add-product.js');
const { buildSourceFromCode } = req('../xpizza-functions/tools/seed-source-store.js');
const { canonicalize, validateSource, sourceToBuildInputs, rendererContract } = req('../xpizza-functions/catalog/source-store.js');
const { buildCatalogV2 } = req('../xpizza-functions/catalog/form-menu-source.js');
runInThisContext(readFileSync(new URL('./extras-eligibility.js', import.meta.url), 'utf8'));
const EE = globalThis.ExtrasEligibility;

const clone = (x) => JSON.parse(JSON.stringify(x));
const SEED = { x_pizza: canonicalize(buildSourceFromCode('x_pizza')), la_musa: canonicalize(buildSourceFromCode('la_musa')) };
const draftOf = (rid) => createDraft(clone(SEED[rid]));
const ON = { extrasAuthoring: true };
const row = (d, key) => draftSource(d).items.find((r) => r.key === key);
const ov = (d, key) => draftSource(d).structure.exposure.item_overrides[key];
const catKeys = (src, cat) => src.extras.filter((x) => x.display.cat === cat).map((x) => x.key);
// a plain dish (no group) whose category offers extras, per brand
const PLAIN = { x_pizza: 'Carnivora', la_musa: 'dimsum_01' };
const LAUNCHER = 'noodle_01', VARIANTS = ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'];
// a section's first subsection, or null (a move INTO a section with subsections must pick one: no preselect)
const firstSub = (d, cat) => { const c = draftSource(d).structure.categories.find((x) => String(x.id) === cat); return c && Array.isArray(c.subcats) && c.subcats.length ? String(c.subcats[0]) : null; };

// the server's judgement of a portal-written source against the seed (the editCatalog order: validate, authored fields, compare)
const build = (rid, src) => { const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }); return { items: b.items, extras: b.extras, structure: b.structure }; };
function serverJudges(rid, src, extrasAuthoring) {
  validateSource(src, rid);
  AP.assertSameAuthoredFields(src.structure, SEED[rid].structure, { activeHasVariantItems: SEED[rid].structure.variant_items !== undefined });
  AP.compareToActive({ draftBuilt: build(rid, src), activeBuilt: build(rid, SEED[rid]), draftAuthored: Object.keys(src.structure),
    renderedCategories: rendererContract(rid).renderedCategories, extrasAuthoring });
}
const refusedAs = (fn, code) => assert.throws(fn, (e) => (e && (e.code === code || String(e.message).startsWith(`${code}:`))), code);

test('premise — both seeds are sources the server accepts, and the evaluator is the page\'s own copy', () => {
  for (const rid of ['x_pizza', 'la_musa']) assert.doesNotThrow(() => serverJudges(rid, clone(SEED[rid]), false));
  assert.equal(typeof EE.projectEligibility, 'function');
});

// ── editor.js: the baseline (§12.3) ──────────────────────────────────────────────────────────────────────────────────
test('extrasBaseline — the dish\'s categories\' extras ∪ its add, BEFORE its own deny_extras / «Sin extras», grouped in the projection order', () => {
  const d = draftOf('x_pizza');
  const b = extrasBaseline(draftSource(d), PLAIN.x_pizza);
  assert.deepEqual(b.groups.map((g) => g.cat), ['Salsas & Queso', 'Carnes', 'Vegetales & Hierbas']);
  assert.deepEqual(b.groups.flatMap((g) => g.keys), EE.eligibleExtras(EE.projectEligibility(draftSource(d)), PLAIN.x_pizza));
  // its own exclusions and «Sin extras» do not shrink the baseline (they are what the checklist shows as unchecked / off)
  const src = draftSource(d);
  src.structure.exposure.item_overrides[PLAIN.x_pizza] = { deny_extras: [b.groups[0].keys[0]] };
  row(d, PLAIN.x_pizza).display.extras_policy = 'none';
  assert.deepEqual(extrasBaseline(src, PLAIN.x_pizza).groups.flatMap((g) => g.keys), b.groups.flatMap((g) => g.keys));
  // la_musa rice_03: its `add` (Proteínas) joins the baseline
  const m = extrasBaseline(draftSource(draftOf('la_musa')), 'rice_03');
  assert.ok(m.groups.some((g) => g.cat === 'Proteínas'), 'add joins');
  // a legacy whole-dish deny ('*', Nutella) still applies: nothing to check there
  assert.deepEqual(extrasBaseline(draftSource(d), 'Nutella').groups, []);
  // the target section of a move: the baseline follows it
  assert.deepEqual(extrasBaseline(draftSource(draftOf('la_musa')), 'dimsum_01', { cat: 'bebidas' }).groups, [], 'Bebidas allows nothing');
});

// ── editor.js: editItem writes ─────────────────────────────────────────────────────────────────────────────────────
for (const rid of ['x_pizza', 'la_musa']) {
  test(`editItem (${rid}) — denyExtras writes item_overrides[dish].deny_extras in source.extras order; [] DELETES the field and an emptied override`, () => {
    const d = draftOf(rid), key = PLAIN[rid];
    const keys = extrasBaseline(draftSource(d), key).groups.flatMap((g) => g.keys);
    const pick = [keys[2], keys[0]];
    assert.ok(editItem(d, key, { denyExtras: pick }, ON));
    const order = draftSource(d).extras.map((x) => x.key);
    assert.deepEqual(ov(d, key).deny_extras, pick.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    assert.ok(editItem(d, key, { denyExtras: [] }, ON));
    assert.equal(ov(d, key), undefined, 'an override left with nothing is deleted (the validator refuses an empty one)');
    assert.doesNotThrow(() => serverJudges(rid, clone(draftSource(d)), true));
  });
}

test('editItem — an override\'s OTHER fields (add, a legacy deny) are kept byte-for-byte; only deny_extras moves', () => {
  const d = draftOf('la_musa');
  const before = clone(ov(d, 'rice_03'));
  const k = extrasBaseline(draftSource(d), 'rice_03').groups.find((g) => g.cat === 'Proteínas').keys[0];
  assert.ok(editItem(d, 'rice_03', { denyExtras: [k] }, ON));
  assert.deepEqual(ov(d, 'rice_03'), { ...before, deny_extras: [k] });
  assert.ok(editItem(d, 'rice_03', { denyExtras: [] }, ON));
  assert.deepEqual(ov(d, 'rice_03'), before, 'the add stays; the override survives');
});

test('editItem — extrasPolicy stamps the launcher AND every variant; null clears them all (source-store.js:596-598)', () => {
  const d = draftOf('la_musa');
  assert.ok(editItem(d, LAUNCHER, { extrasPolicy: 'none' }, ON));
  for (const k of [LAUNCHER, ...VARIANTS]) assert.equal(row(d, k).display.extras_policy, 'none', k);
  assert.doesNotThrow(() => serverJudges('la_musa', clone(draftSource(d)), true));
  assert.ok(editItem(d, LAUNCHER, { extrasPolicy: null }, ON));
  for (const k of [LAUNCHER, ...VARIANTS]) assert.equal('extras_policy' in row(d, k).display, false, k);
});

test('editItem — refused, nothing written: a variant\'s own list, an ADDED key outside the dish\'s baseline, an unknown key, authoring OFF', () => {
  const d = draftOf('la_musa'), src0 = clone(draftSource(d));
  const anySalsa = catKeys(src0, 'Salsas')[0];
  assert.equal(editItem(d, VARIANTS[1], { denyExtras: [anySalsa] }, ON), false, 'a variant never carries its own list');
  assert.equal(editItem(d, VARIANTS[1], { extrasPolicy: 'none' }, ON), false, 'a variant never carries its own «Sin extras» (the launcher\'s governs the group)');
  const outside = catKeys(src0, 'Proteínas')[0];   // dimsum allows Acompañamientos + Salsas only
  assert.equal(editItem(d, 'dimsum_01', { denyExtras: [outside] }, ON), false, 'an added key outside the baseline');
  assert.equal(editItem(d, 'dimsum_01', { denyExtras: ['no_such_extra'] }, ON), false);
  assert.equal(editItem(d, 'dimsum_01', { denyExtras: [anySalsa] }, { extrasAuthoring: false }), false, 'authoring OFF');
  assert.equal(editItem(d, 'dimsum_01', { extrasPolicy: 'none' }), false, 'authoring absent = OFF');
  assert.deepEqual(draftSource(d), src0, 'nothing written by any refusal');
});

// ── the working copy ───────────────────────────────────────────────────────────────────────────────────────────────
const openOn = (d, key, extrasAuthoring = true) => IE.open(d, key, null, { extrasAuthoring });
test('copy — the cards: one per baseline category, «N de M activos», «en N productos»; a toggle changes the COPY only', () => {
  const d = draftOf('x_pizza');
  const s = openOn(d, PLAIN.x_pizza);
  const v0 = IE.view(d, s).extras;
  assert.deepEqual(v0.cards.map((c) => c.cat), ['Salsas & Queso', 'Carnes', 'Vegetales & Hierbas']);
  const carnes = v0.cards[1];
  assert.equal(carnes.size, 5); assert.equal(carnes.active, 5);
  // «en N productos»: the dishes whose baseline offers the group (x_pizza: every dish of individual + ny)
  const offering = draftSource(d).items.filter((r) => ['individual', 'ny'].includes(r.display.cat) && r.key !== 'Nutella').length;
  assert.equal(carnes.usedBy, offering);
  IE.set(s, 'extraOn', { key: carnes.rows[0].key, on: false });
  const v1 = IE.view(d, s).extras.cards[1];
  assert.equal(v1.active, 4);
  assert.equal(v1.rows[0].on, false);
  assert.equal(ov(d, PLAIN.x_pizza), undefined, 'the shared draft is untouched until «Guardar»');
  assert.ok(IE.view(d, s).changed.includes('denyExtras'));
  assert.ok(IE.isDirty(s));
});

test('copy — «Ninguno» denies exactly that group\'s CURRENT keys; «Marcar todos» restores them; other groups untouched', () => {
  const d = draftOf('x_pizza');
  const s = openOn(d, PLAIN.x_pizza);
  IE.set(s, 'extraGroupOn', { cat: 'Carnes', on: false });
  assert.deepEqual(s.work.denyExtras, catKeys(draftSource(d), 'Carnes'));
  IE.set(s, 'extraGroupOn', { cat: 'Carnes', on: true });
  assert.deepEqual(s.work.denyExtras, []);
  assert.equal(IE.isDirty(s), false, 'back to the loaded list = clean');
});

test('copy — «Sin extras» is one field: on → the cards are inactive; Guardar stamps the policy; the checklist keeps its list', () => {
  const d = draftOf('la_musa');
  const s = openOn(d, LAUNCHER);
  IE.set(s, 'extrasNone', true);
  const v = IE.view(d, s);
  assert.equal(v.extras.none, true);
  assert.ok(v.extras.cards.every((c) => c.disabled), 'the extras cards grey out (A2)');
  assert.ok(IE.save(d, s).ok);
  for (const k of [LAUNCHER, ...VARIANTS]) assert.equal(row(d, k).display.extras_policy, 'none');
});

test('copy — authoring OFF: the checklist and «Sin extras» are inert (no copy change) while a PRICE edit still saves (R5, R1/R4)', () => {
  const d = draftOf('x_pizza');
  const s = openOn(d, PLAIN.x_pizza, false);
  const v = IE.view(d, s).extras;
  assert.equal(v.authoring, false);
  IE.set(s, 'extraOn', { key: v.cards[0].rows[0].key, on: false });
  IE.set(s, 'extrasNone', true);
  assert.deepEqual(s.work.denyExtras, []); assert.equal(s.work.extrasNone, false);
  const ek = v.cards[0].rows[0].key;
  IE.set(s, 'extraPrice', { key: ek, raw: '99' });
  assert.ok(IE.save(d, s).ok);
  assert.equal(draftSource(d).extras.find((x) => x.key === ek).price, 99);
  assert.doesNotThrow(() => serverJudges('x_pizza', clone(draftSource(d)), false), 'a price edit with the switch OFF passes the server');
});

// ── a move in the same copy (Codex plan r1 #2): the prospective universe, the preserved exclusions ────────────────────────
test('move — a category change in the SAME copy re-derives the cards; exclusions outside the new baseline are PRESERVED and hidden; back → unchecked again', () => {
  const d = draftOf('la_musa');
  const salsa = catKeys(draftSource(d), 'Salsas')[1];
  // the dish already excludes a sauce
  assert.ok(editItem(d, 'dimsum_01', { denyExtras: [salsa] }, ON));
  const s = openOn(d, 'dimsum_01');
  const home = { cat: row(d, 'dimsum_01').display.cat, subcat: row(d, 'dimsum_01').display.subcat ?? null };
  IE.set(s, 'cat', 'bebidas'); IE.set(s, 'subcat', firstSub(d, 'bebidas'));
  assert.deepEqual(IE.view(d, s).extras.cards, [], 'Bebidas offers nothing: no cards');
  assert.ok(IE.save(d, s).ok, 'the move saves');
  assert.equal(row(d, 'dimsum_01').display.cat, 'bebidas');
  assert.deepEqual(ov(d, 'dimsum_01').deny_extras, [salsa], 'the exclusion is preserved (it excludes nothing there)');
  const back = openOn(d, 'dimsum_01');
  IE.set(back, 'cat', home.cat); IE.set(back, 'subcat', home.subcat);
  const card = IE.view(d, back).extras.cards.find((c) => c.cat === 'Salsas');
  assert.equal(card.rows.find((r) => r.key === salsa).on, false, 'moving back re-shows it unchecked');
});

test('move — a move AND an exclusion of the NEW section\'s extra, in one copy, save atomically (the added key is judged on the prospective baseline)', () => {
  const d = draftOf('la_musa');
  const s = openOn(d, 'rice_03');   // rice (Acompañamientos, Salsas) + add Proteínas
  IE.set(s, 'cat', 'noodles'); IE.set(s, 'subcat', firstSub(d, 'noodles'));
  const acomp = IE.view(d, s).extras.cards.find((c) => c.cat === 'Acompañamientos');
  IE.set(s, 'extraOn', { key: acomp.rows[0].key, on: false });
  assert.ok(IE.save(d, s).ok);
  assert.equal(row(d, 'rice_03').display.cat, 'noodles');
  assert.deepEqual(ov(d, 'rice_03').deny_extras, [acomp.rows[0].key]);
  const reopened = openOn(d, 'rice_03');
  assert.equal(IE.view(d, reopened).extras.cards.find((c) => c.cat === 'Acompañamientos').rows[0].on, false, 'reopened after save: the same');
});

test('move — an exclusion OUTSIDE the new section is kept and one INSIDE it is added, in ONE saved list (source.extras order)', () => {
  // the real la_musa seed with one exposure variation the validator accepts: Bebidas offers Proteínas
  const src = clone(SEED.la_musa); src.structure.exposure.category_allow.bebidas = ['Proteínas'];
  assert.doesNotThrow(() => validateSource(src, 'la_musa'), 'premise: a source the server accepts');
  const d = createDraft(src);
  const salsa = catKeys(src, 'Salsas')[0], prot = catKeys(src, 'Proteínas')[0];
  assert.ok(editItem(d, 'dimsum_01', { denyExtras: [salsa] }, ON));
  const s = openOn(d, 'dimsum_01');
  IE.set(s, 'cat', 'bebidas'); IE.set(s, 'subcat', firstSub(d, 'bebidas'));
  assert.deepEqual(IE.view(d, s).extras.cards.map((c) => c.cat), ['Proteínas'], 'the prospective section\'s groups');
  IE.set(s, 'extraOn', { key: prot, on: false });
  assert.ok(IE.save(d, s).ok);
  const order = src.extras.map((x) => x.key);
  assert.deepEqual(ov(d, 'dimsum_01').deny_extras, [salsa, prot].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'the kept one AND the new one');
});

// ── the pending count after the drawer closed (Codex plan r1 #1, P1) ──────────────────────────────────────────────────
for (const rid of ['x_pizza', 'la_musa']) {
  test(`pendingCount (${rid}) — a SAVED deny-only or policy-only change is pending work after the drawer closed; reverting is clean`, () => {
    const d = draftOf(rid), key = PLAIN[rid];
    const s = openOn(d, key);
    const k = IE.view(d, s).extras.cards[0].rows[0].key;
    IE.set(s, 'extraOn', { key: k, on: false });
    assert.ok(IE.save(d, s).ok); assert.equal(IE.isDirty(s), false, 'the copy is closed');
    assert.deepEqual(pendingDishExtras(d), [{ key, fields: ['denyExtras'] }]);
    assert.equal(pendingCount(d), 1);
    const s2 = openOn(d, key); IE.set(s2, 'extraOn', { key: k, on: true }); assert.ok(IE.save(d, s2).ok);
    assert.equal(pendingCount(d), 0, 'reverted → clean');
    const s3 = openOn(d, key); IE.set(s3, 'extrasNone', true); assert.ok(IE.save(d, s3).ok);
    assert.deepEqual(pendingDishExtras(d), [{ key, fields: ['extrasPolicy'] }]);
    assert.equal(pendingCount(d), 1);
  });
}

// ── key-only semantics (plan §2) ─────────────────────────────────────────────────────────────────────────────────────
test('«Ninguno», then a NEW extra in that group: the new extra stays OFFERED on the dish; «Sin extras» still suppresses it', () => {
  const d = draftOf('x_pizza');
  const s = openOn(d, PLAIN.x_pizza);
  IE.set(s, 'extraGroupOn', { cat: 'Carnes', on: false });
  assert.ok(IE.save(d, s).ok);
  // an extra added to the group later (the portal can't add one today, editor.js:15-18: appended the way a seed / S2 lands)
  const src = draftSource(d);
  src.extras.push({ key: 'Chorizo', price: 30, display: { id: 'x_new', cat: 'Carnes', name: 'Chorizo', price: 30 } });
  assert.ok(EE.eligibleSet(EE.projectEligibility(src), PLAIN.x_pizza).has('Chorizo'), 'the newly added extra stays offered');
  row(d, PLAIN.x_pizza).display.extras_policy = 'none';
  assert.equal(EE.eligibleSet(EE.projectEligibility(src), PLAIN.x_pizza).has('Chorizo'), false, '«Sin extras» suppresses it');
});

test('collision — an extra whose KEY equals a group name: deny_extras excludes only that key, never the group', () => {
  const d = draftOf('x_pizza');
  const src = draftSource(d);
  src.extras.push({ key: 'Carnes', price: 20, display: { id: 'x_col', cat: 'Salsas & Queso', name: 'Carnes', price: 20 } });
  assert.ok(editItem(d, PLAIN.x_pizza, { denyExtras: ['Carnes'] }, ON));
  const elig = EE.eligibleSet(EE.projectEligibility(src), PLAIN.x_pizza);
  assert.equal(elig.has('Carnes'), false);
  for (const k of catKeys(src, 'Carnes')) assert.ok(elig.has(k), `${k} (group Carnes) stays offered`);
});

// ── the server's judgement of what the portal writes (Codex plan r1 #4; r2 (a)) ───────────────────────────────────────
test('server — the portal-written exclusion / policy pass with the switch ON and are refused extras_not_supported_yet with it OFF', () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const d = draftOf(rid), key = PLAIN[rid];
    const s = openOn(d, key);
    IE.set(s, 'extraOn', { key: IE.view(d, s).extras.cards[0].rows[0].key, on: false });
    IE.set(s, 'extrasNone', true);
    assert.ok(IE.save(d, s).ok);
    assert.doesNotThrow(() => serverJudges(rid, clone(draftSource(d)), true), `${rid} ON`);
    refusedAs(() => serverJudges(rid, clone(draftSource(d)), false), 'extras_not_supported_yet');
  }
});

test('server — forged exposure changes are refused by the check that owns them: compareToActive, validateSource, assertSameAuthoredFields', () => {
  const rid = 'la_musa';
  const forged = (f) => { const x = clone(SEED[rid]); f(x); return x; };
  refusedAs(() => serverJudges(rid, forged((x) => { x.structure.exposure.item_overrides.rice_03.add = ['Salsas']; }), true), 'structure_changed');
  refusedAs(() => serverJudges(rid, forged((x) => { x.structure.exposure.item_overrides.dimsum_01 = { deny: ['Salsas'] }; }), true), 'structure_changed');
  refusedAs(() => serverJudges(rid, forged((x) => { x.structure.exposure.category_allow.crudo = ['Salsas']; }), true), 'structure_changed');
  // an unknown override field: the validator's own refusal (source-store.js:77 fail(), :465-467), before any comparison
  assert.throws(() => validateSource(forged((x) => { x.structure.exposure.item_overrides.dimsum_01 = { deny_extras: [catKeys(x, 'Salsas')[0]], hide: ['x'] }; }), rid), /^Error: source_malformed: .*unknown field hide/);
  // removed authored exposure: assertSameAuthoredFields (add-product.js:590-594)
  const gone = forged((x) => { delete x.structure.exposure; });
  assert.throws(() => AP.assertSameAuthoredFields(gone.structure, SEED[rid].structure), (e) => e.code === 'structure_changed' && /cannot be added or removed here/.test(e.message));
});
