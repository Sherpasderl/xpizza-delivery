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
