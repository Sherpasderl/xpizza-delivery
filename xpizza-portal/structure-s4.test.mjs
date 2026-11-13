// STRUCTURE S4 — the «S4 portal writer», NON-DRAWING half (PLAN-portal-structure-S4-writer-r0, approved 2026-11-13; 5f's
// PLAN-structure-S4-r4 §R2.9). editor.js gains the sections mutators — each ALL OR NOTHING on one copy, refused `sections_off` unless the
// server's switch is `=== true`, then `not_editable` — and itemCategoryProblem accepts a STAGED target with the switch ON only.
// Real seeds (both brands, tools/seed-source-store, canonicalized as the server stores them). A NEW category's id is categorySlug's and
// its promotion position promotedOrder's — 5f's section-transitions.js, the portal's byte copy loaded as the page loads it; nothing here
// re-implements either rule.
// Run: node --test structure-s4.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { removeProduct, undoRemoveProduct, canRemoveProduct, pendingRenames, pendingSections, pendingCount, commit, setItemPrice } from './editor.js';
import { createDraft, draftSource, editItem, itemCategoryProblem, addCategory, renameCategory, dropStagedCategory, moveItem, addSubcat,
  renameSubcat, reorderSections, reorderSubcats, reorderItems } from './editor.js';

import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';
const freq = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
// the page's classic script (index.html): 5f's section rules, the portal's byte copy
runInThisContext(readFileSync(new URL('./section-transitions.js', import.meta.url), 'utf8'));
const { buildSourceFromCode } = freq('./tools/seed-source-store');
const { canonicalize } = freq('./catalog/source-store');
const clone = (v) => JSON.parse(JSON.stringify(v));
const seed = (rid) => canonicalize(buildSourceFromCode(rid));
const ON = { sections: true };
const bytes = (d) => JSON.stringify(draftSource(d));
const dishesOf = (src, cat) => src.items.filter((i) => i.display && i.display.cat === cat && i.display.variantOf == null).map((i) => i.key);
const catOf = (src, id) => src.structure.categories.find((c) => c.id === id);

test('the byte copy: xpizza-portal/section-transitions.js IS 5f\'s module, loaded by index.html right after choice-transitions.js', () => {
  const copy = readFileSync(new URL('./section-transitions.js', import.meta.url));
  assert.ok(copy.equals(readFileSync(new URL('../xpizza-functions/catalog/section-transitions.js', import.meta.url))), 'byte-identical (tools/sync-client)');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const c = html.indexOf('<script src="choice-transitions.js"></script>'), x = html.indexOf('<script src="section-transitions.js"></script>');
  assert.ok(c !== -1 && x > c, 'after the choice writer');
  assert.equal(typeof globalThis.SectionTransitions.categorySlug, 'function');
});

// every mutator, called once with a plausible argument list (the OFF / not-editable cells call each one)
const CALLS = (src) => [
  ['addCategory', (d, o) => addCategory(d, 'Postres', {}, o)],
  ['renameCategory', (d, o) => renameCategory(d, src.structure.categories[0].id, 'Nombre nuevo', o)],
  ['dropStagedCategory', (d, o) => dropStagedCategory(d, 'postres', o)],
  ['moveItem', (d, o) => moveItem(d, dishesOf(src, src.structure.categories[0].id)[0], { cat: src.structure.categories[1].id, subcat: null }, o)],
  ['addSubcat', (d, o) => addSubcat(d, src.structure.categories[0].id, 'Clásicas', dishesOf(src, src.structure.categories[0].id), o)],
  ['renameSubcat', (d, o) => renameSubcat(d, 'bebidas', 'Sodas', 'Refrescos', o)],
  ['reorderSections', (d, o) => reorderSections(d, src.structure.categories.map((c) => c.id).reverse(), o)],
  ['reorderSubcats', (d, o) => reorderSubcats(d, 'bebidas', ['Cervezas', 'Sodas'], o)],
  ['reorderItems', (d, o) => reorderItems(d, [...src.structure.item_order].reverse(), o)],
];

