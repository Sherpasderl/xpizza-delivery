'use strict';
// Task 3 — "DESDE" IS DERIVED, and the launcher keeps its own price.
//
// Two numbers that are easy to conflate and must never be:
//   • the LAUNCHER's authoritative price (Pad Thai, L414) — what a bare launcher id costs, kept for
//     compatibility with orders that reference it directly (menu-pricing.js:83)
//   • the STARTING price shown to a customer ("desde L 307") — the cheapest variant they can pick
//
// Overwriting the first with the second would silently reprice the dish. Authoring the second would
// let it drift from the variants it claims to summarise. So it is DERIVED, from the variants, every
// time — and the source carries no authored copy for anything to disagree with.
//
// Run: node catalog/desde-derivation.test.js
const assert = require('assert');
const { deriveStartingPrice, rebuildFormMenu, buildCatalogV2 } = require('./form-menu-source');
const { validateSource } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const variants = (...prices) => prices.map((p, i) => ({ key: `v${i}`, price: p, display: { id: `v${i}`, price: p } }));

// ── THE DERIVATION ──────────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(deriveStartingPrice({ key: 'l', price: 414 }, variants(307, 342, 414)), 307,
    'desde is the CHEAPEST selectable variant');
  assert.strictEqual(deriveStartingPrice({ key: 'l', price: 414 }, variants(414, 342, 307)), 307,
    '...whatever order they are listed in');
  assert.strictEqual(deriveStartingPrice({ key: 'l', price: 100 }, variants(307)), 307,
    '...even when it is DEARER than the launcher — the two are different facts, not a min of each other');
  assert.strictEqual(deriveStartingPrice({ key: 'l', price: 414 }, []), null,
    'no variants, no starting price — fail closed rather than inventing one');
  for (const bad of [[{ price: 0 }], [{ price: -5 }], [{ price: '307' }], [{}], [null]]) {
    assert.strictEqual(deriveStartingPrice({ key: 'l', price: 414 }, bad), null,
      `a variant with no usable price yields no desde: ${JSON.stringify(bad)}`);
  }
  ok('deriveStartingPrice returns the cheapest selectable variant price, or nothing at all');
}

// ── THE REAL MENU ───────────────────────────────────────────────────────────────────────────────
{
  const src = buildSourceFromCode('la_musa');
  const launcher = src.items.find((i) => i.key === 'noodle_01');
  const vs = src.structure.variant_items.noodle_01.variantIds.map((id) => src.items.find((i) => i.display.id === id));
  assert.strictEqual(launcher.price, 414, 'premise: the Pad Thai launcher is L414');
  assert.strictEqual(deriveStartingPrice(launcher, vs), 307, '🔴 and its desde is L307, the cheapest protein');
  assert.strictEqual(launcher.display.price, 414, '🔴 the launcher display price is NOT overwritten by the desde');
  ok('la_musa: launcher L414, desde L307 — derived, and the launcher keeps its own price');
}

// ── THE SOURCE CARRIES NO AUTHORED COPY ─────────────────────────────────────────────────────────
{
  const src = buildSourceFromCode('la_musa');
  assert.strictEqual(src.structure.variant_items.noodle_01.basePrice, undefined,
    '🔴 the SOURCE authors no basePrice — a derived value stored as an authored one is a value that can drift');
  const authored = buildSourceFromCode('la_musa');
  authored.structure.variant_items.noodle_01.basePrice = 307;      // even the CORRECT number
  assert.throws(() => validateSource(authored, 'la_musa'), /basePrice/,
    '🔴 and authoring one is refused even when it happens to be right — being right today is not the property');
  ok('an authored basePrice is refused; there is nothing for the derivation to disagree with');
}

// ── basePrice PRESENT AS A KEY, SET TO undefined ────────────────────────────────────────────────
{
  // The same root as two earlier findings: asking whether a VALUE is undefined instead of whether the
  // KEY is there. `{ basePrice: undefined }` is an own property — the validator read it as absent and
  // let it through, and the emission's trailing spread then put it back, clobbering the derived alias.
  // The live form would render "desde L undefined" with NaN deltas, off a source that validated.
  const authoredUndefined = () => {
    const s = buildSourceFromCode('la_musa');
    s.structure.variant_items.noodle_01.basePrice = undefined;     // the KEY exists; the value does not
    return s;
  };
  assert.ok(Object.prototype.hasOwnProperty.call(authoredUndefined().structure.variant_items.noodle_01, 'basePrice'),
    'premise: the key really is an own property');
  assert.throws(() => validateSource(authoredUndefined(), 'la_musa'), /must not be stored/,
    '🔴 an authored basePrice is refused by the KEY being there, whatever its value');

  // ...and even if such a source reached emission, the derived alias must win.
  const s = authoredUndefined();
  const spec = rebuildFormMenu('la_musa', s.items, s.structure, s.extras).variant_items.noodle_01;
  assert.strictEqual(spec.basePrice, 307, '🔴 the DERIVED value is emitted — a stale key cannot clobber it');
  assert.strictEqual(`desde L ${spec.basePrice}`, 'desde L 307', '...so the form never renders "desde L undefined"');
  const byId = new Map(rebuildFormMenu('la_musa', s.items, s.structure, s.extras).dishes.map((d) => [d.id, d]));
  assert.ok(spec.variantIds.every((id) => Number.isFinite(byId.get(id).price - spec.basePrice)), 'and no delta is NaN');
  ok('a basePrice key set to undefined is refused, and could not clobber the derived alias even if it were not');
}

