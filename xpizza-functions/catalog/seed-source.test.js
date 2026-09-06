'use strict';
// Portal 2a Task 3 — seed the source store FROM CODE, round-trip proven. Run: node catalog/seed-source.test.js
//
// The cutover's "provable no-op" starts here: whatever this seed writes must rebuild the current menu
// EXACTLY. So the test is not "the seed produced something plausible" — it is "build-from-seed is
// byte-identical to build-from-code", per brand, plus the guards that make a plausible-but-wrong seed
// (notably mis-keyed extras) impossible.
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { validateSource, sourceToBuildInputs, canonicalize } = require('./source-store');
const { buildCatalogV2, formSource, readLiteral } = require('./form-menu-source');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

for (const rid of ['x_pizza', 'la_musa']) {
  const source = buildSourceFromCode(rid);
  assert.doesNotThrow(() => validateSource(source, rid), `${rid}: the seeded source must pass every validator guard`);
  ok(`${rid}: buildSourceFromCode passes validateSource (prices, keying, bijection, category superset)`);

  // ── THE ROUND TRIP: build-from-store == build-from-code, byte for byte ────────────────────────
  const { priceTable, formData, extras } = sourceToBuildInputs(source);
  const fromStore = buildCatalogV2(rid, { formData, priceTable });
  const fromCode = buildCatalogV2(rid, { formSource: formSource(rid), priceTable: MENU_BY_RESTAURANT[rid] });
  assert.deepStrictEqual(fromStore, fromCode, `${rid}: build-from-store must equal build-from-code EXACTLY (the no-op proof)`);
  assert.deepStrictEqual(canonicalize(fromStore), canonicalize(fromCode), `${rid}: and canonically, so property order cannot hide a difference`);
  ok(`${rid}: ROUND TRIP — build-from-store == build-from-code byte-identical (${fromStore.items.length} items)`);

  // prices are the code tables exactly — this is what the customer is charged from
  assert.deepStrictEqual(priceTable, MENU_BY_RESTAURANT[rid], `${rid}: the seeded price table IS the code table`);
  assert.deepStrictEqual(extras, EXTRAS_BY_RESTAURANT[rid], `${rid}: the seeded EXTRAS table IS the code extras table — same keys, same prices`);
  ok(`${rid}: seeded prices == code tables exactly (${Object.keys(priceTable).length} items + ${Object.keys(extras).length} extras)`);
}
{
  // ── EXTRAS KEYING, on real data — the landmine the validator guards, proven on the actual seed ──
  const xs = buildSourceFromCode('x_pizza');
  assert.ok(xs.extras.every((e) => e.key === e.display.name), 'x_pizza extras are keyed by NAME');
  assert.ok(xs.extras.some((e) => e.display.id && e.display.id !== e.key), 'and their form ids (e1, e2…) are carried but NOT used as keys');
  const ls = buildSourceFromCode('la_musa');
  assert.ok(ls.extras.every((e) => e.key === e.display.id), 'la_musa extras are keyed by id');
  ok('extras keying on real data: x_pizza by NAME (form ids carried, unused), la_musa by id');
}
{
  // ── x_pizza categories are AUTHORED to exactly the derived result (the portal ruling) ──────────
  const s = buildSourceFromCode('x_pizza');
  const dishes = readLiteral(formSource('x_pizza'), 'MENU');
  const derived = []; for (const d of dishes) if (!derived.includes(d.cat)) derived.push(d.cat);
  assert.deepStrictEqual(s.structure.categories, derived.map((id) => ({ id })),
    'x_pizza categories are authored to exactly the text path\'s derived result — so the paths agree at cutover');
  ok('x_pizza categories: authored == the derived result (store-authored, byte-identical at cutover)');
}
{
  // ── the form-side maps the portal must own are carried ───────────────────────────────────────
  const s = buildSourceFromCode('la_musa');
  assert.ok(s.structure.extras_by_category && Object.keys(s.structure.extras_by_category).length > 0, 'la_musa extras_by_category carried');
  assert.ok(s.structure.extras_by_item && Object.keys(s.structure.extras_by_item).length > 0, 'la_musa extras_by_item carried');
  assert.ok(s.extras.every((e) => e.display), 'extras display records carried (the portal edits these)');
  assert.strictEqual(s.items.filter((i) => i.has_photo).length, 28, 'has_photo carried per item');
  ok('form-side data the portal must own is carried (extras_by_category/_by_item, extras display, has_photo)');
}
{
  // ── NON-VACUITY: the round trip must actually go THROUGH the store object. A sentinel injected into
  //    the seeded source must reach the build; otherwise the comparison proves nothing.
  const s = buildSourceFromCode('x_pizza');
  s.items[0].display = { ...s.items[0].display, desc: 'SENTINEL-VIA-STORE' };
  const { priceTable, formData } = sourceToBuildInputs(s);
  const built = buildCatalogV2('x_pizza', { formData, priceTable });
  assert.strictEqual(built.items[0].display.desc, 'SENTINEL-VIA-STORE', 'the build reads the STORE object, not the form');
  ok('non-vacuity: a sentinel in the seeded source reaches the build (the round trip really goes through the store)');
}
{
  // ── a mis-keyed seed must be IMPOSSIBLE to publish, not merely unlikely ───────────────────────
  const s = buildSourceFromCode('x_pizza');
  s.extras = s.extras.map((e) => ({ ...e, key: e.display.id }));   // the exact 'e1' mistake
  assert.throws(() => validateSource(s, 'x_pizza'), /extras key by NAME/, 'a seed that keyed x_pizza extras by form id fails closed');
  ok('a mis-keyed extras seed is rejected by the validator before it can round-trip or publish');
}
console.log(`seed-source: OK (${n})`);
