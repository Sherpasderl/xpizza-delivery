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
import { reviewModel, renderReview, attestationModel, renderAttestation } from './review.js';

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

// ── §4 the review's «Estructura» group — ONLY the server's token-bound diff (MOCKUP frame F; contract §3 + P-2 / P-3) ─────────────
// the diff is what 5f's REAL editCatalogCore answers for the portal's own draft (the S1 chain's pattern), the Extras-page switch ON
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
{ const ps = req.resolve('../xpizza-functions/catalog/platform-structure'); req.cache[ps] = { id: ps, filename: ps, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: true }) } }; }
async function realSaveDiff(rid, live, draftSrc) {
  const { editCatalogCore } = req('../xpizza-functions/catalog/edit-catalog-handler');
  const { sourceToBuildInputs } = req('../xpizza-functions/catalog/source-store');
  const { buildCatalogV2 } = req('../xpizza-functions/catalog/form-menu-source');
  const T0 = '2026-11-12T10:00:00.000000Z', T1 = '2026-11-12T11:00:00.000000Z';
  const st = { data: clone(live), updateTime: T0 };
  const doc = (path) => ({
    get: async () => (path.endsWith('/meta/source') ? { exists: true, data: () => clone(st.data), updateTime: st.updateTime }
      : path.endsWith('/meta/active_version') ? { exists: true, data: () => ({ version: 'v-live' }) } : { exists: false, data: () => ({}) }),
    set: async (d) => { st.data = d; st.updateTime = T1; return { writeTime: T1 }; },
    update: async (d, pre) => { if (!pre || pre.lastUpdateTime !== st.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } st.data = d; st.updateTime = T1; return { writeTime: T1 }; },
  });
  const db = { collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
  const i = sourceToBuildInputs(live); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras });
  // the add-product I/O exactly as 5f's own S2-core flow suite wires it (catalog/s2core-flow.test.js addProductOf): each brand's key mode
  const addProduct = { readKeyMode: async () => (rid === 'la_musa' ? 'id' : 'name'), hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }),
    registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => req('../xpizza-functions/catalog/reserved-keys').reservedKeySet(undefined) };
  const r = await editCatalogCore({ db, addProduct, authorize: async () => ({ ok: true, uid: 'u', role: 'owner', actor: 'o@x.hn' }), readActiveBuilt: async () => ({ built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras }) },
    { restaurantId: rid, source: clone(draftSrc), baseSourceUpdateTime: T0 }, {});
  assert.equal(r.status, 200, `premise: the real save accepts the portal's draft (${JSON.stringify(r.body).slice(0, 200)})`);
  realSaveDiff.last = r.body;   // the whole 200 body (extraRefs, source) for the adoption cells
  return r.body.diff;
}
const ctxOf = (src) => {
  const items = src.items.filter((r) => r && r.display && typeof r.key === 'string');
  const cats = src.structure.categories || [];
  return { structure: { nameOf: (k) => { const r = items.find((x) => x.key === k); return r ? r.display.name : k; },
    categoryName: (id) => { const c = cats.find((x) => String(x.id) === String(id)); return c && c.name ? c.name : String(id); },
    sectionOf: (k) => { const r = items.find((x) => x.key === k); return r ? { cat: String(r.display.cat), subcat: r.display.subcat || null } : { cat: null, subcat: null }; } } };
};
const rowsText = (m) => m.structure.map((r) => [r.name, r.sub, r.kind, ...r.parts].join(' | '));

