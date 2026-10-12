'use strict';
// The renderer contract is a COMMITTED ARTIFACT inside the functions package, because the forms it
// describes are not deployed with functions. That makes drift the risk: an artifact that no longer
// matches the renderers is worse than none, because it is trusted.
//
// Run: node catalog/renderer-contract.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const { deriveContracts, RENDER } = require('../tools/generate-renderer-contract');
const committed = require('./renderer-contract.generated');
const { validateSource } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── PARITY: regenerate from the real forms and compare, byte for byte ────────────────────────────
{
  const file = join(__dirname, 'renderer-contract.generated.js');
  assert.strictEqual(readFileSync(file, 'utf8'), RENDER(deriveContracts()),
    '🔴 the committed renderer contract does not match what the current forms imply — regenerate with tools/generate-renderer-contract.js');
  ok('the committed contract is byte-identical to a fresh derivation from the shipped forms');
}

// ── WHAT IT SAYS, asserted against the forms themselves ──────────────────────────────────────────
{
  assert.strictEqual(committed.la_musa.categoriesNamed, true, 'la_musa prints category labels (index.html:2121)');
  assert.strictEqual(committed.x_pizza.categoriesNamed, false, 'x_pizza has no CATEGORIES literal — its categories are id-only');
  assert.deepStrictEqual(committed.x_pizza.badges, [], '🔴 x_pizza has NO badge renderer, so its supported set is EMPTY');
  assert.ok(committed.la_musa.badges.length > 0 && committed.la_musa.badges.includes('chefs_pick'), 'la_musa can select its own badges');
  ok('the contract records what each shipped renderer can actually do');
}

