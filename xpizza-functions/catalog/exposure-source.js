'use strict';
// ---------------------------------------------------------------------------
// Portal 1A Task 8 — express each shipped renderer's EXPOSURE rule as catalog data.
//
// Today "which options is this dish offered" is answered twice, in two forms, in two shapes that
// cannot be compared:
//
//   la_musa  — two real maps, EXTRAS_BY_CATEGORY + EXTRAS_BY_ITEM, which this EXTRACTS verbatim.
//   x_pizza  — nothing. Its renderer offers every extra to every pizza and excludes exactly one dish
//              by a NAME COMPARISON (`pizza.name === 'Nutella'`, xpizza-orders/index.html:3615).
//              There is no literal to read, so this brand's exposure is AUTHORED here.
//
// 🔴 AUTHORED MEANS TIED TO THE RENDERER, NOT GUESSED. A transcription of a `.js` line into a
// constant drifts the moment someone adds a second excluded dish, and nothing would notice — the
// catalog would keep offering options for a pizza the form refuses to show them for. So
// assertExposureMatchesToday() reads the SHIPPED FORM and fails if the set of name-excluded dishes is
// not exactly the set authored here. The constant is the data; the guard is what keeps it true.
//
// THE SINGLE DERIVATION, used by BOTH the code-side build (what the pre-flip parity gate compares
// against) and the migration (which authors the store). One function, so the two cannot drift and the
// cutover stays a provable no-op — the same shape redeem-source.js already uses for redemption.
//
// Per-brand literals are deliberate here and are NOT the brand-agnostic violation the slice forbids:
// this module's entire job is to record what each brand's DEPLOYED renderer does today. The rule the
// validator, reader and resolver obey stays brand-agnostic; only this transcription is per-brand, and
// a brand that is not listed simply has no exposure to migrate.
// ---------------------------------------------------------------------------
const { deriveLegacyMaps, ALL } = require('./extras-exposure');

// x_pizza's renderer excludes these dishes from extras entirely, by name. Authored as data so a
// merchant could change it; guarded against the form so it cannot silently stop being true.
const X_PIZZA_NO_EXTRAS = ['Nutella'];

const RENDERERS = {
  // allow-all + a per-item deny; there is no map in the form to read
  x_pizza: { authored: true, noExtras: X_PIZZA_NO_EXTRAS },
  // two real maps; extracted verbatim
  la_musa: { authored: false },
};

// ctx in the shape extras-exposure.js consumes (camelCase), from the shape the structure persists
// (snake_case, matching item_order / extra_order / extras_by_category around it).
const exposureCtx = (exposure) => ({
  categoryAllow: (exposure && exposure.category_allow) || {},
  itemOverrides: (exposure && exposure.item_overrides) || {},
});

// THE DERIVATION. `byCategory`/`byItem` are the brand's own maps when it has them — from the form
// literal at bootstrap, or from the draft being upgraded. They are ignored for an authored brand,
// which by definition has none.
function deriveExposure(restaurantId, { dishCategories = [], extraCategories = [], items = [], byCategory = null, byItem = null } = {}) {
  const spec = RENDERERS[restaurantId];
  if (!spec) return null;                     // a brand with no shipped renderer to transcribe

  if (!spec.authored) {
    if (!byCategory || typeof byCategory !== 'object') {
      throw new Error(`exposure_source_missing: ${restaurantId} — this brand's exposure is EXTRACTED, and there is no map to extract from`);
    }
    const category_allow = {};
    for (const [cat, allow] of Object.entries(byCategory)) category_allow[cat] = (allow || []).slice();
    const item_overrides = {};
    for (const [key, add] of Object.entries(byItem || {})) {
      if ((add || []).length) item_overrides[key] = { add: add.slice() };
    }
    return { category_allow, item_overrides };
  }

  // AUTHORED: every dish category is offered every extra category...
  const category_allow = {};
  for (const cat of dishCategories) category_allow[cat] = extraCategories.slice();
  // ...and the named dishes are offered nothing at all.
  const item_overrides = {};
  const keys = new Set(items.map((i) => i.key));
  for (const key of spec.noExtras) {
    // A dish that has been renamed or removed must not quietly lose its exclusion: the catalog would
    // start offering extras for a pizza the form still refuses to show them for, and the only symptom
    // would be a customer being offered pepperoni on a Nutella dessert.
    if (!keys.has(key)) {
      throw new Error(`exposure_source_missing_item: ${restaurantId}/${key} — the dish this exclusion names is not in the menu`);
    }
    item_overrides[key] = { deny: [ALL] };
  }
  return { category_allow, item_overrides };
}

// 🔴 THE GUARD. Reads the SHIPPED form and confirms the authored exclusion set is exactly what the
// renderer applies. `formText` is the deployed artifact; the caller supplies it so this module needs
// no dependency on the form reader (and no require cycle with it).
function assertExposureMatchesToday(restaurantId, formText) {
  const spec = RENDERERS[restaurantId];
  if (!spec || !spec.authored) return true;
  // Every `X.name === '…'` / `X.name !== '…'` comparison the renderer makes against a dish name. That
  // is the construct the exclusion is written in, so a SECOND one appearing is exactly the drift this
  // catches.
  const found = new Set([...String(formText).matchAll(/\.name\s*[!=]==\s*'([^']+)'/g)].map((m) => m[1]));
  const authored = new Set(spec.noExtras);
  const missing = [...authored].filter((k) => !found.has(k));
  const extra = [...found].filter((k) => !authored.has(k));
  if (missing.length || extra.length) {
    throw new Error(`exposure_source_drift: ${restaurantId} — the form compares dish names ${JSON.stringify([...found])} `
      + `but the authored exclusion set is ${JSON.stringify([...authored])}; author the difference rather than letting the two disagree`);
  }
  return true;
}

// Attach the exposure to a structure, plus the LEGACY maps derived from it.
//
// The legacy maps are OUTPUT, never a second source. They are what pre-1B consumers read, they cannot
// express a deny (the shape is purely additive), and a round trip through them is lossy by
// construction — so they are re-derived here on every build rather than carried alongside.
function attachExposure(restaurantId, structure, items, { byCategory = null, byItem = null } = {}) {
  // An exposure the STORE already authored is the authority — derived only when there is none, which
  // is the bootstrap and the migration. Checked by key: an authored `exposure: null` is a malformed
  // document for the validator to refuse, not an invitation to re-derive one over it.
  if (!Object.prototype.hasOwnProperty.call(structure, 'exposure')) {
    const exposure = deriveExposure(restaurantId, {
      dishCategories: (structure.categories || []).map((c) => c.id),
      extraCategories: structure.extra_categories || [],
      items,
      byCategory,
      byItem,
    });
    if (!exposure) return structure;
    structure.exposure = exposure;
  }
  const legacy = deriveLegacyMaps(items, exposureCtx(structure.exposure));
  // Omitted when empty rather than written as {}: an empty map is not a fact about the menu, and a
  // field that exists only sometimes is easier to read than one that is always there and usually blank.
  if (Object.keys(legacy.byCategory).length) structure.extras_by_category = legacy.byCategory;
  else delete structure.extras_by_category;
  if (Object.keys(legacy.byItem).length) structure.extras_by_item = legacy.byItem;
  else delete structure.extras_by_item;
  return structure;
}

module.exports = { deriveExposure, attachExposure, assertExposureMatchesToday, exposureCtx, X_PIZZA_NO_EXTRAS, RENDERERS };