test('Estructura — a detach, a reprice and the group order: rows from the SERVER diff, each fact once, «en N productos» from reach', async () => {
  const live = seed('la_musa'); const d = createDraft(clone(live));
  assert.equal(applyExposureOps(d, [{ op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }, { op: 'group.order', order: ['Salsas', 'Acompañamientos', 'Proteínas'] }], ON).ok, true);
  const rx = clone(draftSource(d).extras.find((e) => e.display.cat === 'Acompañamientos'));   // a copy: the row itself is repriced below
  setExtraPrice(d, rx.key, String(rx.price + 5));
  const diff = await realSaveDiff('la_musa', live, draftSource(d));
  assert.ok(diff.attachments && diff.reach, 'premise: the server diff carries P-2 / P-3');
  const m = reviewModel(diff, ctxOf(draftSource(d)));
  const dish = draftSource(d).items.find((r) => r.key === 'dimsum_01').display;
  const sect = (live.structure.categories.find((c) => c.id === dish.cat) || {}).name;
  assert.deepEqual(rowsText(m), [
    `${dish.name} | ${sect} | Quitado | grupo Salsas`,
    `Acompañamientos | Extras · en ${diff.reach['Acompañamientos']} productos | Cambio | ${rx.display.name} | · | L ${rx.price} | → | L ${rx.price + 5}`,
    `Salsas | Extras | Orden | pasa al 1.º lugar`,
  ], 'the Estructura rows, in words');
  assert.equal(m.rows.filter((r) => r.surface === 'extra' && r.key === rx.key).length, 0, 'the reprice is not ALSO a price row (each fact once)');
  const p = m.products.find((x) => x.key === 'dimsum_01');
  assert.ok(!p || !p.consequences.some((c) => /Salsas/.test(c)), 'the detach is not ALSO a consequence line (each fact once)');
  assert.equal(m.total, 3, 'it counts each fact once');
});
test('Estructura — a new group on chosen dishes and a new extra: «Nuevo» rows with the server’s reach; the attach rows name the dishes', async () => {
  const live = seed('x_pizza'); const d = createDraft(clone(live));
  const group = 'Toppings dulces';
  assert.equal(applyExposureOps(d, [{ op: 'group.create', group, extras: [{ ref: 'tmp:probe-new-1', name: 'Miel', price: 20 }], attach: { mode: 'items', items: ['Carnivora'] } }], ON).ok, true);
  const diff = await realSaveDiff('x_pizza', live, draftSource(d));
  const m = reviewModel(diff, ctxOf(draftSource(d)));
  const t = rowsText(m);
  const n = diff.reach[group];
  assert.ok(t.includes(`${group} | Extras · en ${n} ${n === 1 ? 'producto' : 'productos'} | Nuevo | Miel · L 20`), `the new extra's row (${JSON.stringify(t)})`);
  assert.ok(t.some((r) => r.startsWith('Carnivora |') && r.endsWith('| Nuevo | grupo Toppings dulces')), 'the dish’s attach row');
  assert.ok(t.some((r) => r.endsWith('| Orden | pasa al 4.º lugar')) === false, 'a NEW group is not an «Orden» row');
});
test('Estructura — no S2 op: today’s review exactly (no group, no count change)', async () => {
  const live = seed('la_musa'); const d = createDraft(clone(live));
  const rx = draftSource(d).extras[0]; setExtraPrice(d, rx.key, String(rx.price + 3));
  const diff = await realSaveDiff('la_musa', live, draftSource(d));
  const m = reviewModel(diff, ctxOf(draftSource(d)));
  assert.deepEqual(m.structure, [], 'no Estructura rows without an S2 op');
  assert.equal(m.rows.filter((r) => r.surface === 'extra').length, 1, 'the reprice stays today’s price row');
});

test('Estructura — rendered as frame F: the FIRST group «Estructura N», one .prow.mk-srow per row (name, sub, chip, the change)', async () => {
  const { JSDOM } = req('../xpizza-functions/node_modules/jsdom');
  const w = new JSDOM('<!doctype html><div id="r"></div>').window;
  const saved = globalThis.document; globalThis.document = w.document;
  try {
    const live = seed('la_musa'); const d = createDraft(clone(live));
    applyExposureOps(d, [{ op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }, { op: 'group.order', order: ['Salsas', 'Acompañamientos', 'Proteínas'] }], ON);
    const diff = await realSaveDiff('la_musa', live, draftSource(d));
    const root = w.document.getElementById('r');
    renderReview(root, reviewModel(diff, ctxOf(draftSource(d))), {});
    const g = root.querySelector('.mgroup');
    assert.equal(g && g.querySelector('.mglabel span').textContent, 'Estructura', 'the first group is «Estructura»');
    assert.equal(g.querySelector('.mglabel .mgn').textContent, '2', 'its count');
    const rows = [...g.querySelectorAll('.prow.mk-srow')];
    assert.equal(rows.length, 2);
    const chip = (r) => r.querySelector('.pval .bchip');
    assert.deepEqual(rows.map((r) => [r.querySelector('.pname').textContent, chip(r).className, chip(r).textContent]),
      [[draftSource(d).items.find((x) => x.key === 'dimsum_01').display.name, 'bchip rem', 'Quitado'], ['Salsas', 'bchip chg', 'Orden']], 'frame F’s rows and chips');
    assert.equal(rows[1].querySelector('.pval .now.plain').textContent, 'pasa al 1.º lugar');
  } finally { globalThis.document = saved; }
});

