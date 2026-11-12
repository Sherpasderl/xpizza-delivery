// STRUCTURE S2 — the «Extras» page model (PLAN-portal-structure-S2-ui r3 §2 items 2–3; MOCKUP frame X, names read-only in S2-core):
// the rail (every group in the ONE order, its extras, «en N productos» = the server's reach rule: launchers whose EFFECTIVE groups
// include it), the detail (rows with their marks: «Nuevo», a changed price, «Se quita al publicar»), the shared warning.
// Real seeds (both brands), every write through 5f's real writer (the portal's byte copy). Run: node --test extras-logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDraft, draftSource, applyExposureOps, setExtraPrice } from './editor.js';
import { extrasPageModel } from './extras-logic.js';

const req = createRequire(import.meta.url);
const { buildSourceFromCode } = req('../xpizza-functions/tools/seed-source-store');
const { canonicalize } = req('../xpizza-functions/catalog/source-store');
runInThisContext(readFileSync(new URL('./extras-eligibility.js', import.meta.url), 'utf8'));
runInThisContext(readFileSync(new URL('./exposure-transitions.js', import.meta.url), 'utf8'));
const XT = globalThis.ExposureTransitions, EE = globalThis.ExtrasEligibility;
const clone = (x) => JSON.parse(JSON.stringify(x));
const seed = (rid) => canonicalize(buildSourceFromCode(rid));
const ON = { extrasCatalog: true };
// the server's reach rule (review-diff.js:91), computed independently here as the oracle
const reachOracle = (src, g) => { const P = EE.projectEligibility(src); const E = XT.effectiveGroups(P); return Object.keys(E).filter((k) => !P.items[k].launcherKey && E[k] && E[k].includes(g)).length; };

for (const rid of ['la_musa', 'x_pizza']) {
  test(`rail (${rid}) — every group in the ONE order, its extras count and «en N productos» by the server's reach rule; the first selected`, () => {
    const d = createDraft(seed(rid)); const src = draftSource(d);
    const m = extrasPageModel(d);
    assert.deepEqual(m.rail.map((r) => r.group), src.structure.extra_categories, 'the ONE group order');
    for (const r of m.rail) {
      assert.equal(r.count, src.extras.filter((e) => e.display.cat === r.group).length, `${r.group}: its extras`);
      assert.equal(r.reach, reachOracle(src, r.group), `${r.group}: «en N productos» is the server's reach rule`);
    }
    assert.equal(m.selected, src.structure.extra_categories[0], 'the first group is selected by default');
  });
}

test('rail — the reach follows the draft live (a detach lowers it by one)', () => {
  const d = createDraft(seed('la_musa'));
  const before = extrasPageModel(d).rail.find((r) => r.group === 'Salsas').reach;
  assert.equal(applyExposureOps(d, [{ op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }], ON).ok, true);
  assert.equal(extrasPageModel(d).rail.find((r) => r.group === 'Salsas').reach, before - 1, 'the detach is counted live');
});

test('detail — rows with their marks: «Nuevo» (keyless), a changed price, «Se quita al publicar» (removed in the draft); the shared warning', () => {
  const d = createDraft(seed('la_musa'));
  const g = 'Acompañamientos';
  const [a, b] = draftSource(d).extras.filter((e) => e.display.cat === g);
  setExtraPrice(d, a.key, String(a.price + 5));
  assert.equal(applyExposureOps(d, [{ op: 'extra.add', group: g, ref: 'tmp:new-row-0001', name: 'Arroz frito', price: 40 },
    { op: 'extra.remove', key: b.key }], ON).ok, true);
  const m = extrasPageModel(d, { group: g });
  assert.equal(m.selected, g);
  const row = (name) => m.detail.rows.find((r) => r.name === name);
  assert.deepEqual(row('Arroz frito'), { id: { ref: 'tmp:new-row-0001' }, name: 'Arroz frito', price: 40, isNew: true, priceChanged: false, removed: false }, '«Nuevo»: a keyless row, by its ref');
  assert.equal(row(a.display.name).priceChanged, true, 'a changed price is marked');
  const rb = row(b.display.name);
  assert.deepEqual(rb && [rb.removed, rb.id], [true, { key: b.key }], '«Se quita al publicar»: still listed, greyed');
  assert.equal(m.detail.count, m.detail.rows.filter((r) => !r.removed).length, '«{n} extras» counts what stays');
  assert.equal(m.detail.reach, reachOracle(draftSource(d), g));
  assert.equal(m.detail.shared, m.detail.reach > 1, 'the shared warning when more than one product uses the group');
});

