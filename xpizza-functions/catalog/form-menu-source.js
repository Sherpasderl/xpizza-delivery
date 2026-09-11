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
const { attachRedeemFields } = require('./redeem-source');
const { attachExposure } = require('./exposure-source');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./../menu-pricing');

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
//
// 1c-b3 COUPLING (important): the form cutover renames each hard-coded literal to `FALLBACK_<NAME>`
// during the expand phase, because the served value now comes from the generated bundle. This
// bootstrap reads the FORM, so it must accept either spelling or the seed itself breaks the moment
// the forms are cut over — and re-seeding is an owner operation that runs on every menu change.
// Both names are tried, `NAME` first (pre-cutover), then `FALLBACK_NAME` (post-cutover). When 1d makes
// the catalog authoritative the form stops being a source at all and this lookup retires with it.
// The cutover's fallback names are spelled out rather than derived, because two of them are not a
// plain prefix of the original (PICKUP_ONLY_CATS → FALLBACK_PICKUP_ONLY).
const FALLBACK_ALIAS = { PICKUP_ONLY_CATS: 'FALLBACK_PICKUP_ONLY', WEEKEND_ONLY_CATS: 'FALLBACK_WEEKEND_ONLY' };
function literalNames(name) { return [name, FALLBACK_ALIAS[name] || `FALLBACK_${name}`]; }
function findDecl(src, name, open) {
  for (const candidate of literalNames(name)) {
    const at = src.indexOf(`const ${candidate} = ${open}`);
    if (at >= 0) return { at, candidate };
  }
  return null;
}
function sliceLiteral(src, name, open, close) {
  const found = findDecl(src, name, open);
  if (!found) throw new Error(`form_literal_not_found: ${name} (tried ${literalNames(name).join(', ')})`);
  return scanBalanced(src, src.indexOf(open, found.at), open, close, found.candidate);
}
const evalLiteral = (lit) => new Function(`return (${lit})`)();          // object/array literals only
const readLiteral = (src, name, open = '[', close = ']') => evalLiteral(sliceLiteral(src, name, open, close));
// `const NAME = new Set([ … ])` — slice the inner array with the same scanner.
function readSetLiteral(src, name) {
  // Post-1c-b3 the form keeps the plain ARRAY as `FALLBACK_<NAME>` (the Set is constructed by the
  // validated select), so accept both the `new Set([…])` and the bare-array spellings.
  for (const candidate of literalNames(name)) {
    // Require `new Set([` — the literal form. After the 1c-b3 cutover the form also contains
    // `const HAS_PHOTO = new Set(<validated select>)`, which must NOT be mistaken for the data.
    const asSet = src.indexOf(`const ${candidate} = new Set([`);
    if (asSet >= 0) return evalLiteral(scanBalanced(src, src.indexOf('[', asSet), '[', ']', candidate));
    const asArr = src.indexOf(`const ${candidate} = [`);
    if (asArr >= 0) return evalLiteral(scanBalanced(src, src.indexOf('[', asArr), '[', ']', candidate));
  }
  throw new Error(`form_literal_not_found: ${name} (tried ${literalNames(name).join(', ')})`);
}

function formSource(restaurantId, root) {
  const rel = FORM_PATH[restaurantId];
  if (!rel) throw new Error(`unknown_restaurant: ${restaurantId}`);
  return readFileSync(join(root || __dirname, ...rel), 'utf8');
}

// PIN 2 — `key` is the IMMUTABLE pricing identity; `name` is display DATA. x_pizza prices by NAME so
// key === name there (guarded by a test); la_musa prices by the id slug.
const pricingKeyOf = (restaurantId, dish) => (restaurantId === 'la_musa' ? dish.id : dish.name);

// The EXTRAS pricing key — the mirror of the rule above, carrying the same per-brand asymmetry:
// x_pizza extras price by NAME (their display `id` is a form-local handle like 'e1' that prices
// nothing), la_musa extras by that id slug.
//
// It lived in source-store.js under a comment saying it was "kept beside the item rule so the two
// cannot drift apart" — while sitting in a different module from it. Moved here, where that is true.
const extrasKeyOf = (restaurantId, display) => (restaurantId === 'la_musa' ? (display && display.id) : (display && display.name));

