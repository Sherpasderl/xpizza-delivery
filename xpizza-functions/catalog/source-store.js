'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2a — THE SOURCE STORE. `restaurants/{rid}/meta/source` becomes the single authority
// for everything menu-derived: prices, display records, category structure, variants, photo flags,
// the gate categories, and the form-side extras exposure maps.
//
// Everything here is FAIL-CLOSED. A source that is missing, malformed, or internally inconsistent
// throws rather than returning partial build inputs — a half-read source would publish a half-menu,
// and a publish is what customers are charged from.
//
// KEY ASYMMETRY (the thing most likely to be got wrong): the pricing key is per-brand, and it applies
// to EXTRAS as well as items. x_pizza keys both by NAME; la_musa keys both by ID. The store carries
// `key` explicitly and validates it against the display record, so the two can never drift apart.
// ---------------------------------------------------------------------------
const { pricingKeyOf } = require('./form-menu-source');

// The code-path literals this schema covers. The completeness test asserts every literal the code
// path reads appears here — so a future code-only field cannot silently become uneditable in 2b.
// EXTRAS / EXTRAS_BY_CATEGORY / EXTRAS_BY_ITEM are form-side (no server consumer today) but are
// menu-derived data the portal must own, so they are carried too.
const SOURCE_COVERED_LITERALS = [
  'MENU', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS',
  'EXTRAS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM',
];

const sourceRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('source');

// Stable RECURSIVE key ordering. Arrays are left alone: their order is CONTENT here (item_order,
// categories, variant lists), and sorting them would silently rewrite the menu.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

const isPositiveInt = (p) => Number.isInteger(p) && p > 0;   // same rule as the reader + the calculators

function fail(msg) { throw new Error(`source_malformed: ${msg}`); }

// Reject anything that could produce a wrong or partial build. Ordering of checks is deliberate:
// identity → shape → values → bijection → structural coverage, so the error names the first real problem.
function validateSource(source, rid) {
  if (!source || typeof source !== 'object') fail(`${rid} — source is not an object`);
  if (source.restaurant_id !== rid) fail(`${rid} — restaurant_id mismatch (${String(source.restaurant_id)})`);
  if (!Array.isArray(source.items) || source.items.length === 0) fail(`${rid} — items must be a non-empty array`);
  if (!Array.isArray(source.extras)) fail(`${rid} — extras must be an array`);
  const st = source.structure;
  if (!st || typeof st !== 'object') fail(`${rid} — structure missing`);
  if (!Array.isArray(st.categories) || st.categories.length === 0) fail(`${rid} — structure.categories must be a non-empty array`);
  if (!Array.isArray(st.item_order)) fail(`${rid} — structure.item_order must be an array`);

  const catIds = new Set(st.categories.map((c) => c && c.id));
  const seen = new Set();
  for (const it of source.items) {
    if (!it || typeof it !== 'object') fail(`${rid} — a non-object item`);
    if (typeof it.key !== 'string' || !it.key) fail(`${rid} — item missing a string key`);
    if (!isPositiveInt(it.price)) fail(`${rid}/${it.key} — price is not a positive integer`);
    if (!it.display || typeof it.display !== 'object') fail(`${rid}/${it.key} — item missing its display record`);
    // The key IS the pricing identity; it must agree with the display record it describes, or an edit
    // to the display name would silently reprice (x_pizza) or orphan (la_musa) the item.
    const derived = pricingKeyOf(rid, it.display);
    if (derived !== it.key) fail(`${rid}/${it.key} — key does not match its display record (derived ${String(derived)})`);
    if (seen.has(it.key)) fail(`${rid}/${it.key} — duplicate item key`);
    seen.add(it.key);
    if (it.display.cat != null && !catIds.has(it.display.cat)) fail(`${rid}/${it.key} — references unknown category ${it.display.cat}`);
  }
  const eseen = new Set();
  for (const ex of source.extras) {
    if (!ex || typeof ex.key !== 'string' || !ex.key) fail(`${rid} — extra missing a string key`);
    if (!isPositiveInt(ex.price)) fail(`${rid}/extra ${ex.key} — price is not a positive integer`);
    if (eseen.has(ex.key)) fail(`${rid}/extra ${ex.key} — duplicate extra key`);
    eseen.add(ex.key);
  }
  // item_order must be a BIJECTION with items — the same three-legged check the display reader uses.
  // Any two of exists/length/uniqueness can hold while the menu is still wrong.
  if (new Set(st.item_order).size !== st.item_order.length) fail(`${rid} — item_order has duplicate keys`);
  for (const k of st.item_order) if (!seen.has(k)) fail(`${rid} — item_order references missing item ${k}`);
  if (st.item_order.length !== source.items.length) fail(`${rid} — item_order covers ${st.item_order.length} of ${source.items.length} items`);
  // the gate categories must exist, or a gate would silently apply to nothing
  for (const field of ['pickup_only_cats', 'weekend_only_cats']) {
    const arr = st[field];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) fail(`${rid} — structure.${field} must be an array`);
    for (const c of arr) if (!catIds.has(c)) fail(`${rid} — structure.${field} references unknown category ${c}`);
  }
  if (st.extras_by_category) {
    for (const c of Object.keys(st.extras_by_category)) if (!catIds.has(c)) fail(`${rid} — extras_by_category references unknown category ${c}`);
  }
  if (st.extras_by_item) {
    for (const k of Object.keys(st.extras_by_item)) if (!seen.has(k)) fail(`${rid} — extras_by_item references unknown item ${k}`);
  }
}

// Map the store object to EXACTLY the shapes buildCatalogV2 consumes. Items are emitted in
// item_order, so the built structure's ordering comes from the store rather than array happenstance.
function sourceToBuildInputs(source) {
  const byKey = new Map(source.items.map((i) => [i.key, i]));
  const ordered = source.structure.item_order.map((k) => byKey.get(k));
  const priceTable = {};
  for (const i of ordered) priceTable[i.key] = i.price;
  const extras = {};
  for (const e of source.extras) extras[e.key] = e.price;
  const formData = {
    dishes: ordered.map((i) => i.display),                    // VERBATIM — losslessness is by construction
    item_order: source.structure.item_order.slice(),
    categories: source.structure.categories,
    has_photo: ordered.filter((i) => i.has_photo).map((i) => i.key),
  };
  for (const f of ['variant_items', 'pickup_only_cats', 'weekend_only_cats', 'extras_by_category', 'extras_by_item']) {
    if (source.structure[f] !== undefined) formData[f] = source.structure[f];
  }
  if (Array.isArray(source.extras) && source.extras.some((e) => e.display)) {
    formData.extras_display = source.extras.map((e) => e.display).filter(Boolean);
  }
  return { priceTable, formData, extras };
}

// Read + validate in one step. There is deliberately no "read without validating" export: every
// consumer of the source gets a validated one or an exception.
async function readSource(db, rid) {
  const snap = await sourceRefOf(db, rid).get();
  if (!snap || !snap.exists) throw new Error(`source_missing: ${rid}`);
  const source = snap.data();
  validateSource(source, rid);
  return source;
}

module.exports = { readSource, validateSource, sourceToBuildInputs, canonicalize, sourceRefOf, isPositiveInt, SOURCE_COVERED_LITERALS };
