// STRUCTURE S2 — the pure half (PLAN-portal-structure-S2-ui r3, APPROVED 2026-11-11: §3.1 the one mutator, §3.2 the drawer's ONE
// composition, §3.3 ref-aware prices, §3.6 pending structure, §2 item 5b X3b / category eligibility by the writer's own dry run).
// Every source is a REAL seed (both brands, tools/seed-source-store, canonicalized as the server stores it) and every write goes through
// 5f's REAL writer — the portal's byte copy, xpizza-portal/exposure-transitions.js (sync-client), loaded as the page loads it.
// Run: node --test structure-s2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDraft, draftSource, pendingCount, setExtraPrice, applyExposureOps, composeDish, pendingStructure, attachRefusal } from './editor.js';
import * as IE from './item-edit-logic.js';

const req = createRequire(import.meta.url);
const { buildSourceFromCode } = req('../xpizza-functions/tools/seed-source-store');
const { canonicalize, validateSource } = req('../xpizza-functions/catalog/source-store');
// the page's order: THE ONE extras rule, then the writer that reads it (index.html)
runInThisContext(readFileSync(new URL('./extras-eligibility.js', import.meta.url), 'utf8'));
runInThisContext(readFileSync(new URL('./exposure-transitions.js', import.meta.url), 'utf8'));
const XT = globalThis.ExposureTransitions, EE = globalThis.ExtrasEligibility;

const clone = (x) => JSON.parse(JSON.stringify(x));
const seed = (rid) => canonicalize(buildSourceFromCode(rid));
const ON = { extrasCatalog: true };
const offered = (src, key) => XT.effectiveGroups(EE.projectEligibility(src))[key];
const extrasOfGroup = (src, G) => src.extras.filter((e) => e.display && e.display.cat === G).map((e) => e.key);
const denyOf = (src, key) => { const o = src.structure.exposure.item_overrides && src.structure.exposure.item_overrides[key]; return o && Array.isArray(o.deny_extras) ? o.deny_extras : []; };
// the drawer for a dish with both server switches on (S1's authoring + S2's catalog)
const drawer = (d, key) => IE.open(d, key, null, { extrasAuthoring: true, extrasCatalog: true });

// ── §3.1 the one mutator ─────────────────────────────────────────────────────────────────────────────────────────────────
for (const rid of ['la_musa', 'x_pizza']) {
  const KEY = rid === 'la_musa' ? 'dimsum_01' : 'Carnivora';
  test(`applyExposureOps (${rid}) — refused with the switch OFF or the draft not editable; nothing written`, () => {
    const d = createDraft(seed(rid)); const before = JSON.stringify(draftSource(d));
    const G = offered(draftSource(d), KEY)[0];
    assert.deepEqual(applyExposureOps(d, [{ op: 'detach.item', item: KEY, group: G }], {}), { ok: false, code: 'extras_catalog_off' }, 'extrasCatalog OFF: nothing written');
    assert.equal(JSON.stringify(draftSource(d)), before, 'extrasCatalog OFF: the draft is untouched');
    const ro = createDraft(seed(rid), { canEdit: () => false });
    assert.equal(applyExposureOps(ro, [{ op: 'detach.item', item: KEY, group: G }], ON).ok, false, 'a draft not owned for editing refuses');
  });
  test(`applyExposureOps (${rid}) — an ORDERED list through the shared writer, the same source the writer produces op by op`, () => {
    const d = createDraft(seed(rid));
    const G = offered(draftSource(d), KEY)[0];
    const ops = [{ op: 'detach.item', item: KEY, group: G }, { op: 'attach.item', item: KEY, group: G }, { op: 'detach.item', item: KEY, group: G }];
    let want = clone(draftSource(d)); for (const op of ops) want = XT.apply(want, op).source;
    const r = applyExposureOps(d, ops, ON);
    assert.equal(r.ok, true);
    assert.deepEqual(draftSource(d), want, 'the draft is the writer’s fold of the ordered ops');
    assert.ok(!offered(draftSource(d), KEY).includes(G), `${G} detached`);
    assert.doesNotThrow(() => validateSource(clone(draftSource(d)), rid), 'a source the server accepts');
  });
  test(`applyExposureOps (${rid}) — a refusal mid-list leaves the draft byte-identical (no half-applied list)`, () => {
    const d = createDraft(seed(rid)); const before = JSON.stringify(draftSource(d));
    const G = offered(draftSource(d), KEY)[0];
    const r = applyExposureOps(d, [{ op: 'detach.item', item: KEY, group: G }, { op: 'attach.item', item: KEY, group: 'No existe' }], ON);
    assert.equal(r.ok, false); assert.equal(r.code, 'unknown_group');
    assert.equal(JSON.stringify(draftSource(d)), before, 'a refused list leaves the draft byte-identical');
  });
  test(`applyExposureOps (${rid}) — group.order: every group once, or refused (the writer's structure_changed) with nothing written`, () => {
    const d = createDraft(seed(rid)); const before = JSON.stringify(draftSource(d));
    const groups = draftSource(d).structure.extra_categories.slice();
    const bad = applyExposureOps(d, [{ op: 'group.order', order: groups.slice(1) }], ON);
    assert.deepEqual([bad.ok, bad.code, bad.field], [false, 'structure_changed', 'extra_categories'], 'the order names every group once');
    assert.equal(JSON.stringify(draftSource(d)), before);
    const dup = applyExposureOps(d, [{ op: 'group.order', order: [groups[0], ...groups.slice(0, -1)] }], ON);
    assert.equal(dup.ok, false, 'the order names every group once (a duplicate)');
    const rev = groups.slice().reverse();
    assert.equal(applyExposureOps(d, [{ op: 'group.order', order: rev }], ON).ok, true);
    assert.deepEqual(draftSource(d).structure.extra_categories, rev);
  });
}