// Build the schema-v2 records for one restaurant: items (key + authoritative price + verbatim display)
// and the structure doc (category order/labels, variants, gate flags, and the ITEM ORDER — Firestore
// returns docs in hashed-id order, so the form's array order must be carried explicitly or a
// regenerated bundle would be correct but reordered).
// Portal 2a: `opts.formData` is the STRUCTURED input path — the same build, fed from the source store
// instead of parsed form text. It must produce byte-identical {items, structure}: the cutover's
// "provable no-op" claim rests entirely on these two paths being interchangeable, so the branch below
// changes only WHERE each value comes from, never how it is assembled or validated.
//
// When formData is absent the text path is used unchanged, so every existing caller is untouched.
function buildCatalogV2(restaurantId, opts = {}) {
  const fd = opts.formData || null;
  const src = fd ? null : (opts.formSource || formSource(restaurantId, opts.root));
  const priceTable = opts.priceTable || MENU_BY_RESTAURANT[restaurantId];
  if (!priceTable) throw new Error(`no_price_table: ${restaurantId}`);
  if (fd && !Array.isArray(fd.dishes)) throw new Error(`formdata_missing_dishes: ${restaurantId}`);
  const dishes = fd ? fd.dishes : readLiteral(src, 'MENU');

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

  // 🔴 EXTRAS TRAVEL WITH THE BUILD. sourceToBuildInputs has produced extras_display all along and
  // this function dropped it on the floor, so a built catalog could PRICE an extra and not NAME it.
  // The numeric table is untouched — the display record is carried ALONGSIDE it, never inside it.
  const extrasTable = opts.extrasTable || EXTRAS_BY_RESTAURANT[restaurantId] || {};
  const extrasDisplay = fd ? (fd.extras_display || null) : readLiteral(src, 'EXTRAS');
  const extras = [];
  const byKey = new Set();
  for (const display of (extrasDisplay || [])) {
    const key = extrasKeyOf(restaurantId, display);
    if (typeof key !== 'string' || !key) throw new Error(`bootstrap_bad_extra_key: ${restaurantId}`);
    if (byKey.has(key)) throw new Error(`bootstrap_duplicate_extra_key: ${restaurantId}/${key}`);
    if (!Object.prototype.hasOwnProperty.call(extrasTable, key)) throw new Error(`bootstrap_unpriced_extra: ${restaurantId}/${key}`);
    byKey.add(key);
    extras.push({ key, price: extrasTable[key], display });   // the AUTHORITY prices it, never the display record
  }
  // 🔴 OUTSIDE THE GUARD. This completeness check sat inside `if (extrasDisplay)`, so a MISSING display
  // collection skipped it entirely: 14 priced extras, zero display records, and no error — a catalog
  // that charges for options it cannot name. Presence of the collection decided whether the collection
  // was checked, which is the fail-open shape again, one call frame out from where it was last found.
  //
  // Every priced key needs exactly one display record, whether or not any were supplied at all.
  for (const key of Object.keys(extrasTable)) {
    if (!byKey.has(key)) throw new Error(`bootstrap_missing_extra_display_record: ${restaurantId}/${key}`);
  }
  // 🔴 EXTRA_ORDER IS THE MIRROR OF ITEM_ORDER, and it exists for the same reason: Firestore hands
  // docs back in hashed-id order, so an ordering that is not carried explicitly is an ordering that
  // is lost. Items have had this since 1c-a; extras never did, because nothing read them back. Once
  // the reader returns extras, "which option comes first in the group" is a customer-visible fact
  // with no other home — it cannot be derived from the category namespace (that orders the GROUPS)
  // and it cannot be derived from the keys (sorting them would reorder the menu).
  const structure = { schema_version: 2, item_order: items.map((i) => i.key), extra_order: extras.map((e) => e.key) };
  // 1A Task 4 — the display structures the build used to drop. Each comes from the STORE when the
  // store authored it (the portal owns these once a merchant has edited them) and from the form
  // literal otherwise, which is the same source the seed bootstraps from — so the two paths agree at
  // cutover and the parity gate can prove it.
  // A form literal this brand may simply not declare — x_pizza has no exposure maps at all.
  const safeLiteral = (name) => { try { return readLiteral(src, name, '{', '}'); } catch (_) { return null; } };
  const carryStructure = (field, fromLiteral) => {
    if (fd) { if (fd[field] !== undefined) structure[field] = fd[field]; return; }
    try { const v = fromLiteral(); if (v !== undefined && v !== null) structure[field] = v; } catch (_) { /* this brand's form declares none */ }
  };
  if (restaurantId === 'la_musa') {
    structure.categories = fd ? fd.categories : readLiteral(src, 'CATEGORIES');                 // id/name/subcats/layout, in order
    // launcher → variant ids. The form literal also carries a basePrice; it is STRIPPED here, because
    // "desde" is derived at emission and an authored copy is only something to drift.
    const authoredVariants = fd ? fd.variant_items : readLiteral(src, 'VARIANT_ITEMS', '{', '}');
    if (authoredVariants) {
      structure.variant_items = {};
      for (const [k, spec] of Object.entries(authoredVariants)) {
        const { basePrice, ...rest } = spec;      // eslint-disable-line no-unused-vars
        structure.variant_items[k] = rest;
      }
    }
    const hasPhoto = new Set(fd ? (fd.has_photo || []) : readSetLiteral(src, 'HAS_PHOTO'));
    for (const it of items) it.has_photo = hasPhoto.has(it.key);            // per-item; the Set regenerates from these
  } else {
    // x_pizza has no CATEGORIES literal, so the TEXT path derives the category order from the order of
    // first appearance in MENU — it has nothing else to bootstrap from. The STRUCTURED path reads the
    // store's authored categories instead, uniformly with la_musa, so a merchant can rename, reorder
    // and group categories in the portal rather than having them silently follow dish `cat` values.
    // The seed authors x_pizza's categories to exactly this derived result, so the two paths agree at
    // cutover and the parity gate enforces it; self-consistency is guarded by validateSource, which
    // requires the authored categories to be a superset of the categories the dishes actually use.
    if (fd) {
      structure.categories = fd.categories;
    } else {
      const order = [];
      for (const d of dishes) if (!order.includes(d.cat)) order.push(d.cat);
      structure.categories = order.map((id) => ({ id }));
    }
    structure.pickup_only_cats = fd ? fd.pickup_only_cats : readLiteral(src, 'PICKUP_ONLY_CATS');
    structure.weekend_only_cats = fd ? fd.weekend_only_cats : readLiteral(src, 'WEEKEND_ONLY_CATS');
  }
  // 2a Task 6 — redemption eligibility. The order forms carry no literal for this (it lives in
  // rewards-redeem-config.js), so BOTH paths derive it from that code authority: the store path so the
  // seed can author it, the text path so the pre-flip parity gate has something to compare against.
  // Without it on the code side, every publish would trip the gate on a field code never emitted.
  // The option-group namespace and the badge definitions — display structures the build used to drop.
  // The namespace is DERIVED from the extras' own categories when the form is the source, exactly as
  // the seed derives it, so both bootstrap paths produce the same ordering.
  carryStructure('badges', () => readLiteral(src, 'TAG_BADGES', '{', '}'));
  // 🔴 THE STORE WINS ONCE IT HAS AUTHORED ONE. This read `structure.extra_categories === undefined`
  // without ever COPYING fd.extra_categories, so the check always fell through and a merchant who
  // reordered their option groups had that order silently replaced by first-appearance .cat order.
  // Source-inversion is the point of the whole slice: derivation is the BOOTSTRAP, not the authority.
  //
  // Invisible to the parity gate, because at bootstrap the authored order IS the derived order.
  carryStructure('extra_categories', () => undefined);
  if (structure.extra_categories === undefined) {
    const cats = [];
    for (const e of extras) {
      const c = e.display && e.display.cat;
      if (typeof c === 'string' && c && !cats.includes(c)) cats.push(c);
    }
    if (cats.length) structure.extra_categories = cats;
  }

  // 🔴 EXPOSURE — which options each dish is offered — and the LEGACY maps DERIVED from it.
  //
  // The maps used to be carried straight from the form literal, which made them a second authored
  // source for a fact the exposure model already owns, and one that cannot express a deny: the shape
  // is purely additive, so x_pizza's "Nutella is offered nothing" is not representable in it at all.
  // They are output now, re-derived on every build. The store's own exposure wins once it has one;
  // otherwise it is extracted from the brand's maps (la_musa) or authored from its renderer (x_pizza).
  //
  // After extra_categories, deliberately: an authored allow-all is a list OF those categories.
  carryStructure('exposure', () => undefined);
  attachExposure(restaurantId, structure, items, {
    byCategory: fd ? fd.extras_by_category : safeLiteral('EXTRAS_BY_CATEGORY'),
    byItem: fd ? fd.extras_by_item : safeLiteral('EXTRAS_BY_ITEM'),
  });

  const REDEEM_FIELDS = ['redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras'];
  if (fd && REDEEM_FIELDS.some((f) => fd[f] !== undefined)) {
    // The STORE authored it → the store wins. This is the whole inversion: once a merchant edits
    // eligibility in the portal, the code constants must stop having a vote.
    for (const f of REDEEM_FIELDS) if (fd[f] !== undefined) structure[f] = fd[f];
  } else {
    attachRedeemFields(restaurantId, structure, items, opts.extrasTable || EXTRAS_BY_RESTAURANT[restaurantId]);
  }
  return { items, extras, structure };
}

