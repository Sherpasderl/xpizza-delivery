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

console.log(`renderer-contract: OK (${n})`);