// ── §3.3 new extras are ref-aware ────────────────────────────────────────────────────────────────────────────────────────
test('setExtraPrice — a keyless new extra by its {ref}; a key by string or {key}; a ref never reaches a keyed row', () => {
  const d = createDraft(seed('la_musa'));
  const r = applyExposureOps(d, [{ op: 'group.create', group: 'Toppings', extras: [{ ref: 'tmp:probe-1', name: 'Maní', price: 15 }], attach: { mode: 'none' } }], ON);
  assert.equal(r.ok, true);
  const row = () => draftSource(d).extras.find((e) => e.ref === 'tmp:probe-1');
  assert.ok(!('key' in row()) && !('id' in row()) && !('identity_id' in row().display), 'a new row carries no key, id or stamp');
  setExtraPrice(d, { ref: 'tmp:probe-1' }, '27');
  assert.equal(row().price, 27, 'the keyless row’s price is the typed one');
  assert.equal(row().display.price, 27, 'price and display.price move together');
  const k = draftSource(d).extras.find((e) => typeof e.key === 'string').key;
  setExtraPrice(d, k, '31');
  assert.equal(draftSource(d).extras.find((e) => e.key === k).price, 31, 'S1’s string key still sets the price');
  setExtraPrice(d, { key: k }, '33');
  assert.equal(draftSource(d).extras.find((e) => e.key === k).price, 33, '{key} sets the price');
  const before = JSON.stringify(draftSource(d));
  setExtraPrice(d, { ref: k }, '99');
  assert.equal(JSON.stringify(draftSource(d)), before, 'a ref never matches a keyed row');
});

