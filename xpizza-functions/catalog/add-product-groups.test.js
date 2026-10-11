'use strict';
// 1D add-product B (rev 6, UNIFORM) — required-choice GROUPS in the add-only core, on BOTH brands with the same fixture
// shape. Run: node catalog/add-product-groups.test.js
const assert = require('assert');
const A = require('./add-product');
const { canonicalize, validateSource, sourceToBuildInputs, rendererContract } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { checkValue, FIELD_SINKS } = require('./display-safety');
const { groupIndexFrom } = require('./group-index');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const SRC = { x_pizza: canonicalize(buildSourceFromCode('x_pizza')), la_musa: canonicalize(buildSourceFromCode('la_musa')) };
const MODE = { x_pizza: 'name', la_musa: 'id' };
const CAT = { x_pizza: 'ny', la_musa: 'noodles' };
// the handler's own mapping (edit-catalog-handler.js): item sinks, else the group label/prompt sink
const fieldProblem = (f, v) => checkValue(v, Object.prototype.hasOwnProperty.call(FIELD_SINKS.item, f) ? FIELD_SINKS.item[f] : FIELD_SINKS.variant.label);
const build = (rid, src) => { const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras }); return { items: b.items, extras: b.extras, structure: b.structure }; };
const L = 'tmp:llllllll-0001'; const V = ['tmp:vvvvvvvv-0001', 'tmp:vvvvvvvv-0002', 'tmp:vvvvvvvv-0003'];

// a portal-shaped group: a launcher + options, tmp refs in BOTH namespaces, nothing the server owns
function withGroup(rid, { choices = ['Salsa Roja', 'Salsa Vodka', 'Combinada'], prices = [624, 624, 624], label = 'Salsa', name = 'NY Plain Slice', launcherExtra = {}, variantExtra = [] } = {}) {
  const s = clone(SRC[rid]);
  s.items.push({ ref: L, price: 1, display: { cat: CAT[rid], name, price: 1, desc: 'La clásica', ...launcherExtra } });
  s.structure.item_order.push(L);
  choices.forEach((ch, i) => {
    s.items.push({ ref: V[i], price: prices[i], display: { choice: ch, variantOf: L, price: prices[i], ...(variantExtra[i] || {}) } });
    s.structure.item_order.push(V[i]);
  });
  s.structure.variant_items = { ...(s.structure.variant_items || {}), [L]: { label, variantIds: V.slice(0, choices.length) } };
  return s;
}
const alloc = (rid, incoming, { authoring = true, hwm = null, history = new Set() } = {}) => A.allocateAdditions({
  incoming, stored: SRC[rid], activeItems: SRC[rid].items, keyMode: MODE[rid], hwm, registryHasKey: (k) => history.has(k), fieldProblem, authoring });
const refusesWith = (fn, code, ref, field, why) => assert.throws(fn, (e) => e instanceof A.AddProductError && e.code === code && e.ref === ref && e.field === field,
  `${why} → ${code} {ref:${ref}, field:${field}}`);
const cmp = (rid, src, authoring = true) => A.compareToActive({ draftBuilt: build(rid, src), activeBuilt: build(rid, SRC[rid]),
  draftAuthored: Object.keys(src.structure), renderedCategories: rendererContract(rid).renderedCategories, authoring });

{
  for (const rid of ['x_pizza', 'la_musa']) {
    refusesWith(() => alloc(rid, withGroup(rid), { authoring: false }), 'choices_not_supported_yet', V[0], 'choices', `${rid}: authoring OFF`);
  }
  ok('authoring OFF: a well-formed new group is refused for EVERY brand, naming a tmp ref the portal holds');
}