// ── 1D add-product B (advisor ruling 2026-10-10): CHOICE badges — drawn by the shared picker on a choice row only ─────
{
  const { CHOICE_BADGES, formShipsPicker } = require('../tools/generate-renderer-contract');
  for (const rid of ['x_pizza', 'la_musa']) {
    assert.strictEqual(formShipsPicker(rid), true, `premise: ${rid}'s form ships the picker`);
    assert.deepStrictEqual(committed[rid].choiceBadges, [...CHOICE_BADGES], `${rid}: choiceBadges = the picker's own (derived, identical on every brand)`);
    assert.ok(!committed[rid].badges.includes('recommended'), `${rid}: 'recommended' is NOT a card badge — a card cannot draw it`);
  }
  // choiceBadges is GATED on the strict marker: the same real form without the picker tag derives none
  {
    const { deriveContract } = require('../tools/generate-renderer-contract');
    const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } = require('fs');
    const os = require('os');
    const tmp = mkdtempSync(join(os.tmpdir(), 'choice-badges-'));
    const root = join(tmp, 'a', 'b'); mkdirSync(root, { recursive: true });
    try {
      for (const [form] of [['xpizza-orders'], ['la-musa-orders']]) {
        mkdirSync(join(tmp, form), { recursive: true });
        copyFileSync(join(__dirname, '..', '..', form, 'form-group-picker.js'), join(tmp, form, 'form-group-picker.js'));
      }
      const real = readFileSync(join(__dirname, '..', '..', 'xpizza-orders', 'index.html'), 'utf8');
      writeFileSync(join(tmp, 'xpizza-orders', 'index.html'), real);
      assert.deepStrictEqual(deriveContract('x_pizza', root).choiceBadges, [...CHOICE_BADGES], 'premise: the real form, copied, derives them');
      writeFileSync(join(tmp, 'xpizza-orders', 'index.html'), real.replace('<script src="form-group-picker.js"></script>', ''));
      assert.deepStrictEqual(deriveContract('x_pizza', root).choiceBadges, [], '🔴 the same form WITHOUT the picker tag derives no choice badges');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  // a fixture with ONE group (a launcher + 2 choices) on each brand, built on the real seed source
  const withGroup = (rid, tagOn) => {
    const s = buildSourceFromCode(rid);
    const host = s.items.find((it) => !it.display.variantOf && !(s.structure.variant_items && s.structure.variant_items[it.display.id]));
    const mk = (n) => (rid === 'la_musa' ? `zz_${n}` : 9000 + n);
    const L = mk(1); const A = mk(2); const B = mk(3);
    const lName = 'Grupo Prueba';
    const items = [
      { key: rid === 'la_musa' ? L : lName, price: 300, display: { id: L, cat: host.display.cat, name: lName, price: 300 } },
      { key: rid === 'la_musa' ? A : `${lName} - Uno`, price: 300, display: { id: A, cat: host.display.cat, name: `${lName} - Uno`, price: 300, variantOf: L, choice: 'Uno' } },
      { key: rid === 'la_musa' ? B : `${lName} - Dos`, price: 320, display: { id: B, cat: host.display.cat, name: `${lName} - Dos`, price: 320, variantOf: L, choice: 'Dos' } },
    ];
    if (host.display.subcat !== undefined) items.forEach((it) => { it.display.subcat = host.display.subcat; });
    s.items.push(...items);
    s.structure.item_order = [...s.structure.item_order, ...items.map((it) => it.key)];
    s.structure.variant_items = { ...(s.structure.variant_items || {}), [String(L)]: { label: 'Opción', variantIds: [A, B] } };
    if (tagOn === 'variant') items[2].display.tags = ['recommended'];
    if (tagOn === 'dish') host.display.tags = [...(host.display.tags || []), 'recommended'];
    return s;
  };
  for (const rid of ['x_pizza', 'la_musa']) {
    assert.doesNotThrow(() => validateSource(withGroup(rid, null), rid), `premise: ${rid} accepts the group fixture untagged`);
    assert.doesNotThrow(() => validateSource(withGroup(rid, 'variant'), rid), `${rid}: 'recommended' on a CHOICE is accepted`);
    assert.throws(() => validateSource(withGroup(rid, 'dish'), rid), /tag recommended is not a badge the renderer can select, so it would render nothing/,
      `🔴 ${rid}: 'recommended' on an ordinary dish is REFUSED — no card draws it`);
  }
  // a brand whose contract carries NO choiceBadges (its form does not ship the picker) refuses it even on a choice
  {
    const Module = require('module');
    const realLoad = Module._load;
    const stub = { x_pizza: { ...committed.x_pizza, choiceBadges: undefined }, la_musa: committed.la_musa };
    delete stub.x_pizza.choiceBadges;
    const fresh = require.resolve('./source-store');
    delete require.cache[fresh];
    Module._load = function (request, ...rest) { return request === './renderer-contract.generated' ? stub : realLoad.call(this, request, ...rest); };
    try {
      const { validateSource: v } = require('./source-store');
      assert.throws(() => v(withGroup('x_pizza', 'variant'), 'x_pizza'), /tag recommended is not a badge the renderer can select on a choice/,
        '🔴 no choiceBadges in the contract (no picker shipped) → refused even on a choice');
      const bad = { x_pizza: { ...committed.x_pizza, choiceBadges: 'recommended' }, la_musa: committed.la_musa };
      Module._load = function (request, ...rest) { return request === './renderer-contract.generated' ? bad : realLoad.call(this, request, ...rest); };
      delete require.cache[fresh];
      const { validateSource: v2 } = require('./source-store');
      assert.throws(() => v2(buildSourceFromCode('x_pizza'), 'x_pizza'), /malformed choiceBadges/, '🔴 a malformed choiceBadges fails closed');
    } finally { Module._load = realLoad; delete require.cache[fresh]; require('./source-store'); }
  }
  ok("choiceBadges: 'recommended' on a CHOICE is accepted and on an ordinary dish REFUSED, on both brands; a contract without choiceBadges refuses it on a choice; a malformed one fails closed");
}

// ── A BRAND WITH NO BADGE RENDERER REFUSES EVERY BADGE ───────────────────────────────────────────
{
  // The failure this closes: falling back to "whatever the source declares" would let a brand with no
  // badge renderer define badges and tag dishes with them, and the form would show nothing at all.
  const s = buildSourceFromCode('x_pizza');
  s.structure.badges = { chefs_pick: { label: 'Selección del chef', cls: 'menu-badge--bronze' } };
  assert.throws(() => validateSource(s, 'x_pizza'), /not one the renderer can select/,
    '🔴 a badge DEFINITION on a brand with no badge renderer is refused');
  const t = buildSourceFromCode('x_pizza');
  t.items[0].display.tags = ['chefs_pick'];
  assert.throws(() => validateSource(t, 'x_pizza'), /not a badge the renderer can select/,
    '🔴 and so is a TAG, even one that is perfectly real on the other brand');
  ok('x_pizza: an empty supported set refuses every badge and every tag');
}

// ── A MENU WITH NO VARIANTS ──────────────────────────────────────────────────────────────────────
{
  const s = buildSourceFromCode('x_pizza');
  assert.strictEqual(s.structure.variant_items, undefined, 'premise: x_pizza ships no variant dishes');
  assert.doesNotThrow(() => validateSource(s, 'x_pizza'), '🔴 a menu with no variants at all is valid');
  // ...but a variant map that is PRESENT and not an object is a broken document, not an empty one.
  for (const bad of [null, 7, 'noodle_01', []]) {
    const t = buildSourceFromCode('x_pizza');
    t.structure.variant_items = bad;
    assert.throws(() => validateSource(t, 'x_pizza'), /variant_items must be an object/,
      `🔴 variant_items = ${JSON.stringify(bad)} is refused, not silently treated as "no variants"`);
  }
  ok('x_pizza: no variants is valid; a present-but-broken variant map is not');
}

// ── FAIL CLOSED when the artifact is gone ────────────────────────────────────────────────────────
{
  // Simulated by loading a copy of the validator with the artifact unresolvable. A missing contract is
  // a broken deployment — the state production was ACTUALLY in before this was baked — and it must
  // stop everything rather than quietly validate less.
  const Module = require('module');
  const realResolve = Module._resolveFilename;
  const fresh = require.resolve('./source-store');
  const artifact = require.resolve('./renderer-contract.generated');
  delete require.cache[fresh];
  delete require.cache[artifact];
  Module._resolveFilename = function (request, ...rest) {
    if (request === './renderer-contract.generated') { const e = new Error('Cannot find module'); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return realResolve.call(this, request, ...rest);
  };
  try {
    const { validateSource: v } = require('./source-store');
    assert.throws(() => v(buildSourceFromCode('la_musa'), 'la_musa'), /renderer contract artifact is missing/,
      '🔴 a missing contract REJECTS — it never degrades to "unconstrained"');
  } finally {
    Module._resolveFilename = realResolve;
    delete require.cache[fresh];
    require('./source-store');
  }
  ok('a missing contract artifact fails closed rather than validating less');
}

// ── A MALFORMED ARTIFACT IS ALSO A BROKEN DEPLOYMENT ─────────────────────────────────────────────
{
  // "Missing" is not the only way an artifact fails. One that loads but is the wrong shape is worse,
  // because it is trusted — so the shape is checked rather than assumed, and a bad one stops
  // everything exactly as a missing one does.
  const Module = require('module');
  const realLoad = Module._load;
  const fresh = require.resolve('./source-store');
  const check = (stub, why) => {
    delete require.cache[fresh];
    Module._load = function (request, ...rest) {
      if (request === './renderer-contract.generated') return stub;
      return realLoad.call(this, request, ...rest);
    };
    try {
      const { validateSource: v } = require('./source-store');
      assert.throws(() => v(buildSourceFromCode('la_musa'), 'la_musa'), /renderer contract/, why);
    } finally { Module._load = realLoad; delete require.cache[fresh]; require('./source-store'); }
  };
  check([], '🔴 an artifact that is an ARRAY is refused');
  check('nope', '🔴 an artifact that is a string is refused');
  check({ la_musa: { categoriesNamed: 'yes', badges: [] } }, '🔴 an entry with a non-boolean flag is refused');
  check({ la_musa: { categoriesNamed: true, badges: 'chefs_pick' } }, '🔴 an entry whose badge set is not a list is refused');
  ok('a malformed contract artifact fails closed too, not just a missing one');
}

// ── A BRAND THE ARTIFACT DOES NOT DESCRIBE ───────────────────────────────────────────────────────
{
  // A new merchant has no bespoke renderer yet. That is not a broken deployment, so its menu may be
  // valid — but its supported badge set is EMPTY, never "whatever this document declares".
  const base = () => ({
    restaurant_id: 'merch_new', schema_version: 2,
    items: [{ key: 'Plato', price: 250, display: { id: 1, cat: 'principales', name: 'Plato', price: 250 } }],
    extras: [],
    structure: { categories: [{ id: 'principales' }], item_order: ['Plato'] },
  });
  assert.doesNotThrow(() => validateSource(base(), 'merch_new'), 'an undescribed brand can still have a valid menu');
  const tagged = base(); tagged.items[0].display.tags = ['chefs_pick'];
  assert.throws(() => validateSource(tagged, 'merch_new'), /not a badge the renderer can select/,
    '🔴 but its badge set is EMPTY — no tag is honoured for a renderer nobody has described');
  const defined = base(); defined.structure.badges = { chefs_pick: { label: 'X', cls: 'y' } };
  assert.throws(() => validateSource(defined, 'merch_new'), /not one the renderer can select/,
    '🔴 and it cannot define its way into having badges');
  ok('an undescribed brand validates normally but supports no badges at all');
}

// ── A PRESENT-BUT-FALSY ENTRY IS MALFORMED, NOT ABSENT ───────────────────────────────────────────
{
  // The leak: `if (!entry)` read null, false, 0 and "" as "this brand is not in the table" — so a
  // corrupted entry for ONE brand quietly restored the fail-open behaviour for that brand alone.
  // Absent (nobody described it) and present-but-broken (somebody described it wrongly) are
  // different facts and only one of them is safe.
  const Module = require('module');
  const realLoad = Module._load;
  const fresh = require.resolve('./source-store');
  const withTable = (table, expectThrow, why, src) => {
    delete require.cache[fresh];
    Module._load = function (request, ...rest) {
      if (request === './renderer-contract.generated') return table;
      return realLoad.call(this, request, ...rest);
    };
    try {
      const { validateSource: v } = require('./source-store');
      const run = () => v(src ? src() : buildSourceFromCode('la_musa'), 'la_musa');
      if (expectThrow) assert.throws(run, /renderer contract/, why); else assert.doesNotThrow(run, why);
    } finally { Module._load = realLoad; delete require.cache[fresh]; require('./source-store'); }
  };
  for (const falsy of [null, false, 0, '', NaN]) {
    withTable({ ...committed, la_musa: falsy }, true, `🔴 la_musa: ${String(falsy)} is MALFORMED, not absent`);
  }
  for (const wrong of [[], 'x', 7, {}, { categoriesNamed: true }, { badges: [] }, { categoriesNamed: 'yes', badges: [] }]) {
    withTable({ ...committed, la_musa: wrong }, true, `🔴 la_musa: ${JSON.stringify(wrong)} is refused`);
  }
  // ...while a brand genuinely absent from the table is still legitimate.
  // ...while a brand genuinely absent from the table is still legitimate — for a document that asks
  // nothing of a renderer nobody described. Its badges and tags go, because an undescribed brand
  // supports none; that is the empty-set rule doing its job, not a contradiction of this one.
  const { la_musa, ...withoutLaMusa } = committed;   // eslint-disable-line no-unused-vars
  const badgeFree = () => {
    const s = buildSourceFromCode('la_musa');
    delete s.structure.badges;
    for (const i of s.items) delete i.display.tags;
    return s;
  };
  withTable(withoutLaMusa, false, 'a brand simply not in the table constrains nothing and still validates', badgeFree);
  ok('a present-but-falsy or malformed contract entry fails closed; a genuinely absent one does not');
}

// ── extra_categories WHEN THERE ARE NO EXTRAS ────────────────────────────────────────────────────
{
  // The leak: the whole block sat inside `if (extras.length > 0)`, so a menu selling no add-ons could
  // carry any garbage at all in the namespace and nothing looked. Emptiness may decide whether a
  // value is NEEDED; it must never decide whether a present value is CHECKED.
  const noExtras = () => {
    const s = buildSourceFromCode('x_pizza');
    s.extras = [];
    delete s.structure.extras_by_category;
    delete s.structure.extras_by_item;
    delete s.structure.redeem_eligible_extras;
    delete s.structure.extra_categories;
    delete s.structure.exposure;              // no options to offer, so nothing to say about offering them
    return s;
  };
  assert.doesNotThrow(() => validateSource(noExtras(), 'x_pizza'), 'a menu with no extras and no namespace is valid');
  // ...and the same rule for the exposure: emptiness may decide whether it is NEEDED, never whether a
  // present one is CHECKED. A menu with no options that still claims to offer some is malformed.
  for (const [what, mutate] of [
    ['a garbage exposure', (s) => { s.structure.exposure = 7; }],
    ['an exposure allowing a category that no longer exists', (s) => { s.structure.exposure = { category_allow: { individual: ['Carnes'] }, item_overrides: {} }; }],
  ]) {
    const s = noExtras(); mutate(s);
    assert.throws(() => validateSource(s, 'x_pizza'), /source_malformed/, `${what} must be refused even with no extras`);
  }
  for (const bad of [null, 7, 'broken', {}, [1], ['ok', 'ok'], ['  ']]) {
    const s = noExtras();
    s.structure.extra_categories = bad;
    assert.throws(() => validateSource(s, 'x_pizza'), /extra_categories/,
      `🔴 with extras: [], extra_categories = ${JSON.stringify(bad)} is still type-validated`);
  }
  // an EMPTY namespace is fine with no extras, and refused once extras exist
  const empty = noExtras(); empty.structure.extra_categories = [];
  assert.doesNotThrow(() => validateSource(empty, 'x_pizza'), 'an empty namespace is legitimate when nothing needs it');
  const withExtras = buildSourceFromCode('x_pizza'); withExtras.structure.extra_categories = [];
  assert.throws(() => validateSource(withExtras, 'x_pizza'), /must be non-empty when extras exist/,
    '🔴 and required to be non-empty as soon as an extra exists');
  ok('extra_categories is type-validated whenever present, required only when extras exist');
}

{
  // 1D add-product A §1 — renderedCategories, derived from the shipped renderMenu
  const { renderedCategoriesOf } = require('../tools/generate-renderer-contract');
  assert.deepStrictEqual(committed.x_pizza.renderedCategories, ['individual', 'ny'], 'x_pizza draws exactly its two literal-filtered sections');
  assert.deepStrictEqual(committed.la_musa.renderedCategories, ['dim_sum', 'starters', 'house_specials', 'crudo', 'noodles', 'rice', 'soups_salads', 'bebidas'],
    'la_musa walks CATEGORIES and filters p.cat === c.id → every category of its literal, in order');
  const walk = "const CATEGORIES = [{id:'a',name:'A'},{id:'b',name:'B'}];\nfunction renderMenu() {\n  CATEGORIES.forEach(c => { const items = MENU.filter(p => p.cat === c.id); if (x) { y(); } });\n}\n";
  assert.deepStrictEqual(renderedCategoriesOf(walk), ['a', 'b'], 'a CATEGORIES walk with p.cat === c.id → the literal ids');
  assert.deepStrictEqual(renderedCategoriesOf(walk.replace('p.cat === c.id', 'p.kind === c.id')), [], 'a walk that does NOT filter by category → nothing is known to render');
  assert.deepStrictEqual(renderedCategoriesOf(walk.replace("const CATEGORIES = [{id:'a',name:'A'},{id:'b',name:'B'}];", '')), [], 'a walk with no CATEGORIES literal → [] (fail closed)');
  const lit = "function renderMenu(){\n  const a = MENU.filter(p=>p.cat==='individual');\n  const b = MENU.filter(p => p.cat === \"ny\");\n  if (q) { r(); }\n}\nfunction other(){ return MENU.filter(p=>p.cat==='hidden'); }\n";
  assert.deepStrictEqual(renderedCategoriesOf(lit), ['individual', 'ny'], 'literal filters INSIDE renderMenu only — a filter in another function is not drawing');
  assert.deepStrictEqual(renderedCategoriesOf('function other(){ return MENU.filter(p=>p.cat===\'x\'); }'), [], 'no renderMenu → []');
  assert.deepStrictEqual(renderedCategoriesOf('function renderMenu(){ MENU.filter(p=>p.cat===\'x\')'), [], 'an unterminated body → [] (never a partial guess)');
  ok('renderedCategories: from renderMenu only — a CATEGORIES walk filtering p.cat === c.id → its literal ids; literal p.cat===\'x\' filters → those; anything else → [] (fail closed)');
}
{
  // the accessor: absent → [] (nothing addable), malformed → refuse, present → a copy
  const Module = require('module');
  // the artifact is required LAZILY inside rendererContract, so the stub must be in place for the CALL
  const load = (table) => ({ rendererContract: (rid) => {
    const orig = Module._load;
    Module._load = function (request, ...rest) { if (request === './renderer-contract.generated') return table; return orig.call(this, request, ...rest); };
    try { delete require.cache[require.resolve('./source-store')]; return require('./source-store').rendererContract(rid); } finally { Module._load = orig; }
  } });
  try {
    assert.deepStrictEqual(load({ r1: { categoriesNamed: false, badges: [] } }).rendererContract('r1').renderedCategories, [], 'absent field → []');
    assert.deepStrictEqual(load({ r1: { categoriesNamed: false, badges: [] } }).rendererContract('zz').renderedCategories, [], 'undescribed brand → []');
    assert.deepStrictEqual(load({ r1: { categoriesNamed: false, badges: [], renderedCategories: ['c1'] } }).rendererContract('r1').renderedCategories, ['c1']);
    for (const bad of ['c1', [''], [1], null, {}]) {
      assert.throws(() => load({ r1: { categoriesNamed: false, badges: [], renderedCategories: bad } }).rendererContract('r1'), /renderedCategories/, `malformed ${JSON.stringify(bad)} refused`);
    }
  } finally { delete require.cache[require.resolve('./source-store')]; }
  ok('rendererContract().renderedCategories: absent field or undescribed brand → [] (fail closed); malformed → refused; present → those ids');
}

console.log(`renderer-contract: OK (${n})`);
