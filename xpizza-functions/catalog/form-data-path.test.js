'use strict';
// Portal 2a Task 2 — buildCatalogV2's structured `formData` path must be IDENTICAL to the text path.
// Run: node catalog/form-data-path.test.js
//
// This is the hinge of the whole inversion: after 2a the build reads a structured store object instead
// of parsing form text, and the cutover is only a provable no-op if those two paths produce the same
// {items, structure} byte for byte — including the verbatim display records, has_photo, item_order and
// every aux structure. If they can differ at all, the "byte-identical no-op" claim is hollow.
const assert = require('assert');
const { buildCatalogV2, formSource, readLiteral, readSetLiteral } = require('./form-menu-source');
const { MENU_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Derive formData from the CURRENT form via the existing text parse — so this compares the two paths
// on real data rather than on a hand-built fixture that could quietly disagree with reality.
function formDataFromText(rid) {
  const src = formSource(rid);
  const dishes = readLiteral(src, 'MENU');
  const fd = { dishes, item_order: null, categories: null };
  if (rid === 'la_musa') {
    fd.categories = readLiteral(src, 'CATEGORIES');
    fd.variant_items = readLiteral(src, 'VARIANT_ITEMS', '{', '}');
    fd.has_photo = readSetLiteral(src, 'HAS_PHOTO');
  } else {
    const order = []; for (const d of dishes) if (!order.includes(d.cat)) order.push(d.cat);
    fd.categories = order.map((id) => ({ id }));
    fd.pickup_only_cats = readLiteral(src, 'PICKUP_ONLY_CATS');
    fd.weekend_only_cats = readLiteral(src, 'WEEKEND_ONLY_CATS');
  }
  return fd;
}

for (const rid of ['x_pizza', 'la_musa']) {
  const priceTable = MENU_BY_RESTAURANT[rid];
  const fromText = buildCatalogV2(rid, { formSource: formSource(rid), priceTable });
  const fromData = buildCatalogV2(rid, { formData: formDataFromText(rid), priceTable });
  assert.deepStrictEqual(fromData, fromText, `${rid}: the formData path must equal the text path exactly`);
  // and spell out the parts that would be easiest to lose silently
  assert.deepStrictEqual(fromData.items.map((i) => i.display), fromText.items.map((i) => i.display), `${rid}: display records verbatim`);
  assert.deepStrictEqual(fromData.structure.item_order, fromText.structure.item_order, `${rid}: item_order preserved`);
  assert.deepStrictEqual(fromData.items.map((i) => i.has_photo), fromText.items.map((i) => i.has_photo), `${rid}: has_photo per item`);
  assert.deepStrictEqual(fromData.structure.categories, fromText.structure.categories, `${rid}: categories (order, labels, subcats)`);
  ok(`${rid}: formData path == text path, byte-identical (${fromData.items.length} items + structure)`);
}
{
  const x = buildCatalogV2('x_pizza', { formData: formDataFromText('x_pizza'), priceTable: MENU_BY_RESTAURANT.x_pizza });
  assert.deepStrictEqual(x.structure.pickup_only_cats, ['ny']);
  assert.deepStrictEqual(x.structure.weekend_only_cats, ['ny']);
  const l = buildCatalogV2('la_musa', { formData: formDataFromText('la_musa'), priceTable: MENU_BY_RESTAURANT.la_musa });
  assert.strictEqual(Object.keys(l.structure.variant_items).length, 1, 'la_musa variant map carried through the structured path');
  assert.strictEqual(l.items.filter((i) => i.has_photo).length, 28, 'la_musa photo flags carried through');
  ok('the aux structures survive the structured path (x_pizza gate cats; la_musa variants + photo set)');
}
{
  // NON-VACUITY: the formData must actually be READ. If the branch silently fell back to parsing the
  // form text, a sentinel present only in formData would vanish — and every comparison above would
  // still pass, because both sides would have come from the same text.
  const fd = formDataFromText('x_pizza');
  fd.dishes = fd.dishes.map((d, i) => (i === 0 ? { ...d, desc: 'SENTINEL-ONLY-IN-FORMDATA' } : d));
  const built = buildCatalogV2('x_pizza', { formData: fd, priceTable: MENU_BY_RESTAURANT.x_pizza });
  assert.strictEqual(built.items[0].display.desc, 'SENTINEL-ONLY-IN-FORMDATA', 'the structured path must read formData, not re-parse the form');
  assert.notStrictEqual(readLiteral(formSource('x_pizza'), 'MENU')[0].desc, 'SENTINEL-ONLY-IN-FORMDATA');
  ok('non-vacuity: a sentinel only in formData reaches the build (the path is not silently re-parsing the form)');
}
{
  // The structured path keeps the SAME fail-closed guarantees as the text path — it is a new input
  // shape, not a looser one.
  const fd = formDataFromText('x_pizza');
  assert.throws(() => buildCatalogV2('x_pizza', { formData: { ...fd, dishes: [{ cat: 'individual', name: 'Ghost', price: 1 }] }, priceTable: MENU_BY_RESTAURANT.x_pizza }),
    /bootstrap_unpriced_item|bootstrap_missing_display_record/, 'an unpriced dish still throws');
  assert.throws(() => buildCatalogV2('x_pizza', { formData: { ...fd, dishes: [...fd.dishes, fd.dishes[0]] }, priceTable: MENU_BY_RESTAURANT.x_pizza }),
    /bootstrap_duplicate_key/, 'a duplicate key still throws');
  ok('fail-closed preserved: the structured path still rejects unpriced, missing-display and duplicate keys');
}
console.log(`form-data-path: OK (${n})`);