{
  for (const rid of ['x_pizza', 'la_musa']) {
    const r = alloc(rid, withGroup(rid, { prices: [600, 650, 700], launcherExtra: { extras_policy: 'none' } }));
    const s = r.source;
    const items = s.items.slice(-4);
    const [launcher, ...vs] = items;
    const nm = ['NY Plain Slice - Salsa Roja', 'NY Plain Slice - Salsa Vodka', 'NY Plain Slice - Combinada'];
    assert.deepStrictEqual(vs.map((v) => v.display.name), nm, `${rid}: each option's name is DERIVED "{launcher} - {choice}"`);
    if (MODE[rid] === 'name') {
      assert.deepStrictEqual(items.map((i) => i.key), ['NY Plain Slice', ...nm], 'name-keyed: keys = names');
      const base = Math.max(...SRC[rid].items.map((i) => i.display.id));
      assert.deepStrictEqual(items.map((i) => i.display.id), [base + 1, base + 2, base + 3, base + 4], 'numeric display ids, one per record, above the high-water mark');
    } else {
      assert.deepStrictEqual(items.map((i) => i.key), ['ny_plain_slice', 'ny_plain_slice_salsa_roja', 'ny_plain_slice_salsa_vodka', 'ny_plain_slice_combinada'], 'id-keyed: slugs');
      assert.deepStrictEqual(items.map((i) => i.display.id), items.map((i) => i.key), 'id-keyed: display id = key');
    }
    // the TWO namespaces, each rewritten in its own terms (§0b.2)
    assert.deepStrictEqual(s.structure.item_order.slice(-4), items.map((i) => i.key), 'item_order holds PRICING KEYS');
    assert.ok(vs.every((v) => v.display.variantOf === launcher.display.id), 'variantOf holds the launcher’s DISPLAY id');
    assert.deepStrictEqual(s.structure.variant_items[String(launcher.display.id)], { label: 'Salsa', variantIds: vs.map((v) => v.display.id) }, 'variant_items: keyed + listed by DISPLAY ids');
    assert.ok(!JSON.stringify(s).includes('tmp:'), 'no tmp ref survives anywhere');
    // derived / inherited fields; the launcher's stored price = min (display-only, never charged)
    assert.ok(vs.every((v) => v.display.cat === CAT[rid] && v.display.extras_policy === 'none'), 'category + extras_policy inherited by every option');
    assert.deepStrictEqual([launcher.price, launcher.display.price], [600, 600], 'the launcher stores min(choices) — legacy, non-chargeable');
    assert.deepStrictEqual(vs.map((v) => v.price), [600, 650, 700], 'per-choice prices kept (unequal allowed, every brand)');
    assert.doesNotThrow(() => validateSource(s, rid), `${rid}: the allocated source passes the uniform validator`);
    const idx = groupIndexFrom(build(rid, s));
    assert.ok(idx.ok && idx.launchers.has(launcher.key) && vs.every((v) => idx.parentOf.get(v.key) === launcher.key), 'the group index sees the new group');
    const c = cmp(rid, s);
    assert.deepStrictEqual(c.additions.slice().sort(), items.map((i) => i.key).sort(), 'the comparator accepts the whole unit as additions');
    assert.throws(() => cmp(rid, s, false), (e) => e.code === 'choices_not_supported_yet', 'the comparator refuses the same unit with authoring OFF');
    // stable across saves: the allocated source re-saved allocates nothing new and changes nothing
    const again = A.allocateAdditions({ incoming: s, stored: s, activeItems: SRC[rid].items, keyMode: MODE[rid], hwm: r.hwm, registryHasKey: () => false, fieldProblem, authoring: true });
    assert.deepStrictEqual([again.allocatedNow, again.source], [[], s], 'a re-save keeps every allocation');
  }
  ok('authoring ON, BOTH brands: one atomic unit — derived names, inherited category/extras_policy, launcher price = min (non-chargeable), keys by mode, display ids, both namespaces rewritten, validated, indexed, compared as additions, stable across saves');
}