// ── Codex S2 UI r1 P1-4 — a checklist key the dish drops BECAUSE of a structural change (the extra removed, its group detached) is that
// change's cleanup: folded into its «Estructura» row, never ALSO «Vuelve a ofrecer …», never a raw key, never an extra count
const fullCtx = (src) => ({ ...ctxOf(src),
  extraName: (k) => { const x = src.extras.find((e) => e.key === k); return x && x.display ? x.display.name : null; },
  extraGroup: (k) => { const x = src.extras.find((e) => e.key === k); return x && x.display ? x.display.cat : null; } });
function untickedLive() {
  const d0 = createDraft(seed('la_musa')); const s = drawer(d0, 'dimsum_01');
  assert.ok(offered(draftSource(d0), 'dimsum_01').includes('Salsas'), 'premise: dimsum_01 offers Salsas');
  const x = extrasOfGroup(draftSource(d0), 'Salsas')[0];
  IE.set(s, 'extraOn', { key: x, on: false });
  assert.deepEqual(IE.save(d0, s), { ok: true }, 'premise: the untick saved (the drawer writer)');
  assert.deepEqual(denyOf(draftSource(d0), 'dimsum_01'), [x]);
  return { live: clone(draftSource(d0)), x };
}
const modelText = (m) => JSON.stringify(m);
for (const [what, ops] of [['the unticked extra removed', (x) => [{ op: 'extra.remove', key: x }]], ['its group detached from the dish', () => [{ op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }]]]) {
  test(`P1-4 — ${what}: the dish’s checklist cleanup is folded into the «Estructura» row — no «Vuelve a ofrecer», no raw key, counted once`, async () => {
    const { live, x } = untickedLive();
    const d = createDraft(clone(live));
    assert.equal(applyExposureOps(d, ops(x), ON).ok, true, 'premise: the op applies');
    const diff = await realSaveDiff('la_musa', live, draftSource(d));
    assert.ok((diff.changed || []).some((c) => c.key === 'dimsum_01' && c.field === 'deny_extras'), 'premise: the server diff carries the dish’s checklist cleanup');
    // names from the live menu too: a removed extra is NAMED here, so only the structural fold (not the raw-key floor) can hide it
    const ctx = fullCtx(draftSource(d)); const named = ctx.extraName;
    ctx.extraName = (k) => named(k) || ((live.extras.find((e) => e.key === k) || {}).display || {}).name || null;
    const m = reviewModel(diff, ctx);
    const p = m.products.find((y) => y.key === 'dimsum_01');
    const lines = p ? [...p.lines.map((l) => l.text || l), ...p.consequences].map(String) : [];
    assert.ok(!lines.some((t) => /Vuelve a ofrecer/.test(t)), `${what}: no «Vuelve a ofrecer» (${JSON.stringify(lines)})`);
    assert.ok(!modelText(m).includes(`Vuelve a ofrecer ${x}`), `${what}: never the raw key`);
    assert.ok(m.structure.length >= 1, `${what}: the structural change is its «Estructura» row`);
    assert.equal(m.total, m.structure.length + m.rows.length + m.products.reduce((n, q) => n + q.count, 0) + m.added.length + m.removed.length + m.renamed.length + m.photos.length + m.sections.length, `${what}: the total counts the rendered facts`);
    assert.ok(!p || p.count === 0, `${what}: the cleanup adds no product count`);
  });
}

