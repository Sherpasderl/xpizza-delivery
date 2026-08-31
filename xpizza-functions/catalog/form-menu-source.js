'use strict';
// ---------------------------------------------------------------------------
// Phase 1c-a — BOOTSTRAP source for the schema-v2 catalog.
//
// The display half of the menu (names, descriptions, categories, tags, emoji, colours, photos,
// variants) exists in exactly one place today: the order forms. The PRICE authority is
// menu-pricing.js. This module reads both and produces the schema-v2 catalog records, so the
// catalog becomes a LOSSLESS full-menu store and 1c-b can regenerate the form bundle from it.
//
// The form arrays are plain object literals, so they are SLICED and EVALUATED rather than
// regex-scraped field by field. Field-wise regex would silently drop any field nobody thought to
// match — the opposite of lossless. Evaluation carries the record verbatim, whatever it contains.
//
// SCHEMA NOTE (executor call, flagged for the gate): the verbatim form dish object is stored NESTED
// under `display`, not flattened alongside key/price. Two reasons. (1) Losslessness is then true by
// CONSTRUCTION — 1c-b regenerates a dish by emitting `display` as-is, with no field mapping to get
// wrong. (2) It avoids a real collision: the form record has its own `price` and `id`, and for
// x_pizza the form `id` is a NUMBER while the pricing key is the name, so flattening would need
// renames that are exactly the kind of silent mapping this phase exists to eliminate.
// `{ key, price }` stay top-level and pristine, so the 1b pricing reader is untouched (PIN 1).
// ---------------------------------------------------------------------------
const { readFileSync } = require('fs');
const { join } = require('path');
const { MENU_BY_RESTAURANT } = require('./../menu-pricing');

// Relative to this file (xpizza-functions/catalog/) → up two, to the repo root.
const FORM_PATH = {
  x_pizza: ['..', '..', 'xpizza-orders', 'index.html'],
  la_musa: ['..', '..', 'la-musa-orders', 'index.html'],
};

// Scan a balanced <open>…<close> region starting at `begin`, counting delimiters ONLY in code
// position: string bodies (single, double, template) and comments are skipped.
//
// A naive raw-character count works on today's forms but would mis-slice the moment a description or
// a comment contained a bracket — and menu copy is free Spanish prose, while the arrays already carry
// `// ── Individual ──`-style comments. The seed re-runs this on EVERY re-seed (it is not a one-time
// bootstrap), so a silent mis-slice is worth designing out rather than documenting around. The
// round-trip parity stays the backstop: a bad slice fails loudly, never seeds silently.
function scanBalanced(src, begin, open, close, label) {
  let depth = 0;
  for (let i = begin; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {                     // string body — skip to its close
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }                     // escaped char inside the string
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const ce = src.indexOf('*/', i); if (ce < 0) break; i = ce + 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(begin, i + 1); }
  }
  throw new Error(`form_literal_unbalanced: ${label}`);
}
// `const NAME = [ … ]` / `const NAME = { … }`
function sliceLiteral(src, name, open, close) {
  const decl = src.indexOf(`const ${name} = ${open}`);
  if (decl < 0) throw new Error(`form_literal_not_found: ${name}`);
  return scanBalanced(src, src.indexOf(open, decl), open, close, name);
}
const evalLiteral = (lit) => new Function(`return (${lit})`)();          // object/array literals only
const readLiteral = (src, name, open = '[', close = ']') => evalLiteral(sliceLiteral(src, name, open, close));
// `const NAME = new Set([ … ])` — slice the inner array with the same scanner.
function readSetLiteral(src, name) {
  const decl = src.indexOf(`const ${name} = new Set(`);
  if (decl < 0) throw new Error(`form_literal_not_found: ${name}`);
  return evalLiteral(scanBalanced(src, src.indexOf('[', decl), '[', ']', name));
}

function formSource(restaurantId, root) {
  const rel = FORM_PATH[restaurantId];
  if (!rel) throw new Error(`unknown_restaurant: ${restaurantId}`);
  return readFileSync(join(root || __dirname, ...rel), 'utf8');
}