// 🔴 "DESDE" IS DERIVED, EVERY TIME. The launcher keeps its own authoritative price — a bare launcher
// id is orderable and costs that (menu-pricing.js:83) — while the customer is shown the cheapest thing
// they can actually pick. Two different facts about the same dish: Pad Thai launches at L414 and
// starts from L307.
//
// Derived rather than authored because an authored copy is a number that can disagree with the
// variants it claims to summarise, and nothing about it would look wrong. Nobody notices "desde L 307"
// over a menu whose cheapest protein is now L280 until a customer does.
//
// Returns null rather than a guess when no variant carries a usable price: a starting price that is
// not a real variant's price is worse than none, because the form would render it.
function deriveStartingPrice(launcher, variants) {
  void launcher;                       // the launcher's own price is deliberately NOT an input
  const prices = (variants || [])
    .map((v) => v && v.price)
    .filter((p) => Number.isInteger(p) && p > 0);
  return prices.length ? Math.min(...prices) : null;
}

// The inverse — reconstruct the form's dish array + aux structures from schema-v2 records. 1c-b will
// render a bundle from this; 1c-a uses it to PROVE the round-trip is lossless.
// The LAUNCHER MAP as it is SERVED: label + variant ids as authored, and a "desde" DERIVED at
// emission from the variants those ids name. Shared by the bundle generator and the catalog reader —
// one definition, so a version cannot generate one starting price and read back another.
//
// The shape is the one the form literal had (label, basePrice, variantIds, then anything else), so
// the regenerated bundle is byte-identical to what ships today. `basePrice` is destructured OUT
// explicitly: without that it lands in `...others`, and the spread comes last — a stale authored
// copy would overwrite the value just derived, which is the one thing this emission exists to
// prevent.
function resolveVariants(items, structure) {
  const out = {};
  const spec_map = (structure && structure.variant_items) || null;
  if (!spec_map || typeof spec_map !== 'object') return out;
  const byUiId = new Map(items.map((i) => [String(i.display && i.display.id), i]));
  for (const [launcherId, spec] of Object.entries(spec_map)) {
    const variants = (spec.variantIds || []).map((id) => byUiId.get(String(id))).filter(Boolean);
    const { label, basePrice: _authored, variantIds, ...others } = spec;    // eslint-disable-line no-unused-vars
    out[launcherId] = { label, basePrice: deriveStartingPrice(byUiId.get(String(launcherId)), variants), variantIds, ...others };
  }
  return out;
}

