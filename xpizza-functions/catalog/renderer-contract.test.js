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

console.log(`renderer-contract: OK (${n})`);