for (const rid of ['la_musa', 'x_pizza']) {
  test(`OFF (${rid}): every S4 mutator refuses sections_off — switch absent, false, a truthy non-boolean — and writes nothing`, () => {
    const src = seed(rid);
    for (const [name, call] of CALLS(src)) {
      for (const opts of [undefined, {}, { sections: false }, { sections: 'true' }, { sections: 1 }]) {
        const d = createDraft(clone(src)); const before = bytes(d);
        assert.deepEqual(call(d, opts), { ok: false, code: 'sections_off' }, `🔴 ${name} OFF for ${JSON.stringify(opts)}`);
        assert.equal(bytes(d), before, `${name}: nothing written`);
      }
      const ro = createDraft(clone(src), { canEdit: () => false });
      assert.equal(call(ro, ON).code, 'not_editable', `${name}: a draft not owned for editing`);
    }
  });

  test(`OFF (${rid}): itemCategoryProblem answers exactly today's codes — the 4th argument absent or OFF changes nothing`, () => {
    const src = seed(rid); const d = createDraft(clone(src));
    const cats = src.structure.categories.map((c) => c.id);
    for (const key of [dishesOf(src, cats[0])[0], dishesOf(src, cats[cats.length - 1])[0]]) {
      for (const target of [...cats, 'postres', 'nope']) {
        for (const subcat of [null, 'Sodas', 'X']) {
          const today = itemCategoryProblem(d, key, { cat: target, subcat });
          assert.equal(itemCategoryProblem(d, key, { cat: target, subcat }, {}), today);
          assert.equal(itemCategoryProblem(d, key, { cat: target, subcat }, { sections: false }), today);
        }
      }
    }
  });
}

test('moveItem (ON) into a DECLARED section is today\'s move, byte for byte (editItem\'s), options included; emptying a section is refused', () => {
  const src = seed('la_musa');
  const key = dishesOf(src, 'noodles').find((k) => (src.structure.variant_items || {})[String(src.items.find((i) => i.key === k).display.id)]) || dishesOf(src, 'noodles')[0];
  const a = createDraft(clone(src)); const b = createDraft(clone(src));
  assert.deepEqual(moveItem(a, key, { cat: 'rice', subcat: null }, ON), { ok: true });
  assert.equal(editItem(b, key, { cat: 'rice', subcat: null }), true, 'premise: today\'s path accepts the same move');
  assert.equal(bytes(a), bytes(b), '🔴 the same source as today\'s move');
  // crudo has 3 dishes: moving all three out empties it
  const c = createDraft(clone(src));
  const [x, y, z] = dishesOf(src, 'crudo');
  assert.equal(moveItem(c, x, { cat: 'rice', subcat: null }, ON).ok, true);
  assert.equal(moveItem(c, y, { cat: 'rice', subcat: null }, ON).ok, true);
  const before = bytes(c);
  assert.deepEqual(moveItem(c, z, { cat: 'rice', subcat: null }, ON), { ok: false, code: 'section_empty' }, 'the last dish never leaves (section_emptied)');
  assert.equal(bytes(c), before);
  assert.equal(moveItem(c, x, { cat: 'bebidas', subcat: null }, ON).code, 'subcat_required', 'a grouped section needs a subsection');
});

test('addSubcat (ON): a 2nd subsection gets ≥ 1 member in the same op; empty → subcat_empty; a taken name (case-folded) → subcat_name_taken', () => {
  const src = seed('la_musa');
  const soda = dishesOf(src, 'bebidas').find((k) => src.items.find((i) => i.key === k).display.subcat === 'Sodas');
  const d = createDraft(clone(src));
  assert.deepEqual(addSubcat(d, 'bebidas', 'Jugos', [soda], ON), { ok: true });
  const out = draftSource(d);
  assert.deepEqual(catOf(out, 'bebidas').subcats, ['Sodas', 'Cervezas', 'Jugos']);
  assert.equal(out.items.find((i) => i.key === soda).display.subcat, 'Jugos', 'the member moved into it');
  for (const [args, code] of [[['Té', []], 'subcat_empty'], [['  sodas ', [soda]], 'subcat_name_taken'], [['Jugos', [soda]], 'subcat_name_taken'],
    [['', [soda]], 'subcat_name_invalid'], [['<b>', [soda]], 'subcat_name_invalid'], [['Té', ['dimsum_01']], 'subcat_member_invalid']]) {
    const before = bytes(d);
    assert.equal(addSubcat(d, 'bebidas', ...args, ON).code, code, `${JSON.stringify(args)} → ${code}`);
    assert.equal(bytes(d), before, 'nothing written');
  }
});