test('P1-4 — the raw-key floor: a checklist key the caller cannot name is left out, never printed (the S2 fields absent from the diff)', async () => {
  const { live, x } = untickedLive();
  const d = createDraft(clone(live));
  assert.equal(applyExposureOps(d, [{ op: 'extra.remove', key: x }], ON).ok, true);
  const diff = await realSaveDiff('la_musa', live, draftSource(d));
  const { extras: _s2, ...noS2 } = diff;   // without its S2 rows the fold cannot see the removal: only the floor stands
  const m = reviewModel(noS2, fullCtx(draftSource(d)));
  const p = m.products.find((y) => y.key === 'dimsum_01');
  assert.ok(p, 'premise: the dish’s checklist line reached the model');
  assert.ok(!JSON.stringify([...p.lines, ...p.consequences]).includes(x), 'the raw key is never in the dish’s sentences');
});
test('P1-4 — a REAL re-tick beside an S2 removal stays «Vuelve a ofrecer {extra}» (named): only a structural cleanup folds', async () => {
  const { live, x } = untickedLive();
  const d = createDraft(clone(live));
  const s = drawer(d, 'dimsum_01'); IE.set(s, 'extraOn', { key: x, on: true });
  assert.deepEqual(IE.save(d, s), { ok: true }, 'premise: the re-tick saved (the drawer writer)');
  const other = extrasOfGroup(draftSource(d), 'Acompañamientos')[0];
  assert.equal(applyExposureOps(d, [{ op: 'extra.remove', key: other }], ON).ok, true, 'premise: another group’s extra removed (an S2 op)');
  const diff = await realSaveDiff('la_musa', live, draftSource(d));
  const m = reviewModel(diff, fullCtx(draftSource(d)));
  const p = m.products.find((y) => y.key === 'dimsum_01');
  const name = draftSource(d).extras.find((e) => e.key === x).display.name;
  assert.deepEqual(p && p.consequences, [`Vuelve a ofrecer ${name}`], 'the real restore is still said, by name');
});

// ── Codex S2 UI r1 P1-3 — the fiscal seal from the SERVER's `diff.fiscal` (MOCKUP frame F's seal): every new priced extra and every
// changed price, named, EXACTLY once; the drawn sentence, rows and «Autorizo» line. x_pizza (the platform-factura brand) on 5f's REAL save.
async function fiscalSave() {
  const live = seed('x_pizza'); const d = createDraft(clone(live));
  const group = 'Toppings dulces';
  assert.equal(applyExposureOps(d, [{ op: 'group.create', group, extras: [{ ref: 'tmp:seal-new-1', name: 'Miel', price: 17 }], attach: { mode: 'items', items: ['Carnivora'] } }], ON).ok, true);
  const rx = clone(draftSource(d).extras.find((e) => e.display.cat !== group));
  setExtraPrice(d, rx.key, String(rx.price + 5));
  const diff = await realSaveDiff('x_pizza', live, draftSource(d));
  assert.ok(diff.fiscal && diff.fiscal.added.some((a) => a.surface === 'extra' && a.name === 'Miel'), 'premise: the server puts the new extra in diff.fiscal.added');
  return { diff, rx, group };
}
test('P1-3 — attestationModel: the seal consumes diff.fiscal — the new extra and the extra reprice, named, each ONCE; L 0 still blocks', async () => {
  const { diff, rx, group } = await fiscalSave();
  const att = attestationModel(diff, { usesPlatformFactura: true });
  const all = [...att.sealRows, ...(att.addedRows || [])];
  assert.deepEqual(all.filter((r) => r.key === rx.key).map((r) => [r.surface, r.name, r.group, r.was, r.now]),
    [['extra', rx.display.name, rx.display.cat, rx.price, rx.price + 5]], 'the reprice: one row, its name and group');
  const miel = all.filter((r) => r.name === 'Miel');
  assert.deepEqual(miel.map((r) => [r.surface, r.group, r.now]), [['extra', group, 17]], 'the new extra: one row, its group and price');
  assert.equal(att.hasZero, false);
  const zero = clone(diff); zero.fiscal.added.find((a) => a.name === 'Miel').price = 0;
  assert.equal(attestationModel(zero, { usesPlatformFactura: true }).hasZero, true, 'a new extra the factura would print at L 0 blocks the publish');
});
test('P1-3 — the rendered seal is frame F’s: header, the drawn sentence, «{extra} ({grupo})» rows («L n · nuevo», «L a → L b»), «Autorizo esta edición…»', async () => {
  const { JSDOM } = req('../xpizza-functions/node_modules/jsdom');
  const w = new JSDOM('<!doctype html><div id="r"></div>').window;
  const saved = globalThis.document; globalThis.document = w.document;
  try {
    const { diff, rx, group } = await fiscalSave();
    const root = w.document.getElementById('r');
    renderAttestation(root, attestationModel(diff, { usesPlatformFactura: true }), () => {}, {});
    const seal = root.querySelector('.seal');
    assert.equal(seal.querySelector('.sealh span').textContent, 'Esta publicación requiere tu autorización como propietario', 'frame F’s seal header');
    assert.equal(seal.querySelector('.sealbody p').textContent, 'Como propietario, autorizás esta publicación. Agrega opciones con precio y cambia un precio: aparecen en la factura.', 'frame F’s sentence');
    const rows = [...seal.querySelectorAll('.seachg')].map((c) => [c.querySelector('.sn').textContent, c.querySelector('.sv').textContent]);
    assert.deepEqual(rows, [[`Miel (${group})`, 'L 17 · nuevo'], [`${rx.display.name} (${rx.display.cat})`, `L ${rx.price} → L ${rx.price + 5}`]], 'frame F’s rows, each fact once');
    assert.equal(seal.querySelector('.attest .at').textContent, 'Autorizo esta edición en la factura fiscal.', 'frame F’s «Autorizo» line');
  } finally { globalThis.document = saved; }
});