{
  const rid = 'x_pizza';
  refusesWith(() => alloc(rid, withGroup(rid, { label: '  ' })), 'label_required', L, 'label', 'a blank group name');
  refusesWith(() => alloc(rid, withGroup(rid, { label: 'Salsa <b>' })), 'text_unsafe', L, 'label', 'an unsafe group name');
  refusesWith(() => alloc(rid, withGroup(rid, { choices: ['Roja'] })), 'choices_too_few', L, 'choices', 'a single option');
  refusesWith(() => alloc(rid, withGroup(rid, { choices: ['Roja', ''] })), 'choice_label_required', V[1], 'choice', 'an unnamed option');
  refusesWith(() => alloc(rid, withGroup(rid, { choices: ['Roja', 'roja '] })), 'choice_duplicate', V[1], 'choice', 'a duplicate option (folded)');
  refusesWith(() => alloc(rid, withGroup(rid, { choices: ['Roja', 'Mike’s'.replace('’', "'")] })), 'text_unsafe', V[1], 'choice', 'an apostrophe makes the derived NAME unusable (attribute sink) — mapped to the option');
  refusesWith(() => alloc(rid, withGroup(rid, { choices: ['Roja', 'A <b>'] })), 'text_unsafe', V[1], 'choice', 'markup in an option');
  // codex PB-1 r2 (defence in depth): a NEW dish may not take a KEY an existing extra uses (la_musa keys by id; the registry
  // keeps dish / extra namespaces apart, and the reward calculator resolves a key DISH-first)
  refusesWith(() => alloc('la_musa', withGroup('la_musa', { name: 'Rice White' })), 'key_taken', L, 'name', 'la_musa: a launcher whose key (rice_white) is an existing extra\'s key');
  refusesWith(() => alloc('la_musa', withGroup('la_musa', { name: 'Sauce', choices: ['Aioli', 'Chipotle', 'Pad Thai'] })), 'key_taken', V[0], 'choice', 'la_musa: an option whose derived key (sauce_aioli) is an existing extra\'s key → mapped to its choice');
  // codex PB-1 r1 P2-6: the per-choice text check is NOT subsumed — it answers BEFORE the derived-name contradiction check
  refusesWith(() => alloc(rid, withGroup(rid, { choices: ['Roja', '<bad>'], variantExtra: [undefined, { name: 'Otra cosa' }] })), 'text_unsafe', V[1], 'choice',
    'markup in an option AND a contradictory supplied name → the option\'s own text_unsafe, not addition_malformed/name');
  refusesWith(() => alloc(rid, withGroup(rid, { variantExtra: [{ name: 'Otra cosa' }] })), 'addition_malformed', V[0], 'name', 'a client name contradicting the derived one');
  refusesWith(() => alloc(rid, withGroup(rid, { variantExtra: [{ cat: 'individual' }] })), 'addition_malformed', V[0], 'cat', 'an option escaping its product’s category');
  refusesWith(() => alloc(rid, withGroup(rid, { launcherExtra: { extras_policy: 'none' }, variantExtra: [{ extras_policy: 'all' }] })), 'addition_malformed', V[0], 'extras_policy', 'an option contradicting its group’s extras setting');
  refusesWith(() => alloc(rid, withGroup(rid, { launcherExtra: { extras_policy: 'all' } })), 'addition_malformed', L, 'extras_policy', 'an extras setting other than "none"');
  // the SAME option listed twice in one group is refused as a malformed unit (option claimed twice), never as a label clash
  const twice = withGroup(rid); twice.structure.variant_items[L].variantIds = [V[0], V[1], V[0]];
  refusesWith(() => alloc(rid, twice), 'addition_malformed', V[0], 'choices', 'one option listed twice in its group');
  const orphan = withGroup(rid); orphan.structure.variant_items[L].variantIds = [V[0], 'tmp:vvvvvvvv-9999'];
  refusesWith(() => alloc(rid, orphan), 'addition_malformed', L, 'choices', 'an option ref that is not a new option of this group');
  // options for an EXISTING product (la_musa's Pad Thai): never an add-only change
  const lm = clone(SRC.la_musa); lm.items.push({ ref: V[0], price: 300, display: { choice: 'Tofu', variantOf: 'noodle_01', price: 300 } }); lm.structure.item_order.push(V[0]);
  refusesWith(() => A.allocateAdditions({ incoming: lm, stored: SRC.la_musa, activeItems: SRC.la_musa.items, keyMode: 'id', hwm: null, registryHasKey: () => false, fieldProblem, authoring: true }),
    'choices_not_supported_yet', V[0], 'choices', 'an option added to an existing product');
  ok('field-mapped refusals on the TMP row the portal holds: group name (blank / unsafe), < 2 options, unnamed / duplicate / unsafe option (incl. the derived name), contradictions of derived fields, a bad extras setting, an orphan ref, and options for an existing product');
}

{
  // the comparator: la_musa's existing Pad Thai group is FROZEN; a "new" entry that claims an existing product is refused
  const lm = clone(SRC.la_musa); lm.structure.variant_items.noodle_01.label = 'Proteínas';
  assert.throws(() => cmp('la_musa', lm), (e) => e.code === 'structure_changed' && e.field === 'variant_items', 'an existing group’s label cannot change');
  const steal = clone(SRC.la_musa); const ids = steal.items.filter((i) => i.display.cat === 'rice').slice(0, 2).map((i) => i.display.id);
  steal.structure.variant_items[ids[0]] = { label: 'X', variantIds: [ids[1]] };
  assert.throws(() => A.compareToActive({ draftBuilt: { ...build('la_musa', SRC.la_musa), structure: { ...build('la_musa', SRC.la_musa).structure, variant_items: steal.structure.variant_items } },
    activeBuilt: build('la_musa', SRC.la_musa), draftAuthored: Object.keys(SRC.la_musa.structure), renderedCategories: rendererContract('la_musa').renderedCategories, authoring: true }),
  (e) => e.code === 'choices_not_supported_yet', 'a new entry over EXISTING products is refused even with authoring on');
  ok('comparator: an existing group (Pad Thai) is frozen; a new entry that claims existing products is refused even with authoring on');
}