// PIN 2 — `key` is the IMMUTABLE pricing identity; `name` is display DATA. x_pizza prices by NAME so
// key === name there (guarded by a test); la_musa prices by the id slug.
const pricingKeyOf = (restaurantId, dish) => (restaurantId === 'la_musa' ? dish.id : dish.name);

// Build the schema-v2 records for one restaurant: items (key + authoritative price + verbatim display)
// and the structure doc (category order/labels, variants, gate flags, and the ITEM ORDER — Firestore
// returns docs in hashed-id order, so the form's array order must be carried explicitly or a
// regenerated bundle would be correct but reordered).
function buildCatalogV2(restaurantId, opts = {}) {
  const src = opts.formSource || formSource(restaurantId, opts.root);
  const priceTable = opts.priceTable || MENU_BY_RESTAURANT[restaurantId];
  if (!priceTable) throw new Error(`no_price_table: ${restaurantId}`);
  const dishes = readLiteral(src, 'MENU');

  const items = dishes.map((dish) => {
    const key = pricingKeyOf(restaurantId, dish);
    if (typeof key !== 'string' || !key) throw new Error(`bootstrap_bad_key: ${restaurantId}/${JSON.stringify(dish).slice(0, 60)}`);
    if (!Object.prototype.hasOwnProperty.call(priceTable, key)) throw new Error(`bootstrap_unpriced_item: ${restaurantId}/${key}`);
    const price = priceTable[key];                                          // menu-pricing is the AUTHORITY
    if (!Number.isInteger(price) || price < 0) throw new Error(`bootstrap_bad_price: ${restaurantId}/${key}`);
    return { key, price, display: dish };
  });

  // Every priced key must have exactly one display record, or the catalog is not lossless.
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.key)) throw new Error(`bootstrap_duplicate_key: ${restaurantId}/${it.key}`);
    seen.add(it.key);
  }
  for (const key of Object.keys(priceTable)) {
    if (!seen.has(key)) throw new Error(`bootstrap_missing_display_record: ${restaurantId}/${key}`);
  }

  const structure = { schema_version: 2, item_order: items.map((i) => i.key) };
  if (restaurantId === 'la_musa') {
    structure.categories = readLiteral(src, 'CATEGORIES');                  // id/name/subcats/layout, in order
    structure.variant_items = readLiteral(src, 'VARIANT_ITEMS', '{', '}');  // launcher → variant ids
    const hasPhoto = new Set(readSetLiteral(src, 'HAS_PHOTO'));
    for (const it of items) it.has_photo = hasPhoto.has(it.key);            // per-item; the Set regenerates from these
  } else {
    // x_pizza has no CATEGORIES literal — the category order IS the order of first appearance in MENU.
    const order = [];
    for (const d of dishes) if (!order.includes(d.cat)) order.push(d.cat);
    structure.categories = order.map((id) => ({ id }));
    structure.pickup_only_cats = readLiteral(src, 'PICKUP_ONLY_CATS');
    structure.weekend_only_cats = readLiteral(src, 'WEEKEND_ONLY_CATS');
  }
  return { items, structure };
}

// The inverse — reconstruct the form's dish array + aux structures from schema-v2 records. 1c-b will
// render a bundle from this; 1c-a uses it to PROVE the round-trip is lossless.
function rebuildFormMenu(restaurantId, items, structure) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const order = (structure && structure.item_order) || items.map((i) => i.key);
  const dishes = order.map((k) => {
    const rec = byKey.get(k);
    if (!rec) throw new Error(`rebuild_missing_item: ${restaurantId}/${k}`);
    return rec.display;
  });
  const out = { dishes };
  if (restaurantId === 'la_musa') {
    out.categories = structure.categories;
    out.variant_items = structure.variant_items;
    out.has_photo = order.filter((k) => byKey.get(k).has_photo).sort();
  } else {
    out.categories = structure.categories;
    out.pickup_only_cats = structure.pickup_only_cats;
    out.weekend_only_cats = structure.weekend_only_cats;
  }
  return out;
}

module.exports = { buildCatalogV2, rebuildFormMenu, formSource, readLiteral, readSetLiteral, pricingKeyOf };