// advisor ruling 11-12 (a): frame F's sentence COMPOSED from the approved F + E fragments («composed from F + E») — 1, 2 and 3 fragments,
// number words consistent («un precio» / «N precios»); the real save (5f's handler) on la_musa, the seal rendered as the portal does
for (const [label, reprices, rename, want] of [
  ['1 fragment', 0, false, 'Como propietario, autorizás esta publicación. Agrega opciones con precio: aparecen en la factura.'],
  ['2 fragments (N precios)', 2, false, 'Como propietario, autorizás esta publicación. Agrega opciones con precio y cambia 2 precios: aparecen en la factura.'],
  ['3 fragments', 1, true, 'Como propietario, autorizás esta publicación. Agrega opciones con precio, cambia un precio y cambia el nombre de un producto: aparecen en la factura.'],
]) {
  test(`P1-3 ruling (a) — the composed seal sentence, ${label}`, async () => {
    const { JSDOM } = req('../xpizza-functions/node_modules/jsdom');
    const w = new JSDOM('<!doctype html><div id="r"></div>').window;
    const saved = globalThis.document; globalThis.document = w.document;
    try {
      const live = seed('la_musa'); const d = createDraft(clone(live));
      assert.equal(applyExposureOps(d, [{ op: 'group.create', group: 'Toppings', extras: [{ ref: 'tmp:compose-new-1', name: 'Miel', price: 17 }], attach: { mode: 'items', items: ['dimsum_01'] } }], ON).ok, true);
      const xs = draftSource(d).extras.filter((e) => e.display.cat === 'Acompañamientos').slice(0, reprices).map(clone);
      for (const x of xs) setExtraPrice(d, x.key, String(x.price + 5));
      if (rename) { const s = IE.open(d, 'dimsum_02', null, { extrasAuthoring: true, extrasCatalog: true, textEditEnabled: true }); IE.set(s, 'name', 'Dim sum renombrado'); assert.deepEqual(IE.save(d, s), { ok: true }, 'premise: the rename saved (the drawer writer)'); }
      const diff = await realSaveDiff('la_musa', live, draftSource(d));
      const root = w.document.getElementById('r');
      renderAttestation(root, attestationModel(diff, { usesPlatformFactura: true }), () => {}, {});
      assert.equal(root.querySelector('.sealbody p').textContent, want, `the composed sentence (${label})`);
    } finally { globalThis.document = saved; }
  });
}