// ── THE BUNDLE CARRIES THE DERIVED ONE (the pre-1B compat alias) ────────────────────────────────
{
  const src = buildSourceFromCode('la_musa');
  const bundle = rebuildFormMenu('la_musa', src.items, src.structure, src.extras);
  const spec = bundle.variant_items.noodle_01;
  assert.strictEqual(spec.basePrice, 307,
    '🔴 the generated bundle DOES carry basePrice — the live form reads it for "desde" and its delta maths');
  assert.strictEqual(typeof spec.basePrice, 'number', '...as a number, so it cannot render as markup');
  assert.deepStrictEqual(spec.variantIds, src.structure.variant_items.noodle_01.variantIds, 'and the choices are unchanged');
  assert.strictEqual(spec.label, 'Proteína', 'as is the label');
  ok('the bundle emits a DERIVED basePrice alias, so the currently-served form keeps working');
}

// ── THROUGH THE CURRENT FORM CONSUMERS ──────────────────────────────────────────────────────────
{
  // la-musa-orders/index.html:2165  'desde L ' + VARIANT_ITEMS[p.id].basePrice
  //                        :4136  `desde L ${cfg.basePrice}`
  //                        :4144  const delta = v.price - cfg.basePrice
  // Transcribed here, because "the bundle has a field" is not the claim — the claim is that the form
  // renders a price and computes deltas that are right.
  const src = buildSourceFromCode('la_musa');
  const bundle = rebuildFormMenu('la_musa', src.items, src.structure, src.extras);
  const cfg = bundle.variant_items.noodle_01;
  const rendered = `desde L ${cfg.basePrice}`;
  assert.strictEqual(rendered, 'desde L 307', `🔴 the form renders "${rendered}" — never "desde L undefined"`);
  assert.ok(!/undefined|NaN|\[object/.test(rendered), 'and nothing that reads as a broken value');
  const byId = new Map(bundle.dishes.map((d) => [d.id, d]));
  const deltas = cfg.variantIds.map((id) => byId.get(id).price - cfg.basePrice);
  assert.deepStrictEqual(deltas, [0, 35, 107], '🔴 and the per-choice deltas are right, measured from the desde');
  assert.ok(deltas.every((d) => Number.isFinite(d) && d >= 0), 'no negative or NaN delta — the desde really is the floor');
  ok('the served form renders "desde L 307" and correct deltas off the regenerated bundle');
}

// ── MOVE THE FACT ───────────────────────────────────────────────────────────────────────────────
{
  const src = buildSourceFromCode('la_musa');
  const cheapest = src.items.find((i) => i.display.id === 'noodle_01_sin');
  cheapest.price = 250; cheapest.display.price = 250;               // lower the cheapest protein
  const bundle = rebuildFormMenu('la_musa', src.items, src.structure, src.extras);
  assert.strictEqual(bundle.variant_items.noodle_01.basePrice, 250, '🔴 desde FOLLOWS the cheapest variant');
  assert.strictEqual(src.items.find((i) => i.key === 'noodle_01').price, 414, '🔴 while the launcher price does not move');
  assert.doesNotThrow(() => validateSource(src, 'la_musa'), 'and the source is still valid — nothing authored had to be updated in step');

  // ...and the OTHER direction: raise the cheapest above a sibling and the desde becomes the sibling.
  const src2 = buildSourceFromCode('la_musa');
  const sin = src2.items.find((i) => i.display.id === 'noodle_01_sin');
  sin.price = 999; sin.display.price = 999;
  const b2 = rebuildFormMenu('la_musa', src2.items, src2.structure, src2.extras);
  assert.strictEqual(b2.variant_items.noodle_01.basePrice, 342, 'desde becomes the next-cheapest, not a remembered 307');
  ok('move-the-fact: the desde tracks the variants in both directions; the launcher price never moves');
}

// ── x_pizza HAS NO VARIANTS ─────────────────────────────────────────────────────────────────────
{
  const src = buildSourceFromCode('x_pizza');
  const bundle = rebuildFormMenu('x_pizza', src.items, src.structure, src.extras);
  assert.strictEqual(bundle.variant_items, undefined, 'a menu with no variant dishes emits no variant map');
  ok('x_pizza: no variants, nothing derived, nothing emitted');
}

console.log(`desde-derivation: OK (${n})`);
