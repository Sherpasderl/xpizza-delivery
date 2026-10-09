'use strict';
// 1D add-product PHASE A — the pure halves (catalog/add-product.js): server allocation + the structural
// comparison, on the REAL code-seeded sources of both brands. Run: node catalog/add-product.test.js
const assert = require('assert');
const A = require('./add-product');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs, canonicalize, validateSource, rendererContract } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const build = (rid, src) => {
  const i = sourceToBuildInputs(src);
  const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable });
  return { items: b.items, extras: b.extras, structure: b.structure };
};
const SRC = { x_pizza: canonicalize(buildSourceFromCode('x_pizza')), la_musa: canonicalize(buildSourceFromCode('la_musa')) };
const MODE = { x_pizza: 'name', la_musa: 'id' };
const CAT = { x_pizza: 'ny', la_musa: 'noodles' };
const rc = (rid) => rendererContract(rid).renderedCategories;
const throwsCode = (fn, code, msg) => assert.throws(fn, (e) => e instanceof A.AddProductError && e.code === code, msg || code);
// A portal-shaped addition: a tmp ref, no key / id / stamp, appended to item_order.
const withFresh = (rid, src, adds) => {
  const s = clone(src);
  for (const a of adds) {
    const display = { cat: a.cat || CAT[rid], name: a.name, price: a.price || 500, ...(a.desc ? { desc: a.desc } : {}), ...(a.extra || {}) };
    s.items.push({ ref: a.ref, price: a.price || 500, display });
    s.structure.item_order.push(a.ref);
  }
  return s;
};
const alloc = (rid, incoming, { stored = SRC[rid], hwm = null, registry = new Set() } = {}) => A.allocateAdditions({
  incoming, stored, activeItems: SRC[rid].items, keyMode: MODE[rid], hwm, registryHasKey: (k) => registry.has(k),
});
const T1 = 'tmp:aaaaaaaa-0001'; const T2 = 'tmp:aaaaaaaa-0002';