function rebuildFormMenu(restaurantId, items, structure, extras) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const order = (structure && structure.item_order) || items.map((i) => i.key);
  const dishes = order.map((k) => {
    const rec = byKey.get(k);
    if (!rec) throw new Error(`rebuild_missing_item: ${restaurantId}/${k}`);
    return rec.display;
  });
  // 🔴 EXTRAS ARE REQUIRED, not optional. Emitting them "when supplied" would mean a caller that
  // forgot produces a bundle with no options on it and no error — a menu whose every dish silently
  // loses its add-ons. The one thing this task exists to fix must not be skippable by omission.
  if (!Array.isArray(extras)) {
    throw new Error(`rebuild_missing_extras: ${restaurantId} — the bundle must carry the extras display records`);
  }
  const byExtraKey = new Map(extras.map((e) => [e.key, e]));
  const extraOrder = (structure && structure.extra_order) || extras.map((e) => e.key);
  const out = {
    dishes,
    extras: extraOrder.map((k) => {
      const rec = byExtraKey.get(k);
      if (!rec) throw new Error(`rebuild_missing_extra: ${restaurantId}/${k}`);
      return rec.display;
    }),
  };
  if (restaurantId === 'la_musa') {
    out.categories = structure.categories;
    // THE COMPAT ALIAS. 1A ships before 1B, and the live form reads variant_items[...].basePrice for
    // its "desde" and its per-choice delta maths (la-musa-orders/index.html:1974, 2165, 4136, 4144).
    // Emitting only a new field would render "desde L undefined" and wrong deltas on a form nobody has
    // updated yet — so the bundle still carries basePrice, now DERIVED here rather than authored
    // upstream. It is an output of the variants, computed at emission, and there is no stored copy of
    // it anywhere for the two to drift apart.
    // Emitted by the SAME resolver the READER uses, so the bundle's variants and the reader's
    // variants cannot say different things about the same version — the parity gate compares two
    // outputs of one function rather than two implementations that happen to agree today.
    if (Object.prototype.hasOwnProperty.call(structure, 'variant_items') && structure.variant_items) {
      out.variant_items = resolveVariants(items, structure);
    }
    out.has_photo = order.filter((k) => byKey.get(k).has_photo).sort();
  } else {
    out.categories = structure.categories;
    out.pickup_only_cats = structure.pickup_only_cats;
    out.weekend_only_cats = structure.weekend_only_cats;
  }
  return out;
}

module.exports = { buildCatalogV2, rebuildFormMenu, resolveVariants, deriveStartingPrice, formSource, readLiteral, readSetLiteral, pricingKeyOf, extrasKeyOf };