// ── B «Agregar grupo de extras» (plan r3 §2 item 6; MOCKUP frame B): the sheet's MODEL over the drawer copy's ONE prospect ─────
test('B — the sheet: every EXISTING group in the ONE order, its extras joined «·», «en N productos» = the Extras page’s reach; a group already on the dish (in the copy) is «have»', () => {
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  const b = IE.attachSheet(d, s);
  const src = draftSource(d);
  const onDish = new Set(offered(src, 'dimsum_01') || []);
  const ec = src.structure.extra_categories;
  assert.deepEqual(b.rows.map((r) => r.group), [...ec.filter((g) => !onDish.has(g)), ...ec.filter((g) => onDish.has(g))], 'the groups to pick in the ONE order, the dish\u2019s own at the foot (frame B)');
  for (const r of b.rows) {
    assert.equal(r.extras, src.extras.filter((e) => e.display.cat === r.group).map((e) => e.display.name).join(' · '), `${r.group}: its extras`);
    assert.equal(r.have, onDish.has(r.group), `${r.group}: «Ya está en este producto» exactly when the dish offers it`);
    assert.ok(Number.isInteger(r.reach), `${r.group}: a reach`);
  }
  assert.ok(b.rows.some((r) => !r.have), 'non-vacuity: a group to add');
  assert.deepEqual([b.canAdd, b.reason], [true, null]);
  // the copy, not the draft: an attach recorded in the copy makes that group «have»
  const g = b.rows.find((r) => !r.have).group;
  const before = JSON.stringify(draftSource(d));
  IE.setGroupAttached(s, g, true);
  assert.equal(IE.attachSheet(d, s).rows.find((r) => r.group === g).have, true, 'the copy’s attach counts');
  assert.equal(JSON.stringify(draftSource(d)), before, 'the draft is untouched');
});
test('B — the dish action is refused by the WRITER’s own dry run on the copy: «Sin extras» on in the copy → «Tiene «Sin extras»»; a legacy option rule (5f XT-REFUSALS fixture) → «Sus opciones tienen reglas propias»', () => {
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  IE.set(s, 'extrasNone', true);
  assert.deepEqual([IE.attachSheet(d, s).canAdd, IE.attachSheet(d, s).reason], [false, 'Tiene «Sin extras»'], '«Sin extras» in the copy refuses it');
  IE.set(s, 'extrasNone', false);
  assert.equal(IE.attachSheet(d, s).canAdd, true, 'and back');
  const s0 = buildSourceFromCode('la_musa');
  s0.structure.exposure.item_overrides.noodle_01_pollo = { deny: ['Salsas'] };   // exactly catalog/exposure-transitions.test.js XT-REFUSALS
  const d2 = createDraft(canonicalize(s0));
  const b2 = IE.attachSheet(d2, drawer(d2, 'noodle_01'));
  assert.deepEqual([b2.canAdd, b2.reason], [false, 'Sus opciones tienen reglas propias'], 'an option rule refuses it');
});
test('B — attachSheet is a PURE reader (the wiring guards rule it so): a deep-frozen draft and copy, byte-identical after', () => {
  'use strict';
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  IE.setGroupAttached(s, 'Proteínas', true);
  const before = JSON.stringify([d, s]);
  deepFreeze(d); deepFreeze(s);
  assert.doesNotThrow(() => IE.attachSheet(d, s), 'no write into a frozen draft or copy');
  assert.equal(JSON.stringify([d, s]), before, 'the draft and the copy are byte-identical after');
});
test('B — «en N productos · {sección}» (advisor 11-12, MOCKUP frame B «· Pastas»): the section ONLY when every product using the group sits in ONE section that is NOT the dish\u2019s own; mixed ⇒ none', () => {
  const d = createDraft(seed('la_musa'));
  const src = draftSource(d);
  const P = EE.projectEligibility(src), E = XT.effectiveGroups(P);
  const sectionsOf = (g) => new Set(Object.keys(E).filter((k) => !P.items[k].launcherKey && (E[k] || []).includes(g)).map((k) => String(src.items.find((r) => r.key === k).display.cat)));
  const rows = IE.attachSheet(d, drawer(d, 'dimsum_01')).rows;
  const one = rows.find((r) => sectionsOf(r.group).size === 1), mixed0 = rows.find((r) => sectionsOf(r.group).size > 1);
  // the mixed group read from a dish OUTSIDE its first section (from inside it, the own-section rule alone would also say null)
  const firstSec = mixed0 && [...sectionsOf(mixed0.group)][0];
  const outsider = Object.keys(E).find((k) => !P.items[k].launcherKey && String(src.items.find((r) => r.key === k).display.cat) !== firstSec);
  const mixed = outsider && IE.attachSheet(d, drawer(d, outsider)).rows.find((r) => r.group === mixed0.group);
  assert.ok(one && mixed, 'non-vacuity: both cases in the seed');
  const cat = [...sectionsOf(one.group)][0];
  assert.equal(one.section, src.structure.categories.find((c) => String(c.id) === cat).name, 'one section ⇒ its name');
  assert.equal(mixed.section, null, 'mixed sections ⇒ no suffix');
  // advisor 11-12 (the narrower rule, frame B): a one-section group on the dish's OWN section ⇒ no suffix
  const ownKey = Object.keys(E).find((k) => !P.items[k].launcherKey && (E[k] || []).includes(one.group) && String(src.items.find((r) => r.key === k).display.cat) === cat);
  assert.ok(ownKey, 'non-vacuity: a dish of that section using the group');
  assert.equal(IE.attachSheet(d, drawer(d, ownKey)).rows.find((r) => r.group === one.group).section, null, 'the dish\u2019s own section ⇒ no suffix');
});
test('A — «Quitar de este producto» is refused only by the WRITER’s own dry run on the copy: a legacy option rule (5f XT-REFUSALS) → «Sus opciones tienen reglas propias»; otherwise allowed; the dry run writes nothing', () => {
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  const before = JSON.stringify([draftSource(d), s.ops]);
  assert.equal(IE.detachRefusal(d, s, 'Salsas'), null, 'a plain dish may drop a group');
  assert.equal(JSON.stringify([draftSource(d), s.ops]), before, 'the dry run writes nothing');
  const s0 = buildSourceFromCode('la_musa');
  s0.structure.exposure.item_overrides.noodle_01_pollo = { deny: ['Salsas'] };   // exactly catalog/exposure-transitions.test.js XT-REFUSALS
  const d2 = createDraft(canonicalize(s0));
  assert.equal(IE.detachRefusal(d2, drawer(d2, 'noodle_01'), 'Salsas'), 'Sus opciones tienen reglas propias', 'an option rule refuses it, in words');
});
test('A — detachRefusal is a PURE reader (the wiring guards rule it so): a deep-frozen draft and copy, byte-identical after', () => {
  'use strict';
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  const d = createDraft(seed('la_musa'));
  const s = drawer(d, 'dimsum_01');
  IE.setGroupAttached(s, 'Proteínas', true);
  const before = JSON.stringify([d, s]);
  deepFreeze(d); deepFreeze(s);
  assert.doesNotThrow(() => IE.detachRefusal(d, s, 'Salsas'), 'no write into a frozen draft or copy');
  assert.equal(JSON.stringify([d, s]), before, 'the draft and the copy are byte-identical after');
});
test('Estructura — an extra removed and one added: the «Quitado» / «Nuevo» rows ONLY; never ALSO a «Se eliminan» / «Se agregan» line (SBS 11-12: «Elimina rice_chinese» showed a raw key twice)', async () => {
  const live = seed('la_musa'); const d = createDraft(clone(live));
  const gone = clone(draftSource(d).extras.find((e) => e.display.cat === 'Acompañamientos'));
  assert.equal(applyExposureOps(d, [{ op: 'extra.remove', key: gone.key }, { op: 'extra.add', group: 'Salsas', ref: 'tmp:sbs-new-0001', name: 'Salsa de mango', price: 25 }], ON).ok, true);
  const diff = await realSaveDiff('la_musa', live, draftSource(d));
  if (process.env.S2_DUMP) console.log(JSON.stringify({ removed: diff.removed, added: diff.added, extras: diff.extras }));
  const m = reviewModel(diff, ctxOf(draftSource(d)));
  assert.deepEqual(rowsText(m).filter((t) => /Quitado|Nuevo/.test(t)).length, 2, 'premise: the two Estructura rows');
  assert.equal(m.removed.filter((r) => r && (r.key === gone.key || r.name === gone.display.name || r.label === gone.display.name)).length, 0, 'the removed extra is its «Quitado» row, not ALSO a «Se eliminan» line');
  const newKey = (diff.extras || []).find((x) => x.change === 'added').key;   // the server's generic entry carries the KEY only
  assert.equal(m.added.filter((r) => r && r.key === newKey).length, 0, 'the new extra is its «Nuevo» row, not ALSO a «Se agregan» line');
  assert.equal(m.total, 2, 'it counts each fact once');
});