{
  assert.strictEqual(A.normalizeName('  Pizza   ÚNICA '), 'pizza unica');
  assert.strictEqual(A.normalizeName('Margherita NY'), A.normalizeName('margherita  ny'));
  assert.strictEqual(A.slugify('Pad See Ew (Pollo)'), 'pad_see_ew_pollo');
  assert.strictEqual(A.slugify('Té Verde'), 'te_verde');
  assert.strictEqual(A.slugify('!!!'), '');
  assert.strictEqual(A.tidyName('  Plain   Slice '), 'Plain Slice');
  ok('names: case/accent/whitespace-folded comparison; slugs are ascii lowercase underscores; display names tidied');
}
{
  for (const rid of ['x_pizza', 'la_musa']) assert.strictEqual(A.resolveKeyMode(MODE[rid], SRC[rid].items), MODE[rid]);
  for (const bad of [undefined, null, '', 'slug', 1]) throwsCode(() => A.resolveKeyMode(bad, SRC.x_pizza.items), 'key_mode_unknown', `mode ${JSON.stringify(bad)}`);
  throwsCode(() => A.resolveKeyMode('id', SRC.x_pizza.items), 'key_mode_inconsistent', 'a profile that says id over a NAME-keyed menu');
  throwsCode(() => A.resolveKeyMode('name', SRC.la_musa.items), 'key_mode_inconsistent', 'a profile that says name over an ID-keyed menu');
  ok('key mode comes from DATA and is believed only if every live item agrees; unknown or inconsistent → additions refused (409)');
}
{
  // name-keyed brand: key = the tidied name, id = above every known id and the high-water mark
  const maxId = Math.max(...SRC.x_pizza.items.map((i) => i.display.id));
  let r;
  assert.doesNotThrow(() => { r = alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: '  NY  Probe ' }, { ref: T2, name: 'Second Probe', cat: 'individual' }])); }, 'two additions in one save get two DISTINCT ids');
  const added = r.source.items.slice(-2);
  assert.deepStrictEqual(added.map((i) => [i.key, i.display.id, i.display.name]), [['NY Probe', maxId + 1, 'NY Probe'], ['Second Probe', maxId + 2, 'Second Probe']]);
  assert.ok(added.every((i) => !('ref' in i)), 'the temporary reference is gone');
  assert.deepStrictEqual(r.source.structure.item_order.slice(-2), ['NY Probe', 'Second Probe'], 'item_order: tmp refs replaced by keys, in place');
  assert.strictEqual(r.hwm, maxId + 2); assert.deepStrictEqual(r.allocatedNow, ['NY Probe', 'Second Probe']);
  validateSource(r.source, 'x_pizza');
  // a high-water mark above every live id wins: ids are never reused, even after a discarded addition
  const r2 = alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'Hwm Probe' }]), { hwm: maxId + 40 });
  assert.strictEqual(r2.source.items.at(-1).display.id, maxId + 41); assert.strictEqual(r2.hwm, maxId + 41);
  // id-keyed brand: key = id = a slug; the high-water mark is not involved
  const l = alloc('la_musa', withFresh('la_musa', SRC.la_musa, [{ ref: T1, name: 'Pad Kee Mao' }]), { hwm: 7 });
  assert.deepStrictEqual([l.source.items.at(-1).key, l.source.items.at(-1).display.id], ['pad_kee_mao', 'pad_kee_mao']);
  assert.strictEqual(l.hwm, 7);
  validateSource(l.source, 'la_musa');
  assert.deepStrictEqual(withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'X' }]).items.at(-1).key, undefined, '(the input is untouched)');
  ok('allocation: name brands key by the tidied name with an id above max(live, draft, high-water mark); id brands key by a slug; tmp refs become keys in item_order; the result validates');
}
{
  // ALLOCATION HAPPENS ONCE: the saved (canonical) source comes back and keeps its keys and ids
  const first = alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'Stable Probe' }]));
  const again = alloc('x_pizza', clone(first.source), { stored: first.source, hwm: first.hwm });
  assert.deepStrictEqual(again.source, first.source, 'a second save allocates nothing new');
  assert.deepStrictEqual(again.allocatedNow, []); assert.strictEqual(again.hwm, first.hwm);
  // …and a price change on it is fine
  const priced = clone(first.source); priced.items.at(-1).price = 777; priced.items.at(-1).display.price = 777;
  assert.strictEqual(alloc('x_pizza', priced, { stored: first.source, hwm: first.hwm }).source.items.at(-1).price, 777);
  // but its allocation cannot be changed or invented
  const moved = clone(first.source); moved.items.at(-1).display.id += 5;
  throwsCode(() => alloc('x_pizza', moved, { stored: first.source }), 'client_supplied_key', 'an allocated id cannot move');
  throwsCode(() => alloc('x_pizza', clone(first.source), { stored: SRC.x_pizza }), 'client_supplied_key', 'a key the saved draft never allocated');
  ok('allocation is stable across saves: a saved addition keeps its key and id; changing or inventing one is refused');
}
{
  const f = (adds) => withFresh('x_pizza', SRC.x_pizza, adds);
  const s1 = f([{ ref: T1, name: 'P' }]); s1.items.at(-1).key = 'P';
  throwsCode(() => alloc('x_pizza', s1), 'client_supplied_key', 'a key on a fresh addition');
  const s2 = f([{ ref: T1, name: 'P' }]); s2.items.at(-1).display.id = 99;
  throwsCode(() => alloc('x_pizza', s2), 'client_supplied_key', 'an id on a fresh addition');
  const s3 = f([{ ref: T1, name: 'P' }]); s3.items.at(-1).display.identity_id = 'abc';
  throwsCode(() => alloc('x_pizza', s3), 'client_supplied_key', 'an identity stamp on a fresh addition');
  throwsCode(() => alloc('x_pizza', f([{ ref: 'tmp:x', name: 'P' }])), 'addition_malformed', 'a malformed tmp ref');
  throwsCode(() => alloc('x_pizza', f([{ ref: T1, name: 'P' }, { ref: T1, name: 'Q' }])), 'addition_malformed', 'a duplicated tmp ref');
  throwsCode(() => alloc('x_pizza', f([{ ref: T1, name: '   ' }])), 'name_required');
  const s4 = f([{ ref: T1, name: 'P' }]); s4.structure.item_order.pop();
  throwsCode(() => alloc('x_pizza', s4), 'item_order_ref_mismatch', 'a new product missing from item_order');
  const s5 = f([{ ref: T1, name: 'P' }]); s5.structure.item_order.push(T2);
  throwsCode(() => alloc('x_pizza', s5), 'item_order_ref_mismatch', 'item_order naming a ref no product has');
  const s6 = f([{ ref: T1, name: 'P' }]); s6.structure.item_order.push(T1);
  throwsCode(() => alloc('x_pizza', s6), 'item_order_ref_mismatch', 'a ref twice in item_order');
  throwsCode(() => alloc('x_pizza', f(Array.from({ length: 21 }, (_, i) => ({ ref: `tmp:bbbbbbbb-${String(i).padStart(4, '0')}`, name: `Many ${i}` })))), 'too_many_additions');
  assert.strictEqual(alloc('x_pizza', f(Array.from({ length: 20 }, (_, i) => ({ ref: `tmp:bbbbbbbb-${String(i).padStart(4, '0')}`, name: `Many ${i}` })))).allocatedNow.length, 20, 'exactly 20 is allowed');
  throwsCode(() => alloc('la_musa', withFresh('la_musa', SRC.la_musa, [{ ref: T1, name: '¡¡!!' }])), 'name_unusable', 'an id brand needs a sluggable name');
  ok('refused at allocation: client keys/ids/stamps, malformed or duplicated refs, empty names, item_order mismatches, more than 20 additions, unsluggable names');
}
{
  // collisions are ADDITION-scoped and folded
  const existing = SRC.x_pizza.items.find((i) => i.display.cat === 'ny').display.name;
  throwsCode(() => alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: `  ${existing.toUpperCase()} ` }])), 'name_taken', 'a live name, case/space-folded');
  throwsCode(() => alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'Dup One' }, { ref: T2, name: 'dup  one' }])), 'name_taken', 'two additions with one name');
  const extraName = SRC.x_pizza.extras[0].display.name;
  throwsCode(() => alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: extraName }])), 'name_taken', 'an addition named like an extra');
  const accented = SRC.la_musa.items.find((i) => /[áéíóúñ]/i.test(i.display.name));
  if (accented) throwsCode(() => alloc('la_musa', withFresh('la_musa', SRC.la_musa, [{ ref: T1, name: accented.display.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '') }])), 'name_taken', 'accent-folded');
  throwsCode(() => alloc('la_musa', withFresh('la_musa', SRC.la_musa, [{ ref: T1, name: SRC.la_musa.items[0].key.replace(/_/g, ' ') }])), 'key_taken', 'a slug equal to a live key');
  // the registry: a key row for the allocated key means the name was used before
  throwsCode(() => alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'Gone Pizza' }]), { registry: new Set(['Gone Pizza']) }), 'name_previously_used');
  throwsCode(() => alloc('la_musa', withFresh('la_musa', SRC.la_musa, [{ ref: T1, name: 'Gone Noodles' }]), { registry: new Set(['gone_noodles']) }), 'name_previously_used');
  // pre-existing duplicates (a dish and an extra sharing a name) are NOT ours to refuse
  const dupBase = clone(SRC.x_pizza); const dish0 = dupBase.items[0].display.name;
  dupBase.extras[0] = { ...dupBase.extras[0], display: { ...dupBase.extras[0].display } };
  assert.ok(alloc('x_pizza', withFresh('x_pizza', dupBase, [{ ref: T1, name: 'Unrelated New' }]), { stored: dupBase }).allocatedNow.length === 1, `an addition unrelated to "${dish0}" is fine`);
  ok('collisions (addition-scoped, folded): live names, another addition, extra names, live keys; a registry key row → "Ese nombre ya existió"; pre-existing duplicates untouched');
}

