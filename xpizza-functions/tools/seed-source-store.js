'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2a Task 3 — seed the SOURCE STORE from code.
//
// This is the one-time inversion: today's menu lives across menu-pricing.js (the authoritative prices)
// and the order forms (every display field, the category structure, variants, photo flags, the gate
// categories, and the extras exposure maps). buildSourceFromCode assembles all of it into the store
// object that becomes the single authority.
//
// The bar is not "produces something plausible" — it is that build-from-store must be BYTE-IDENTICAL
// to build-from-code, which is what makes the cutover a provable no-op. Prices come from
// menu-pricing.js (the authority), never from the forms' inline `price` fields; validateSource then
// requires those inline values to agree, so a form/table disagreement fails closed rather than
// silently picking a side.
//
// Run (owner, controlled):  GOOGLE_CLOUD_PROJECT=xpizza-delivery node tools/seed-source-store.js
// ---------------------------------------------------------------------------
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { formSource, readLiteral, readSetLiteral, pricingKeyOf } = require('../catalog/form-menu-source');
const { attachRedeemFields } = require('../catalog/redeem-source');
const { validateSource, sourceRefOf, canonicalize, extrasKeyOf } = require('../catalog/source-store');

// Pure: assemble the store object for one restaurant from the current code + form sources.
function buildSourceFromCode(restaurantId) {
  const src = formSource(restaurantId);
  const priceTable = MENU_BY_RESTAURANT[restaurantId];
  const extrasTable = EXTRAS_BY_RESTAURANT[restaurantId] || {};
  if (!priceTable) throw new Error(`no_price_table: ${restaurantId}`);

  const dishes = readLiteral(src, 'MENU');
  const hasPhoto = restaurantId === 'la_musa' ? new Set(readSetLiteral(src, 'HAS_PHOTO')) : null;
  const items = dishes.map((display) => {
    const key = pricingKeyOf(restaurantId, display);
    if (typeof key !== 'string' || !key) throw new Error(`seed_bad_key: ${restaurantId}`);
    if (!Object.prototype.hasOwnProperty.call(priceTable, key)) throw new Error(`seed_unpriced_item: ${restaurantId}/${key}`);
    const it = { key, price: priceTable[key], display };          // price from the AUTHORITY, not the form
    if (hasPhoto) it.has_photo = hasPhoto.has(key);
    return it;
  });

  // EXTRAS — the landmine. The pricing key is per-brand and is NOT the form's `id` for x_pizza: an
  // x_pizza extra prices by NAME while carrying a form-local id like 'e1'. Keying by that id would
  // round-trip cleanly, hash stably, and price nothing. Derived through the shared extrasKeyOf so the
  // rule lives in one place, and validateSource re-checks it.
  const extrasDisplay = readLiteral(src, 'EXTRAS');
  const extras = extrasDisplay.map((display) => {
    const key = extrasKeyOf(restaurantId, display);
    if (typeof key !== 'string' || !key) throw new Error(`seed_bad_extra_key: ${restaurantId}`);
    if (!Object.prototype.hasOwnProperty.call(extrasTable, key)) throw new Error(`seed_unpriced_extra: ${restaurantId}/${key}`);
    return { key, price: extrasTable[key], display };
  });
  for (const key of Object.keys(extrasTable)) {
    if (!extras.some((e) => e.key === key)) throw new Error(`seed_missing_extra_display: ${restaurantId}/${key}`);
  }

  const structure = { schema_version: 1, item_order: items.map((i) => i.key) };
  if (restaurantId === 'la_musa') {
    structure.categories = readLiteral(src, 'CATEGORIES');
    structure.variant_items = readLiteral(src, 'VARIANT_ITEMS', '{', '}');
    structure.extras_by_category = readLiteral(src, 'EXTRAS_BY_CATEGORY', '{', '}');
    structure.extras_by_item = readLiteral(src, 'EXTRAS_BY_ITEM', '{', '}');
  } else {
    // x_pizza has no CATEGORIES literal, so the store is AUTHORED to exactly what the text path
    // derives (first appearance in MENU). From here the portal owns them; at cutover the two agree,
    // which is what keeps the flip a byte-identical no-op.
    const order = [];
    for (const d of dishes) if (!order.includes(d.cat)) order.push(d.cat);
    structure.categories = order.map((id) => ({ id }));
    structure.pickup_only_cats = readLiteral(src, 'PICKUP_ONLY_CATS');
    structure.weekend_only_cats = readLiteral(src, 'WEEKEND_ONLY_CATS');
  }

  // 2a Task 6 — redemption eligibility becomes catalog data. Derived from the code allowlists through
  // the SAME function the code-side parity build uses, so the two sides cannot disagree at cutover.
  attachRedeemFields(restaurantId, structure, items, extrasTable);

  // 🔴 THE EXTRA-CATEGORY NAMESPACE, declared rather than inferred. Both shipped forms derive it by
  // first appearance in EXTRAS, which silently couples the ORDER options are offered in to the order
  // rows happen to sit in the array — reorder the array and the menu reorders. Declaring it makes the
  // ordering a published fact, and gives exposure values something to be validated against.
  const extraCategories = [];
  for (const e of extras) {
    const c = e.display && e.display.cat;
    if (typeof c === 'string' && c && !extraCategories.includes(c)) extraCategories.push(c);
  }
  if (extraCategories.length) structure.extra_categories = extraCategories;

  const source = { restaurant_id: restaurantId, schema_version: 2, items, extras, structure };
  validateSource(source, restaurantId);   // fail closed at assembly, not at publish time
  return source;
}

async function seedSourceStore(db, restaurantIds = ['x_pizza', 'la_musa']) {
  const report = {};
  for (const rid of restaurantIds) {
    const source = buildSourceFromCode(rid);
    const ref = sourceRefOf(db, rid);
    const existing = await ref.get();
    if (existing.exists) {
      const same = JSON.stringify(canonicalize(existing.data())) === JSON.stringify(canonicalize(source));
      report[rid] = { existed: true, changed: !same };
    } else {
      report[rid] = { existed: false, changed: true };
    }
    await ref.set(source);   // idempotent: the same code produces the same source
    report[rid].items = source.items.length;
    report[rid].extras = source.extras.length;
  }
  return report;
}

if (require.main === module) {
  try { require('dotenv').config(); } catch (_) { /* devDependency */ }
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: RTDB_URL });
  seedSourceStore(admin.firestore())
    .then((r) => {
      for (const [rid, x] of Object.entries(r)) {
        console.log(`${rid}: ${x.items} items + ${x.extras} extras — ${x.existed ? (x.changed ? 'UPDATED (content differed)' : 'unchanged (idempotent)') : 'created'}`);
      }
      console.log('source store seeded — NOTHING published; run the parity suite, then publish --from-store');
      process.exit(0);
    })
    .catch((e) => { console.error('seed-source-store failed:', e && e.message); process.exit(1); });
}
module.exports = { buildSourceFromCode, seedSourceStore };