// ── §3.2 the drawer: ONE composition, preview = commit ───────────────────────────────────────────────────────────────────
test('composeDish — attach a group, then untick one of its extras: composes (the checklist judged against the PROSPECT)', () => {
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  assert.ok(!offered(draftSource(d), 'dimsum_01').includes('Proteínas'), 'premise: dimsum_01 is not offered Proteínas');
  IE.setGroupAttached(s, 'Proteínas', true);
  const x = extrasOfGroup(draftSource(d), 'Proteínas')[0];
  IE.set(s, 'extraOn', { key: x, on: false });
  const r = IE.save(d, s);
  assert.deepEqual(r, { ok: true }, 'attach then untick composes (no extras refusal)');
  assert.ok(offered(draftSource(d), 'dimsum_01').includes('Proteínas'), 'Proteínas attached');
  assert.deepEqual(denyOf(draftSource(d), 'dimsum_01'), [x], 'the untick saved');
  assert.doesNotThrow(() => validateSource(clone(draftSource(d)), 'la_musa'));
});
test('composeDish — untick → detach → reattach: every extra ticked again (the working checklist follows each op)', () => {
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  const x = extrasOfGroup(draftSource(d), 'Salsas')[0];
  IE.set(s, 'extraOn', { key: x, on: false });
  IE.setGroupAttached(s, 'Salsas', false);
  IE.setGroupAttached(s, 'Salsas', true);
  assert.deepEqual(s.work.denyExtras, [], 'reattach starts with every extra ticked (the copy)');
  assert.deepEqual(IE.save(d, s), { ok: true });
  assert.deepEqual(denyOf(draftSource(d), 'dimsum_01'), [], 'reattach starts with every extra ticked');
  assert.ok(offered(draftSource(d), 'dimsum_01').includes('Salsas'));
});
test('composeDish — Codex r2 #4: detach / reattach Salsas, then move to Bebidas › Sodas: the MOVE is applied before the ops', () => {
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  IE.setGroupAttached(s, 'Salsas', false);
  IE.setGroupAttached(s, 'Salsas', true);
  IE.set(s, 'cat', 'bebidas'); IE.set(s, 'subcat', 'Sodas');
  assert.deepEqual(IE.save(d, s), { ok: true });
  // Bebidas offers no group by its section: the moved dish is offered exactly the reattached one
  assert.deepEqual(offered(draftSource(d), 'dimsum_01'), ['Salsas'], 'the moved dish is offered its new section’s groups + the reattached one');
  assert.doesNotThrow(() => validateSource(clone(draftSource(d)), 'la_musa'));
});
test('composeDish — the preview IS the commit: the cards show exactly the groups the saved dish is offered', () => {
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  IE.setGroupAttached(s, 'Proteínas', true);
  IE.setGroupAttached(s, 'Salsas', false);
  const shown = IE.view(d, s).extras.cards.map((c) => c.cat);
  assert.deepEqual(IE.save(d, s), { ok: true });
  assert.deepEqual(shown, offered(draftSource(d), 'dimsum_01'), 'the preview is the committed source');
});
test('composeDish — a writer refusal refuses the whole composition; the draft is untouched', () => {
  const d = createDraft(seed('la_musa'));
  const s0 = drawer(d, 'dimsum_01');
  IE.set(s0, 'extrasNone', true);
  assert.deepEqual(IE.save(d, s0), { ok: true }, 'premise: dimsum_01 saved with «Sin extras»');
  const before = JSON.stringify(draftSource(d));
  // a name AND a move (both judged valid) ahead of the refused attach: none of it may reach the draft
  const r = composeDish(d, 'dimsum_01', { name: 'Har gow nuevo', cat: 'starters' }, [{ op: 'attach.item', group: 'Proteínas' }], { extrasAuthoring: true, extrasCatalog: true });
  assert.deepEqual([r.ok, r.code], [false, 'exposure_dish_no_extras']);
  assert.equal(JSON.stringify(draftSource(d)), before, 'a refused composition leaves the draft byte-identical');
});
test('composeDish — «Sin extras» OFF comes first: the same copy can turn it off and attach', () => {
  const d = createDraft(seed('la_musa'));
  const s0 = drawer(d, 'dimsum_01'); IE.set(s0, 'extrasNone', true); IE.save(d, s0);
  const s = drawer(d, 'dimsum_01');
  IE.set(s, 'extrasNone', false);
  IE.setGroupAttached(s, 'Proteínas', true);
  assert.deepEqual(IE.save(d, s), { ok: true }, '«Sin extras» off + attach composes');
  assert.ok(offered(draftSource(d), 'dimsum_01').includes('Proteínas'));
});
test('the drawer’s ops are dark without extrasCatalog (S1 exactly): no op recorded, the copy unchanged', () => {
  const d = createDraft(seed('la_musa'));
  const s = IE.open(d, 'dimsum_01', null, { extrasAuthoring: true });
  IE.setGroupAttached(s, 'Proteínas', true);
  assert.deepEqual(s.ops, [], 'extrasCatalog OFF: nothing written');
  assert.equal(IE.isDirty(s), false);
});
test('an attach / detach in the copy is an unsaved change; «Cancelar» writes nothing', () => {
  const d = createDraft(seed('la_musa')); const before = JSON.stringify(draftSource(d));
  const s = drawer(d, 'dimsum_01');
  IE.setGroupAttached(s, 'Proteínas', true);
  assert.equal(IE.isDirty(s), true, 'an op makes the copy dirty');
  IE.cancel(s);
  assert.equal(JSON.stringify(draftSource(d)), before, 'attach then Cancelar: nothing written');
});