// ── the structural comparison, on real builds ────────────────────────────────────────────────────────────
const authored = (src) => new Set(Object.keys(src.structure));
const cmp = (rid, draftSrc, activeSrc = SRC[rid]) => A.compareToActive({
  draftBuilt: build(rid, draftSrc), activeBuilt: build(rid, activeSrc), draftAuthored: authored(draftSrc), renderedCategories: rc(rid),
});
const allocated = (rid, adds) => alloc(rid, withFresh(rid, SRC[rid], adds)).source;
{
  for (const rid of ['x_pizza', 'la_musa']) {
    assert.deepStrictEqual(cmp(rid, SRC[rid]).additions, [], `${rid}: no change → no additions`);
    const s = allocated(rid, [{ ref: T1, name: 'Plain Probe' }]);
    assert.deepStrictEqual(cmp(rid, s).additions, [s.items.at(-1).key], `${rid}: one appended product`);
    const priced = clone(s); priced.items[0].price += 10; priced.items[0].display.price = priced.items[0].price;
    priced.extras[0].price += 5; if (priced.extras[0].display && 'price' in priced.extras[0].display) priced.extras[0].display.price = priced.extras[0].price;
    assert.deepStrictEqual(cmp(rid, priced).additions, [s.items.at(-1).key], `${rid}: prices of existing items and extras may change alongside`);
  }
  ok('comparison: an unchanged menu, a plain append and price changes beside it pass, on both brands');
}
{
  const rid = 'la_musa';
  const ren = clone(SRC[rid]); ren.items[0].display.name += ' Nuevo';
  throwsCode(() => cmp(rid, ren), 'existing_item_changed', 'BLIND SPOT 1: a La Musa display-name rename (the key is the slug, so the price diff never saw it)');
  const lab = clone(SRC[rid]); lab.structure.categories[0].name += ' X';
  throwsCode(() => cmp(rid, lab), 'structure_changed', 'BLIND SPOT 2: a category label rename');
  const vm = clone(SRC[rid]); const L = Object.keys(vm.structure.variant_items)[0]; vm.structure.variant_items[L].label = 'Otra';
  throwsCode(() => cmp(rid, vm), 'structure_changed', 'BLIND SPOT 3: a variant-map change');
  const ex = clone(SRC[rid]); ex.extras[0].display.name += ' X';
  throwsCode(() => cmp(rid, ex), 'extras_changed', 'BLIND SPOT 4: an extra display-name rename');
  ok('the four probe-confirmed blind spots of the price diff are refused: La Musa display rename, category label, variant map, extra display name');
}
{
  const rid = 'x_pizza';
  const desc = clone(SRC[rid]); desc.items[0].display.desc = 'otra';
  throwsCode(() => cmp(rid, desc), 'existing_item_changed', 'a description');
  const cat = clone(SRC[rid]); cat.items[0].display.cat = cat.items[0].display.cat === 'ny' ? 'individual' : 'ny';
  throwsCode(() => cmp(rid, cat), 'existing_item_changed', 'a recategorized item');
  const rm = clone(SRC[rid]); const gone = rm.items.pop(); rm.structure.item_order = rm.structure.item_order.filter((k) => k !== gone.key);
  throwsCode(() => cmp(rid, rm), 'existing_item_removed');
  const ro = clone(SRC[rid]); [ro.structure.item_order[0], ro.structure.item_order[1]] = [ro.structure.item_order[1], ro.structure.item_order[0]];
  throwsCode(() => cmp(rid, ro), 'item_order_changed', 'a reorder of existing items');
  const mid = allocated(rid, [{ ref: T1, name: 'Mid Probe' }]); const k = mid.structure.item_order.pop(); mid.structure.item_order.splice(1, 0, k);
  throwsCode(() => cmp(rid, mid), 'item_order_changed', 'a new item inserted mid-menu');
  // (a SOURCE with an extra removed does not even build — the builder refuses the unnamed price — so the
  //  comparator's own rule is exercised on the built shape)
  const db0 = build(rid, SRC[rid]);
  throwsCode(() => A.compareToActive({ draftBuilt: { ...db0, extras: db0.extras.slice(0, -1) }, activeBuilt: build(rid, SRC[rid]), draftAuthored: authored(SRC[rid]), renderedCategories: rc(rid) }), 'extras_changed', 'an extra removed');
  throwsCode(() => A.compareToActive({ draftBuilt: { ...db0, extras: [...db0.extras, { key: 'New Extra', price: 10, display: { name: 'New Extra', price: 10 } }] }, activeBuilt: build(rid, SRC[rid]), draftAuthored: authored(SRC[rid]), renderedCategories: rc(rid) }), 'extras_changed', 'an extra added');
  const wk = clone(SRC[rid]); wk.structure.weekend_only_cats = [];
  throwsCode(() => cmp(rid, wk), 'structure_changed', 'the weekend rule');
  const stamp = clone(SRC[rid]); stamp.items[0].display.identity_id = 'forged';
  throwsCode(() => cmp(rid, stamp), 'existing_item_changed', 'a stamp the live item does not carry');
  // has_photo is a non-price field too (la_musa's builder carries it)
  const lm = clone(SRC.la_musa); lm.items[0].has_photo = !lm.items[0].has_photo;
  throwsCode(() => cmp('la_musa', lm), 'existing_item_changed', 'a has_photo toggle on an existing item');
  // the comparison's OWN cap (independent of the allocator's)
  const big = build(rid, SRC[rid]); const extra = Array.from({ length: 21 }, (_, i) => ({ key: `Cap ${i}`, price: 5, display: { id: 900 + i, cat: 'ny', name: `Cap ${i}`, price: 5 } }));
  throwsCode(() => A.compareToActive({ draftBuilt: { ...big, items: [...big.items, ...extra], structure: { ...big.structure, item_order: [...big.structure.item_order, ...extra.map((e) => e.key)] } },
    activeBuilt: build(rid, SRC[rid]), draftAuthored: authored(SRC[rid]), renderedCategories: rc(rid) }), 'too_many_additions', 'the comparison caps additions by itself');
  ok('existing items keep everything but price (desc, category, presence, order, has_photo); extras membership and structure (weekend rule) frozen; a forged stamp refused; the comparison caps additions on its own');
}
{
  const rid = 'x_pizza';
  const hidden = allocated(rid, [{ ref: T1, name: 'Hidden Probe' }]); hidden.items.at(-1).display.cat = 'bebidas_none';
  throwsCode(() => A.compareToActive({ draftBuilt: { ...build(rid, SRC[rid]), items: [...build(rid, SRC[rid]).items, hidden.items.at(-1)], structure: { ...build(rid, SRC[rid]).structure, item_order: [...SRC[rid].structure.item_order, hidden.items.at(-1).key] } },
    activeBuilt: build(rid, SRC[rid]), draftAuthored: authored(SRC[rid]), renderedCategories: rc(rid) }), 'category_not_renderable', 'a category the form never draws');
  const notDrawn = allocated(rid, [{ ref: T1, name: 'Drawn Probe' }]);
  throwsCode(() => A.compareToActive({ draftBuilt: build(rid, notDrawn), activeBuilt: build(rid, SRC[rid]), draftAuthored: authored(notDrawn), renderedCategories: ['individual'] }), 'category_not_renderable', 'ny not in the drawn set');
  throwsCode(() => A.compareToActive({ draftBuilt: build(rid, notDrawn), activeBuilt: build(rid, SRC[rid]), draftAuthored: authored(notDrawn), renderedCategories: [] }), 'category_not_renderable', 'an empty contract → nothing is addable');
  const ch = allocated(rid, [{ ref: T1, name: 'Choice Probe', extra: { choice: 'Roja' } }]);
  throwsCode(() => cmp(rid, ch), 'choices_not_supported_yet', 'a choice on a new product');
  const lm = alloc('la_musa', withFresh('la_musa', SRC.la_musa, [{ ref: T1, name: 'Variant Probe', extra: { variantOf: Object.keys(SRC.la_musa.structure.variant_items)[0] } }])).source;
  throwsCode(() => cmp('la_musa', lm), 'choices_not_supported_yet', 'variantOf on a new product');
  const st = allocated(rid, [{ ref: T1, name: 'Stamp Probe' }]); st.items.at(-1).display.identity_id = 'x';
  throwsCode(() => cmp(rid, st), 'client_supplied_key', 'a stamp on a new product');
  ok('additions: only to a DRAWN category (contract; empty contract → none); no choices / variantOf (Phase B); no identity stamp');
}
{
  // code-derivable fields are compared only when the draft AUTHORS them (a later code change must not refuse every save)
  const rid = 'x_pizza';
  const draftBuilt = build(rid, SRC[rid]); const activeBuilt = build(rid, SRC[rid]);
  activeBuilt.structure = { ...activeBuilt.structure, redeem_eligible_cats: ['individual', 'something_else'] };
  throwsCode(() => A.compareToActive({ draftBuilt, activeBuilt, draftAuthored: authored(SRC[rid]), renderedCategories: rc(rid) }), 'structure_changed', 'authored → compared');
  const unauth = new Set([...authored(SRC[rid])].filter((f) => f !== 'redeem_eligible_cats'));
  assert.deepStrictEqual(A.compareToActive({ draftBuilt, activeBuilt, draftAuthored: unauth, renderedCategories: rc(rid) }).additions, [], 'not authored → derived from code, not compared');
  // …and dropping an authored field is caught by the authored-set check instead
  const s = clone(SRC[rid]); delete s.structure.redeem_eligible_cats;
  throwsCode(() => A.assertSameAuthoredFields(s.structure, SRC[rid].structure), 'structure_changed', 'an authored field dropped');
  A.assertSameAuthoredFields(clone(SRC[rid]).structure, SRC[rid].structure);
  ok('code-derivable structure fields are compared only when authored; dropping an authored field is refused by the authored-set check');
}
{
  // ADVISOR RULING (A), 2026-10-09: ADD-ONLY for portal-authored changes; the pre-existing D4-P1 server-owned
  // deletion claim is preserved — a live item whose identity stamp is DECLARED may be absent, nothing else.
  const rid = 'x_pizza';
  const stamped = clone(SRC[rid]); stamped.items.forEach((it, i) => { it.display.identity_id = `id_${i}`; });
  const activeBuilt = build(rid, stamped);
  const gone = stamped.items.at(-1);
  const removed = clone(stamped); removed.items.pop(); removed.structure.item_order = removed.structure.item_order.filter((k) => k !== gone.key);
  const C = (draftSrc, deletedIds) => A.compareToActive({ draftBuilt: build(rid, draftSrc), activeBuilt, draftAuthored: authored(draftSrc), renderedCategories: rc(rid), deletedIds });
  throwsCode(() => C(removed, new Set()), 'existing_item_removed', 'an UNDECLARED removal is refused');
  throwsCode(() => C(removed, new Set(['id_0'])), 'existing_item_removed', 'declaring a DIFFERENT item does not license this removal');
  assert.deepStrictEqual(C(removed, new Set([gone.display.identity_id])), { additions: [], removals: [gone.key] }, 'a DECLARED removal is allowed');
  assert.deepStrictEqual(C(removed, [gone.display.identity_id]).removals, [gone.key], '(an array claim works the same)');
  assert.deepStrictEqual(C(stamped, new Set([gone.display.identity_id])), { additions: [], removals: [] }, 'a declared item still present is simply not removed');
  // a declared removal + a plain addition: accepted only when each half passes its own checks
  const mixed = alloc(rid, withFresh(rid, removed, [{ ref: T1, name: 'Mixed Probe' }]), { stored: removed }).source;
  assert.deepStrictEqual(C(mixed, new Set([gone.display.identity_id])), { additions: ['Mixed Probe'], removals: [gone.key] }, 'both halves pass → accepted, deterministically');
  const mixedBad = clone(mixed); mixedBad.items.at(-1).display.cat = 'individual'; mixedBad.items[0].display.desc = 'cambiada';
  throwsCode(() => C(mixedBad, new Set([gone.display.identity_id])), 'existing_item_changed', 'a declared removal does not license any other change');
  const mixedHidden = clone(mixed);
  throwsCode(() => A.compareToActive({ draftBuilt: build(rid, mixedHidden), activeBuilt, draftAuthored: authored(mixedHidden), renderedCategories: ['individual'], deletedIds: new Set([gone.display.identity_id]) }),
    'category_not_renderable', 'an addition failing its own check is refused even beside a valid declared removal');
  // the surviving order may not move either
  const swapped = clone(removed); [swapped.structure.item_order[0], swapped.structure.item_order[1]] = [swapped.structure.item_order[1], swapped.structure.item_order[0]];
  throwsCode(() => C(swapped, new Set([gone.display.identity_id])), 'item_order_changed', 'a removal does not license a reorder');
  ok('D4-P1 preserved (ruling A): undeclared or mis-declared removal refused; a declared removal allowed; declared+additions accepted only when both halves pass; no other change licensed');
}
{
  // ADVISOR (checkpoint review): add-product.js READS identity stamps for its ADD-ONLY checks and must never WRITE or
  // KEY by them. Proven on the syntax tree: the module requires nothing (no datastore handle, so it cannot write); no
  // `identity_id` is ever an assignment / update target or an object-literal key; and what it RETURNS is item keys.
  const acorn = require('acorn');
  const src = require('fs').readFileSync(require.resolve('./add-product'), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const requires = []; const writes = []; const keys = []; let reads = 0;
  const isIdentity = (node) => node && ((node.type === 'MemberExpression' && !node.computed && node.property.name === 'identity_id')
    || (node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal' && node.property.value === 'identity_id'));
  (function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') requires.push(node.loc.start.line);
    if (node.type === 'AssignmentExpression' && isIdentity(node.left)) writes.push(node.loc.start.line);
    if (node.type === 'UpdateExpression' && isIdentity(node.argument)) writes.push(node.loc.start.line);
    if (node.type === 'UnaryExpression' && node.operator === 'delete' && isIdentity(node.argument)) writes.push(node.loc.start.line);
    if (node.type === 'Property' && !node.computed && ((node.key.type === 'Identifier' && node.key.name === 'identity_id') || (node.key.type === 'Literal' && node.key.value === 'identity_id'))) keys.push(node.loc.start.line);
    if (isIdentity(node)) reads += 1;
    for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, node)); else if (v && typeof v.type === 'string' && k !== 'loc') walk(v, node); }
  })(ast, null);
  assert.deepStrictEqual(requires, [], 'add-product.js requires NOTHING — it holds no datastore handle, so it cannot write');
  assert.deepStrictEqual(writes, [], 'no identity_id is ever assigned, updated or deleted');
  assert.deepStrictEqual(keys, [], 'no object the module builds carries an identity_id key');
  assert.ok(reads > 0, '(and it does read stamps — the check is not vacuous)');
  // the RETURNED keys are item keys, never stamps (a declared removal comes back as the item's key)
  const st = clone(SRC.x_pizza); st.items.forEach((it, i) => { it.display.identity_id = `id_${i}`; });
  const rm = clone(st); const gone = rm.items.pop(); rm.structure.item_order = rm.structure.item_order.filter((k) => k !== gone.key);
  const out = A.compareToActive({ draftBuilt: build('x_pizza', rm), activeBuilt: build('x_pizza', st), draftAuthored: authored(rm), renderedCategories: rc('x_pizza'), deletedIds: [gone.display.identity_id] });
  assert.deepStrictEqual(out.removals, [gone.key]); assert.ok(!out.removals.includes(gone.display.identity_id));
  ok(`identity: add-product.js requires nothing, never assigns / updates / deletes / keys an identity_id (${reads} read sites), and returns item KEYS, never stamps`);
}
{
  // 🔴 FIELD-MAPPED, AND IN AGREEMENT WITH THE VALIDATOR. The pre-check is the validator's OWN per-field rule (injected
  // display-safety checkValue + the subcategory coverage), so for every value: refused here ⇔ refused by validateSource.
  const { checkValue, FIELD_SINKS } = require('./display-safety');
  const fieldProblem = (f, v) => checkValue(v, FIELD_SINKS.item[f]);
  const allocChecked = (rid, incoming) => A.allocateAdditions({ incoming, stored: SRC[rid], activeItems: SRC[rid].items, keyMode: MODE[rid], hwm: null,
    registryHasKey: () => false, fieldProblem });
  const validatorRefuses = (rid, incoming) => { try { validateSource(alloc(rid, incoming).source, rid); return false; } catch (e) { return !(e instanceof A.AddProductError); } };
  const cases = [];
  for (const name of ["Mike's Special", 'Pizza "La Especial"', 'Back`tick', 'Menor < que', 'Ent &lt; idad', 'Ñandú Picante', 'Pizza 2x1 & Más']) cases.push({ name });
  for (const desc of ['con <b>queso</b>', 'con "comillas" y apóstrofo\'s', 'a &gt; b', 'Ingredientes, porción']) cases.push({ name: 'Con Desc', desc });
  let refused = 0;
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const c of cases) {
      const inc = withFresh(rid, SRC[rid], [{ ref: T1, ...c }]);
      let pre = null; try { allocChecked(rid, inc); } catch (e) { pre = e; }
      const val = validatorRefuses(rid, inc);
      assert.strictEqual(!!pre, val, `${rid} ${JSON.stringify(c)}: pre-check ${pre ? pre.code : 'passes'} but validator ${val ? 'refuses' : 'accepts'}`);
      if (pre) {
        refused += 1;
        assert.deepStrictEqual([pre.code, pre.ref, pre.field], ['text_unsafe', T1, c.desc ? 'desc' : 'name'], `${JSON.stringify(c)} names its row and field`);
      }
    }
  }
  assert.ok(refused >= 6 && refused < cases.length * 2, `the matrix exercises both outcomes (${refused} refused)`);
  // subcategories (la_musa bebidas groups by subsections; noodles declares none)
  const sub = (cat, subcat) => withFresh('la_musa', SRC.la_musa, [{ ref: T1, name: 'Nueva Bebida', cat, extra: subcat === undefined ? {} : { subcat } }]);
  for (const [cat, subcat, bad] of [['bebidas', undefined, true], ['bebidas', 'Nope', true], ['bebidas', 'Sodas', false], ['noodles', 'Sodas', true], ['noodles', undefined, false]]) {
    let pre = null; try { allocChecked('la_musa', sub(cat, subcat)); } catch (e) { pre = e; }
    // the VALIDATOR's own verdict on the same row: allocate a row that passes, then give it this case's subsection
    const okSub = cat === 'bebidas' ? 'Sodas' : undefined;
    const placed = alloc('la_musa', sub(cat, okSub)).source;
    const row = placed.items.at(-1);
    if (subcat === undefined) delete row.display.subcat; else row.display.subcat = subcat;
    let val = false; try { validateSource(placed, 'la_musa'); } catch (_) { val = true; }
    assert.strictEqual(val, bad, `premise: the validator ${bad ? 'refuses' : 'accepts'} ${cat}/${subcat}`);
    assert.deepStrictEqual(pre ? [pre.code, pre.ref, pre.field] : null, bad ? ['subcat_invalid', T1, 'subcat'] : null, `${cat}/${subcat}`);
  }
  // 🔴 every refusal after allocation names the TMP reference the portal still holds — never only a key that may be an
  // EXISTING product's (x_pizza keys by name: "Pizza" typed again would otherwise point at the live "Pizza")
  const live0 = SRC.x_pizza.items[0];
  const e1 = (() => { try { alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: live0.display.name }])); } catch (e) { return e; } return null; })();
  assert.deepStrictEqual([e1 && e1.code, e1 && e1.ref, e1 && e1.key], ['name_taken', T1, live0.key], 'name_taken carries the ref beside the (existing) key');
  const e2 = (() => { try { alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'Usado Antes' }]), { registry: new Set(['Usado Antes']) }); } catch (e) { return e; } return null; })();
  assert.deepStrictEqual([e2 && e2.code, e2 && e2.ref], ['name_previously_used', T1]);
  const e3 = (() => { try { alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'Doble' }, { ref: T2, name: 'doble' }])); } catch (e) { return e; } return null; })();
  assert.ok(e3 && e3.code === 'name_taken' && [T1, T2].includes(e3.ref), 'two additions colliding: the refusal names one of THEIR refs');
  const r = alloc('x_pizza', withFresh('x_pizza', SRC.x_pizza, [{ ref: T1, name: 'Mapeada' }]));
  assert.deepStrictEqual(r.refs, { Mapeada: T1 }, 'the allocation returns key → ref for the handler to attribute later refusals');
  ok(`field-mapped: an unusable name/desc (text_unsafe) and a wrong subsection (subcat_invalid) are refused on THEIR row, in exact agreement with the validator (${refused} of ${cases.length * 2} text cases refused); every post-allocation refusal names the tmp ref`);
}
console.log(`\nadd-product: OK (${n})`);