{
  // the authored-fields exception (§0b.2): variant_items may appear / disappear only while the ACTIVE catalog has none
  const x = SRC.x_pizza.structure; const withVi = { ...x, variant_items: { 1: { label: 'S', variantIds: [2, 3] } } };
  assert.doesNotThrow(() => A.assertSameAuthoredFields(withVi, x, { activeHasVariantItems: false }), 'a first group introduces the map');
  assert.doesNotThrow(() => A.assertSameAuthoredFields(x, withVi, { activeHasVariantItems: false }), 'removing the last unpublished group drops it back to ABSENT');
  assert.throws(() => A.assertSameAuthoredFields(withVi, x, { activeHasVariantItems: true }), /structure fields cannot be added or removed/, 'not while the live catalog has a map');
  const lmS = SRC.la_musa.structure; const { variant_items, ...lmNoVi } = lmS; void variant_items;
  assert.throws(() => A.assertSameAuthoredFields(lmNoVi, lmS, { activeHasVariantItems: true }), /structure fields/, 'la_musa can never drop its live map');
  assert.throws(() => A.assertSameAuthoredFields({ ...x, badges: {} }, x, { activeHasVariantItems: false }), /structure fields/, 'every other authored field is still frozen');
  assert.throws(() => A.assertSameAuthoredFields(withVi, x), /structure fields/, 'default (fail-closed): the active map is assumed present');
  ok('authored-fields exception: the variant map may appear/disappear ONLY while the active catalog has none; all else frozen; fail-closed default');
}


// ── codex PB-1 r1 P2-4: SAVE looks up the registry with EVERY name an addition will carry — an option's DERIVED name too ──
// The same three real pieces the handler wires (catalog/edit-catalog-handler.js): prospectiveAdditionNames → the real
// registryKeysTaken (add-product-io, over a fake Firestore that throws on a '/' id like the real one) → allocateAdditions.
(async () => {
  const { addProductIo } = require('./add-product-io');
  const { encodeKey } = require('./identity-registry');
  for (const rid of ['x_pizza', 'la_musa']) {
    const req = withGroup(rid);
    const names = A.prospectiveAdditionNames(req);
    const derived = ['Salsa Roja', 'Salsa Vodka', 'Combinada'].map((c) => A.optionName('NY Plain Slice', c));
    assert.deepStrictEqual(names, ['NY Plain Slice', ...derived], `${rid}: the launcher AND every option's derived name are prospective`);
    const keyOf = (nm) => (MODE[rid] === 'name' ? A.tidyName(nm) : A.slugify(nm));
    const historical = keyOf(derived[2]);                       // "NY Plain Slice - Combinada" existed before
    const rows = new Set([`restaurants/${rid}/identity/dish/keys/${encodeKey(historical)}`, ...(MODE[rid] === 'id' ? [`restaurants/${rid}/identity/dish/ids/${historical}`] : [])]);
    const node = (path) => ({
      collection: (c) => node([...path, c]),
      doc: (id) => {
        if (typeof id !== 'string' || !id || id.includes('/')) throw new Error(`Value for argument "documentPath" must point to a document, but was "${id}"`);
        const pth = [...path, id].join('/');
        return { ...node([...path, id]), get: async () => ({ exists: rows.has(pth) }) };
      },
    });
    const io = addProductIo({ fs: node([]), rtdb: null });
    const taken = await io.registryKeysTaken(rid, names.map(keyOf), MODE[rid]);
    assert.deepStrictEqual([...taken], [historical], `${rid}: the real registry lookup finds the historical OPTION key`);
    refusesWith(() => alloc(rid, withGroup(rid), { history: taken }), 'name_previously_used', V[2], 'choice',
      `${rid}: an option whose DERIVED name was used before → name_previously_used on ITS ref, mapped to the choice input`);
  }
  console.log('  ✓ registry (P2-4): SAVE derives every option name before the registry lookup; a historical option key is refused on its ref, field choice — both brands');
})().catch((e) => { console.error('add-product-groups (registry) FAILED:', e); process.exit(1); });

console.log(`\nadd-product-groups: OK (${n})`);