// ── §3.6 pending structure ───────────────────────────────────────────────────────────────────────────────────────────────
for (const rid of ['la_musa', 'x_pizza']) {
  const KEY = rid === 'la_musa' ? 'dimsum_01' : 'Carnivora';
  test(`pendingStructure (${rid}) — an attachment or the order is pending work; reverting it is clean; S1's checklist is not counted twice`, () => {
    const d = createDraft(seed(rid));
    const n0 = pendingCount(d);
    const G = offered(draftSource(d), KEY)[0];
    applyExposureOps(d, [{ op: 'detach.item', item: KEY, group: G }], ON);
    assert.deepEqual(pendingStructure(d), [{ kind: 'dish', key: KEY }], 'the detach is pending');
    assert.equal(pendingCount(d), n0 + 1, 'a structure-only draft holds the reload');
    applyExposureOps(d, [{ op: 'attach.item', item: KEY, group: G }], ON);
    assert.deepEqual(pendingStructure(d), [], 'reattached: clean');
    const groups = draftSource(d).structure.extra_categories.slice();
    applyExposureOps(d, [{ op: 'group.order', order: groups.slice().reverse() }], ON);
    assert.deepEqual(pendingStructure(d), [{ kind: 'order' }]);
    applyExposureOps(d, [{ op: 'group.order', order: groups }], ON);
    assert.deepEqual(pendingStructure(d), []);
    const s = drawer(d, KEY);
    IE.set(s, 'extraOn', { key: extrasOfGroup(draftSource(d), G)[0], on: false });
    IE.save(d, s);
    assert.deepEqual(pendingStructure(d), [], 'a checklist edit is S1’s pending line, not a structure line');
    assert.equal(pendingCount(d), n0 + 1, 'S1’s count unchanged');
  });
}

// ── §2 item 5b — X3b / category eligibility: the writer's own dry run ───────────────────────────────────────────────────
test('attachRefusal — X3b rows and category mode are decided by the WRITER (a dry run), the reason by the refusal', () => {
  const lm = seed('la_musa');
  assert.equal(attachRefusal(lm, { mode: 'items', items: ['dimsum_01'] }), null, 'an eligible dish');
  assert.equal(JSON.stringify(lm), JSON.stringify(seed('la_musa')), 'the dry run never writes its input');
  assert.equal(attachRefusal(lm, { mode: 'cat', cat: 'dim_sum' }), null, 'an eligible category');
  // «Sin extras» (saved through the drawer, the real writer)
  const d = createDraft(clone(lm)); const s = drawer(d, 'dimsum_02'); IE.set(s, 'extrasNone', true); IE.save(d, s);
  assert.deepEqual(attachRefusal(draftSource(d), { mode: 'items', items: ['dimsum_02'] }), { code: 'exposure_dish_no_extras', reason: 'none' }, '«Sin extras» is the reason');
  // x_pizza's Nutella carries BOTH «Sin extras» and a legacy deny-all (deny ['*']) in the seed: the policy is the reason; with
  // «Sin extras» switched off through the drawer (the real writer) the deny-all alone is
  assert.deepEqual(attachRefusal(seed('x_pizza'), { mode: 'items', items: ['Nutella'] }), { code: 'exposure_dish_no_extras', reason: 'none' }, 'the policy is the reason');
  const xp = createDraft(seed('x_pizza')); const sx = drawer(xp, 'Nutella'); IE.set(sx, 'extrasNone', false);
  assert.deepEqual(IE.save(xp, sx), { ok: true }, 'premise: Nutella saved without «Sin extras»');
  assert.deepEqual(attachRefusal(draftSource(xp), { mode: 'items', items: ['Nutella'] }), { code: 'exposure_dish_no_extras', reason: 'deny_all' }, 'the deny-all is the reason');
  assert.equal(attachRefusal(lm, { mode: 'cat', cat: 'no_such' }).code, 'unknown_category');
  const t0 = performance.now(); for (const c of lm.structure.categories) attachRefusal(lm, { mode: 'cat', cat: c.id });
  assert.ok((performance.now() - t0) / lm.structure.categories.length <= 15, 'the category dry run stays within 15 ms per section');
});