test('addSubcat (ON): the FIRST subsection of an ungrouped section must take EVERY dish of it (subcat_partial lists the missing)', () => {
  const src = seed('la_musa');
  const all = dishesOf(src, 'dim_sum');
  const d = createDraft(clone(src)); const before = bytes(d);
  assert.deepEqual(addSubcat(d, 'dim_sum', 'Al vapor', all.slice(1), ON), { ok: false, code: 'subcat_partial', missing: [all[0]] }, '🔴 one dish left out');
  assert.equal(bytes(d), before);
  assert.deepEqual(addSubcat(d, 'dim_sum', 'Al vapor', all, ON), { ok: true });
  const out = draftSource(d);
  assert.deepEqual(catOf(out, 'dim_sum').subcats, ['Al vapor']);
  assert.ok(all.every((k) => out.items.find((i) => i.key === k).display.subcat === 'Al vapor'));
});

test('renameSubcat (ON): the name AND every member (options too) rewritten exactly; nothing else changes', () => {
  const src = seed('la_musa');
  const d = createDraft(clone(src));
  assert.deepEqual(renameSubcat(d, 'bebidas', 'Sodas', 'Refrescos', ON), { ok: true });
  const out = draftSource(d);
  assert.deepEqual(catOf(out, 'bebidas').subcats, ['Refrescos', 'Cervezas']);
  const want = clone(src);
  want.structure.categories.find((c) => c.id === 'bebidas').subcats = ['Refrescos', 'Cervezas'];
  for (const i of want.items) if (i.display && i.display.cat === 'bebidas' && i.display.subcat === 'Sodas') i.display.subcat = 'Refrescos';
  assert.deepEqual(out, want, '🔴 exactly the rename');
  for (const [args, code] of [[['Nope', 'X'], 'subcat_unknown'], [['Cervezas', 'refrescos'], 'subcat_name_taken'], [['Cervezas', ''], 'subcat_name_invalid']]) {
    assert.equal(renameSubcat(d, 'bebidas', ...args, ON).code, code);
  }
});

test('reorder (ON): sections, subsections and dishes take a PERMUTATION only — anything else is refused and writes nothing', () => {
  const src = seed('la_musa');
  const ids = src.structure.categories.map((c) => c.id);
  const d = createDraft(clone(src));
  assert.deepEqual(reorderSections(d, [ids[1], ids[0], ...ids.slice(2)], ON), { ok: true });
  assert.deepEqual(draftSource(d).structure.categories.map((c) => c.id), [ids[1], ids[0], ...ids.slice(2)]);
  assert.deepEqual(reorderSubcats(d, 'bebidas', ['Cervezas', 'Sodas'], ON), { ok: true });
  assert.deepEqual(catOf(draftSource(d), 'bebidas').subcats, ['Cervezas', 'Sodas']);
  const order = draftSource(d).structure.item_order;
  assert.deepEqual(reorderItems(d, [order[1], order[0], ...order.slice(2)], ON), { ok: true });
  assert.deepEqual(draftSource(d).structure.item_order.slice(0, 2), [order[1], order[0]]);
  const before = bytes(d);
  for (const [fn, bad] of [[(x) => reorderSections(d, x, ON), [ids[0], ids[0], ...ids.slice(2)]], [(x) => reorderSections(d, x, ON), ids.slice(1)],
    [(x) => reorderSubcats(d, 'bebidas', x, ON), ['Sodas']], [(x) => reorderSubcats(d, 'bebidas', x, ON), ['Sodas', 'Jugos']],
    [(x) => reorderItems(d, x, ON), [...order, 'extra']], [(x) => reorderItems(d, x, ON), order.slice(1)]]) {
    assert.equal(fn(bad).code, 'not_permutation', `🔴 refused: ${JSON.stringify(bad).slice(0, 60)}`);
    assert.equal(bytes(d), before);
  }
});