// ── a «Nuevo» row's name (advisor 11-12): the inline row's field on a KEYLESS row only — keyed rows stay text (the S2b rename stays dark) ──
test('X — setExtraName renames a NEW (keyless) extra by its ref; never a keyed one; no key / id / stamp appears', async () => {
  const E = await import('./editor.js');
  const d = createDraft(seed('la_musa'));
  assert.equal(applyExposureOps(d, [{ op: 'extra.add', group: 'Salsas', ref: 'tmp:rename-0001', name: 'Salsa de mango', price: 25 }], ON).ok, true);
  E.setExtraName(d, { ref: 'tmp:rename-0001' }, 'Salsa  de maracuyá');
  const row = draftSource(d).extras.find((x) => x.ref === 'tmp:rename-0001');
  assert.equal(row.display.name, 'Salsa de maracuyá', 'the keyless rename is in the draft (runs of spaces collapsed)');
  assert.ok(!('key' in row) && !('id' in row.display) && !('stamp' in row), 'no key, id or stamp: it is still a NEW extra');
  const keyed = draftSource(d).extras.find((x) => typeof x.key === 'string');
  const before = JSON.stringify(draftSource(d));
  E.setExtraName(d, { key: keyed.key }, 'Otro');
  E.setExtraName(d, keyed.key, 'Otro');
  E.setExtraName(d, { ref: keyed.key }, 'Otro');
  assert.equal(JSON.stringify(draftSource(d)), before, 'a keyed (published) extra is never renamed here');
});