test('detail — an unknown or removed selection falls back to the first group (never a blank page)', () => {
  const d = createDraft(seed('x_pizza'));
  assert.equal(extrasPageModel(d, { group: 'No existe' }).selected, draftSource(d).structure.extra_categories[0]);
});

// ── X3 «Crear grupo» + X3b «A productos que elija» (MOCKUP x4b; plan §2 items 5 / 5b, §3.5) ────────────────────────────────────
import { createGroupForm, createGroupView, setCreateField, createGroupOp } from './extras-logic.js';
const editorM = await import('./editor.js');

test('X3 — the empty form: the name counter 0/40, one empty extra row, «Todavía a ninguno», «Crear grupo» off (a name and one complete extra needed)', () => {
  const d = createDraft(seed('la_musa'));
  const f = createGroupForm();
  const v = createGroupView(d, f);
  assert.equal(v.counter, '0/40');
  assert.equal(v.rows.length, 1);
  assert.equal(v.mode, 'none');
  assert.equal(v.canCreate, false, 'the empty form holds «Crear grupo»');
});
test('X3 — a started row must be complete: «Escribí el nombre.» / «El precio debe ser al menos L 1.»; an empty row is ignored', () => {
  const d = createDraft(seed('la_musa'));
  let f = createGroupForm();
  f = setCreateField(f, 'name', 'Toppings');
  f = setCreateField(f, 'row', { i: 0, name: 'Maní', raw: '0' });
  let v = createGroupView(d, f);
  assert.equal(v.rows[0].priceError, 'El precio debe ser al menos L 1.');
  assert.equal(v.canCreate, false, 'a started row with a bad price holds «Crear grupo»');
  f = setCreateField(f, 'row', { i: 0, name: 'Maní', raw: '15' });
  f = setCreateField(f, 'addRow');
  v = createGroupView(d, f);
  assert.equal(v.canCreate, true, 'an empty extra row is ignored');
  f = setCreateField(f, 'row', { i: 1, name: '', raw: '10' });
  v = createGroupView(d, f);
  assert.equal(v.rows[1].nameError, 'Escribí el nombre.');
  assert.equal(v.canCreate, false, 'a started row with no name holds «Crear grupo»');
});
test('X3 — a group name already used: «Ya hay un grupo con ese nombre.»; over 40 characters is refused', () => {
  const d = createDraft(seed('la_musa'));
  let f = setCreateField(createGroupForm(), 'name', 'Salsas');
  assert.equal(createGroupView(d, f).nameError, 'Ya hay un grupo con ese nombre.', 'a taken name is refused in words');
  f = setCreateField(f, 'name', 'x'.repeat(41));
  assert.equal(createGroupView(d, f).counter, '41/40');
  assert.equal(createGroupView(d, f).canCreate, false);
});
test('X3b — sections of launcher dishes, «{marked} de {eligible}», «Marcar todos» ⇄ «Ninguno»; disabled rows with the WRITER’s reason; never counted', () => {
  const xp = createDraft(seed('x_pizza'));
  let f = setCreateField(createGroupForm(), 'mode', 'items');
  let v = createGroupView(xp, f);
  const sec = v.sections.find((s) => s.rows.some((r) => r.key === 'Nutella'));
  const nut = sec.rows.find((r) => r.key === 'Nutella');
  assert.deepEqual([nut.disabled, nut.reason], [true, 'Tiene «Sin extras»'], 'the writer refuses it; the reason is the copy table’s');
  const eligible = sec.rows.filter((r) => !r.disabled).length;
  assert.equal(sec.count, `0 de ${eligible}`, 'disabled rows are in neither number');
  assert.equal(sec.link, 'Marcar todos');
  f = setCreateField(f, 'markAll', { cat: sec.cat });
  v = createGroupView(xp, f);
  const sec2 = v.sections.find((s) => s.cat === sec.cat);
  assert.equal(sec2.count, `${eligible} de ${eligible}`);
  assert.equal(sec2.link, 'Ninguno');
  assert.equal(sec2.rows.find((r) => r.key === 'Nutella').checked, false, '«Marcar todos» marks the eligible rows only');
  assert.equal(v.modeSub, `· ${eligible} productos`);
});
test('X3b — switching mode keeps each mode’s inputs, but the op is built ONLY from the selected mode (no hidden selection leaks)', () => {
  const d = createDraft(seed('la_musa'));
  let f = setCreateField(createGroupForm(), 'name', 'Toppings');
  f = setCreateField(f, 'row', { i: 0, name: 'Maní', raw: '15' });
  f = setCreateField(f, 'mode', 'items');
  f = setCreateField(f, 'mark', { key: 'dimsum_01', on: true });
  f = setCreateField(f, 'mode', 'none');
  const op = createGroupOp(d, f);
  assert.deepEqual(op.attach, { mode: 'none' }, 'the hidden item selection never leaks');
  f = setCreateField(f, 'mode', 'items');
  assert.deepEqual(createGroupOp(d, f).attach, { mode: 'items', items: ['dimsum_01'] }, 'switching back restores the mode’s input');
  assert.match(op.extras[0].ref, /^tmp:[A-Za-z0-9-]{8,64}$/, 'a new extra by a tmp ref the server accepts');
  assert.ok(!('key' in op.extras[0]) && !('id' in op.extras[0]), 'no key, id or stamp');
  // the op the form builds is one the REAL writer applies
  assert.equal(editorM.applyExposureOps(d, [setCreateField(f, 'noop') && createGroupOp(d, f)], ON).ok, true);
  assert.ok(draftSource(d).structure.extra_categories.includes('Toppings'));
});
test('X3b — category mode: a section the writer refuses is a disabled option with the category-level reason; the note counts dishes that show no extras', () => {
  const xp = createDraft(seed('x_pizza'));
  const f = setCreateField(createGroupForm(), 'mode', 'cat');
  const v = createGroupView(xp, f);
  for (const o of v.categories) {
    const refused = editorM.attachRefusal(draftSource(xp), { mode: 'cat', cat: o.cat });
    assert.equal(o.disabled, !!refused, `${o.cat}: disabled exactly when the writer refuses it`);
  }
  assert.equal(v.cat, v.categories.find((o) => !o.disabled).cat, 'category mode preselects the first section the writer accepts (no placeholder)');
  for (const o of v.categories.filter((x) => !x.disabled)) assert.match(o.label, /^.+ · \d+ productos?$/, 'an enabled option reads «{categoría} · N productos»');
  const ind = v.categories.find((o) => o.cat === 'individual');
  const f2 = setCreateField(f, 'cat', 'individual');
  assert.match(createGroupView(xp, f2).catNote || '', /^\d+ productos? de esta categoría no muestran? extras\.$/, 'the quiet note (Nutella shows none)');
  assert.ok(ind && !ind.disabled);
});
test('X3b — category mode, a REFUSED category (5f\u2019s XT-REFUSALS fixture: a legacy option-level rule on noodle_01_pollo): a disabled option «{categoría} · un producto tiene opciones con reglas propias»', () => {
  const s0 = buildSourceFromCode('la_musa');
  s0.structure.exposure.item_overrides.noodle_01_pollo = { deny: ['Salsas'] };   // exactly catalog/exposure-transitions.test.js XT-REFUSALS
  const d = createDraft(canonicalize(s0));
  const refused = editorM.attachRefusal(draftSource(d), { mode: 'cat', cat: 'noodles' });
  assert.equal(refused && refused.code, 'exposure_option_override', 'non-vacuity: the writer refuses the category');
  const o = createGroupView(d, setCreateField(createGroupForm(), 'mode', 'cat')).categories.find((x) => x.cat === 'noodles');
  assert.equal(o && o.disabled, true, 'a refused category is never offered');
  assert.match(o.label, / · un producto tiene opciones con reglas propias$/);
});