test('renameCategory (ON) on a DECLARED section is today\'s T1 rename (setCategoryNames), byte for byte', () => {
  const src = seed('la_musa');
  const d = createDraft(clone(src));
  assert.deepEqual(renameCategory(d, 'crudo', 'Crudos', ON), { ok: true });
  assert.equal(catOf(draftSource(d), 'crudo').name, 'Crudos');
  assert.equal(moveItem(d, dishesOf(src, 'rice')[0], { cat: 'noodles', subcat: null }, ON).code, 'not_editable', 'T1: a pending rename publishes alone — content edits wait');
  const f = createDraft(clone(src));
  assert.equal(renameCategory(f, 'crudo', '', ON).code, 'category_name_invalid');
  assert.equal(renameCategory(f, 'crudo', '  noodles ', ON).code, 'category_name_taken', 'case-folded against the other sections');
  assert.equal(renameCategory(f, 'nope', 'X', ON).code, 'category_unknown');
  assert.equal(bytes(f), JSON.stringify(src), 'nothing written');
});

test('addCategory (ON): a staged entry with categorySlug\'s id, anchored after the last declared section', () => {
  const d = createDraft(clone(seed('la_musa')));
  assert.deepEqual(addCategory(d, 'Postres', {}, ON), { ok: true });
  assert.deepEqual(draftSource(d).structure.staged_categories, [{ id: 'postres', name: 'Postres', after: 'bebidas' }]);
});
test('moveItem (ON) into a STAGED section promotes it at promotedOrder\'s position and drops the staged entry, in one op', () => {
  const d = createDraft(clone(seed('la_musa')));
  addCategory(d, 'Postres', { after: 'dim_sum' }, ON);
  assert.deepEqual(moveItem(d, 'rice_01', { cat: 'postres', subcat: null }, ON), { ok: true });
  const out = draftSource(d);
  assert.equal(out.structure.categories[1].id, 'postres'); assert.deepEqual(out.structure.staged_categories, []);
});
test('promotion is per SAVE (5f R4.2): two staged on one anchor promoted in ONE save land A, B (stored staged order); in two saves, B lands before A', async () => {
  const { commit } = await import('./editor.js');
  const src = seed('la_musa');
  const [d1, d2] = [dishesOf(src, 'rice')[0], dishesOf(src, 'rice')[1]];
  // stored draft: A then B, both staged after dim_sum
  const stored = createDraft(clone(src));
  addCategory(stored, 'Alfa', { after: 'dim_sum' }, ON); addCategory(stored, 'Beta', { after: 'dim_sum' }, ON);
  const base = draftSource(stored);
  const one = createDraft(clone(base));
  assert.equal(moveItem(one, d1, { cat: 'beta', subcat: null }, ON).ok, true);   // B first, by hand
  assert.equal(moveItem(one, d2, { cat: 'alfa', subcat: null }, ON).ok, true);
  assert.deepEqual(draftSource(one).structure.categories.slice(0, 3).map((c) => c.id), ['dim_sum', 'alfa', 'beta'], '🔴 one save: A, B whatever the move order');
  const fwd = createDraft(clone(base));
  assert.equal(moveItem(fwd, d1, { cat: 'alfa', subcat: null }, ON).ok, true);   // A first, then B — per-move promotion would give B, A
  assert.equal(moveItem(fwd, d2, { cat: 'beta', subcat: null }, ON).ok, true);
  assert.deepEqual(draftSource(fwd).structure.categories.slice(0, 3).map((c) => c.id), ['dim_sum', 'alfa', 'beta'], '🔴 one save: A, B whatever the move order (A first)');
  const two = createDraft(clone(base));
  assert.equal(moveItem(two, d1, { cat: 'alfa', subcat: null }, ON).ok, true);
  commit(two);                                                                    // the save: the stored draft now has A declared
  assert.equal(moveItem(two, d2, { cat: 'beta', subcat: null }, ON).ok, true);
  assert.deepEqual(draftSource(two).structure.categories.slice(0, 3).map((c) => c.id), ['dim_sum', 'beta', 'alfa'], 'two saves: B lands right after its anchor');
});