// ── P-6 extraRefs (plan r3 §3.3, Codex r2 #5): after a save, a NEW extra is re-keyed ONLY through the server's extraRefs — never a name match ──
test('P-6 — rekeyId: a ref the map names → its allocated key; a ref the map does NOT name → dropped (never a guess); a key → itself', async () => {
  const { rekeyId } = await import('./extras-logic.js');
  const map = { 'tmp:a-0001': 'arroz_probe' };
  assert.deepEqual(rekeyId({ ref: 'tmp:a-0001' }, map), { key: 'arroz_probe' });
  assert.equal(rekeyId({ ref: 'tmp:zz-0009' }, map), null, 'an unmapped ref is dropped, nothing mis-keyed');
  assert.equal(rekeyId({ ref: 'tmp:a-0001' }, null), null, 'no map: dropped');
  assert.deepEqual(rekeyId({ key: 'rice_white' }, map), { key: 'rice_white' });
});
test('P-6 — «  Probe   extra  » saved through 5f\u2019s REAL handler: extraRefs maps its ref; after adoption the SAME row (same price), keyed, still «Nuevo» (unpublished)', async () => {
  const { extrasPageModel, rekeyId } = await import('./extras-logic.js');
  const live = seed('la_musa'); const d = createDraft(clone(live));
  assert.equal(applyExposureOps(d, [{ op: 'extra.add', group: 'Salsas', ref: 'tmp:probe-0001', name: '  Probe   extra  ', price: 33 }], ON).ok, true);
  await realSaveDiff('la_musa', live, draftSource(d));
  const body = realSaveDiff.last;
  const key = body.extraRefs && body.extraRefs['tmp:probe-0001'];
  assert.ok(typeof key === 'string' && key, `the save answer maps the ref (${JSON.stringify(body.extraRefs)})`);
  const E = await import('./editor.js');
  E.adopt(d, body.source);
  const row = extrasPageModel(d, { group: 'Salsas' }).detail.rows.find((r) => r.id.key === key);
  assert.ok(row, 'adopted through extraRefs (Probe extra)');
  assert.deepEqual([row.price, row.isNew, row.removed], [33, true, false], 'the same price; still «Nuevo» until published');
  assert.deepEqual(rekeyId({ ref: 'tmp:probe-0001' }, body.extraRefs), { key }, 're-keyed by the map');
});