test('itemCategoryProblem (ON): a STAGED section is a valid target (no subsection); renameCategory / dropStagedCategory act on staged entries', () => {
  const d = createDraft(clone(seed('la_musa')));
  addCategory(d, 'Postres', {}, ON);
  assert.equal(itemCategoryProblem(d, 'rice_01', { cat: 'postres', subcat: null }, ON), null);
  assert.equal(itemCategoryProblem(d, 'rice_01', { cat: 'postres', subcat: null }), 'unknown', 'OFF: today\'s answer');
  assert.deepEqual(renameCategory(d, 'postres', 'Dulces', ON), { ok: true });
  assert.deepEqual(dropStagedCategory(d, 'postres', ON), { ok: true });
  assert.deepEqual(draftSource(d).structure.staged_categories, []);
});

// ── advisor rulings 11-13 on the S4 addendum: 3(a) un-promote, 3(b) the live-section check, 6 pendingSections ──
// stamps as remove-product.test.mjs's pure cells set them (the real bootstrap's shape: one per row)
const stamped = (rid) => { const x = seed(rid); for (const it of x.items) it.display.identity_id = `sid_${it.key}`; return x; };
const liveOrderOf = (x) => ({ items: [...x.structure.item_order], rewards: [...(x.structure.redeem_eligible_items || [])] });
const RM = (x, extra = {}) => ({ on: true, baseReadable: true, liveOrder: liveOrderOf(x), sections: true, ...extra });
const withStaged = (src, names) => { const d = createDraft(clone(src)); for (const [n, after] of names) addCategory(d, n, { after }, ON); return draftSource(d); };

test('pendingRenames: a section promoted in this draft is NEW, never a rename — editing stays open after a promotion', () => {
  const base = withStaged(seed('la_musa'), [['Alfa', 'dim_sum']]);
  const d = createDraft(clone(base));
  assert.equal(moveItem(d, 'rice_01', { cat: 'alfa', subcat: null }, ON).ok, true);
  assert.deepEqual(pendingRenames(d), [], '🔴 no rename for a section the baseline lacks');
  assert.equal(moveItem(d, 'rice_02', { cat: 'noodles', subcat: null }, ON).ok, true, 'content edits continue');
});

test('3(a): removing the LAST dish of a section promoted in THIS draft un-promotes it in the same op — back to staged, its stored anchor; «Deshacer» promotes it again', () => {
  const base = stamped('la_musa');
  const stored = withStaged(base, [['Alfa', 'dim_sum']]);
  const d = createDraft(clone(stored));
  assert.equal(moveItem(d, 'rice_01', { cat: 'alfa', subcat: null }, ON).ok, true);
  const promoted = draftSource(d).structure.categories.map((c) => c.id);
  assert.ok(canRemoveProduct(d, 'rice_01', RM(stored)).enabled, 'the action is offered: the section is draft-only');
  const r = removeProduct(d, 'rice_01', RM(stored));
  assert.equal(r.ok, true);
  const out = draftSource(d);
  assert.ok(!out.structure.categories.some((c) => c.id === 'alfa'), '🔴 un-promoted: no longer declared');
  assert.deepEqual(out.structure.staged_categories, stored.structure.staged_categories, '🔴 back to staged exactly as stored (id, name, anchor)');
  assert.ok(!out.items.some((i) => i.key === 'rice_01'), 'the dish is removed');
  const u = undoRemoveProduct(d, 'rice_01', r.snap, liveOrderOf(stored), ON);
  assert.equal(u.ok, true);
  assert.deepEqual(draftSource(d).structure.categories.map((c) => c.id), promoted, '«Deshacer» promotes it again, at the same place');
  assert.deepEqual(draftSource(d).structure.staged_categories, []);
});

test('3(a): a section created AND promoted in this draft goes back to staged after the nearest section the stored draft declares', () => {
  const base = stamped('la_musa');
  const d = createDraft(clone(base));
  addCategory(d, 'Gamma', { after: 'crudo' }, ON);
  assert.equal(moveItem(d, 'rice_01', { cat: 'gamma', subcat: null }, ON).ok, true);
  assert.equal(removeProduct(d, 'rice_01', RM(base)).ok, true);
  assert.deepEqual(draftSource(d).structure.staged_categories, [{ id: 'gamma', name: 'Gamma', after: 'crudo' }]);
});

test('3(b): the LAST dish of a LIVE section — with the sections switch ON the action is shown disabled with section_empty; OFF it is today\'s (enabled)', () => {
  const base = stamped('la_musa');
  const d = createDraft(clone(base));
  const [x, y, z] = dishesOf(base, 'crudo');
  assert.equal(removeProduct(d, x, RM(base)).ok, true);
  assert.equal(removeProduct(d, y, RM(base)).ok, true);
  assert.deepEqual(canRemoveProduct(d, z, RM(base)), { show: true, enabled: false, code: 'section_empty' }, '🔴 ON: never a round trip to section_emptied');
  const before = bytes(d);
  assert.deepEqual(removeProduct(d, z, RM(base)), { ok: false, code: 'section_empty' }, 'the writer refuses too, nothing written');
  assert.equal(bytes(d), before);
  const { sections, ...off } = RM(base);
  assert.deepEqual(canRemoveProduct(d, z, off), { show: true, enabled: true, code: null }, 'OFF: today, byte for byte');
  assert.ok(canRemoveProduct(d, dishesOf(base, 'rice')[0], RM(base)).enabled, 'a section with other dishes: offered');
});

test('6: pendingSections — new / staged / dropped / renamed-staged sections, new / renamed subsections, section · subsection · dish order; counted by pendingCount', () => {
  const base = seed('la_musa');
  const d = createDraft(clone(base));
  assert.deepEqual(pendingSections(d), []);
  const n0 = pendingCount(d);
  addCategory(d, 'Postres', {}, ON);
  assert.deepEqual(pendingSections(d), [{ kind: 'category', id: 'postres', change: 'staged' }]);
  assert.equal(pendingCount(d), n0 + 1, '🔴 the bar sees it');
  addSubcat(d, 'dim_sum', 'Al vapor', dishesOf(base, 'dim_sum'), ON);
  renameSubcat(d, 'bebidas', 'Sodas', 'Refrescos', ON);
  const ids = base.structure.categories.map((c) => c.id);
  reorderSections(d, [ids[1], ids[0], ...ids.slice(2)], ON);
  reorderSubcats(d, 'bebidas', ['Cervezas', 'Refrescos'], ON);
  const o = draftSource(d).structure.item_order; reorderItems(d, [o[1], o[0], ...o.slice(2)], ON);
  assert.deepEqual(pendingSections(d), [
    { kind: 'category', id: 'postres', change: 'staged' },
    { kind: 'subcat', cat: 'dim_sum', change: 'new' }, { kind: 'subcat', cat: 'bebidas', change: 'rename' },
    { kind: 'order', what: 'sections' }, { kind: 'order', what: 'subcats', cat: 'bebidas' }, { kind: 'order', what: 'items' }]);
  // a stored staged entry renamed, another dropped; a promotion counts as a NEW section
  const stored = withStaged(base, [['Alfa', 'dim_sum'], ['Beta', 'dim_sum'], ['Gama', 'rice']]);
  const e = createDraft(clone(stored));
  renameCategory(e, 'alfa', 'Alfas', ON); dropStagedCategory(e, 'beta', ON);
  moveItem(e, 'rice_01', { cat: 'gama', subcat: null }, ON);
  assert.deepEqual(pendingSections(e), [{ kind: 'category', id: 'gama', change: 'new' }, { kind: 'category', id: 'alfa', change: 'name' }, { kind: 'category', id: 'beta', change: 'drop' }]);
});

test('6 OFF: today\'s edits (a price, a move between live sections, a category rename) add NOTHING to pendingSections', () => {
  const base = seed('la_musa');
  const a = createDraft(clone(base)); setItemPrice(a, 'rice_01', '999'); assert.deepEqual(pendingSections(a), []);
  const b = createDraft(clone(base)); editItem(b, 'rice_01', { cat: 'noodles', subcat: null }); assert.deepEqual(pendingSections(b), []);
  const c = createDraft(clone(base)); renameCategory(c, 'crudo', 'Crudos', ON); assert.deepEqual(pendingSections(c), [], 'a live rename is T1\'s (pendingRenames), not S4\'s');
});
