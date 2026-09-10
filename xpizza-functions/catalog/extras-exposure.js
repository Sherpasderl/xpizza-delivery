// Task 1 — THE EXPOSURE RESOLVER: which options a customer is offered for an item.
//
// 🔴 DISPLAY AND ELIGIBILITY ONLY. Exposure decides what a customer is SHOWN; it never decides what
// anything costs. Nothing here may become a charging restriction — the numeric pricing tables are a
// separate namespace and are untouched by this file.
//
// Today the same question is answered twice, differently, in two shipped forms:
//
//   x_pizza  — every pizza is offered every extra, except Nutella, excluded by a NAME literal in the
//              renderer (`pizza.name === 'Nutella'`, xpizza-orders/index.html:3615).
//   la_musa  — a category → extra-category map plus a per-item additions map
//              (EXTRAS_BY_CATEGORY / EXTRAS_BY_ITEM, la-musa-orders/index.html:1895,1930).
//
// Neither is data the catalog owns, so a merchant cannot change either, and the two cannot be reasoned
// about together. This is the ONE representation both reduce to:
//
//     exposed(item) = (its category's allow-list) − (item deny) + (item add)
//
// ordered by (extra-category order, then extras order within that category).
//
// Legacy maps are DERIVED from this (deriveLegacyMaps), never authored alongside it. Two authored
// sources for one fact is the shape of every drift bug this slice exists to remove.

// The deny sentinel: "this item is offered nothing at all". Nutella is the only user today, and
// expressing it as data is the point — a name comparison in a renderer is not something a merchant
// can edit, review, or publish.
const ALL = '*';

const asArray = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));

// An item's own overrides, or — for a variant that declares none — its launcher's.
//
// A variant is the same dish with a protein chosen; being offered a different option set from the
// launcher it was reached through would be a UI that changes under the customer. Today this is inert
// (no launcher carries an item-level override, and variants share their launcher's category, so the
// category allow-list already gives them the same set) — it is stated forward so that the first
// launcher override does not silently fail to reach its variants.
function overridesFor(item, itemOverrides, itemsByKey) {
  const own = itemOverrides[item.key];
  if (own) return own;
  const parentKey = item.variantOf || (itemsByKey[item.key] && itemsByKey[item.key].variantOf);
  if (parentKey && itemOverrides[parentKey]) return itemOverrides[parentKey];
  return {};
}

// resolveExposure(item, ctx) -> ordered extra keys.
//
// ctx carries the four inputs the plan names — categoryAllow, the extra-category order, the extras
// list, and the item — plus the two the committed contract requires: the per-item overrides that
// express deny/add, and the item index used to resolve a variant's launcher.
function resolveExposure(item, ctx) {
  const { categoryAllow = {}, extras = [], itemOverrides = {}, itemsByKey = {} } = ctx || {};
  const extraCategories = ctx && ctx.extraCategories ? ctx.extraCategories : [...new Set(extras.map((e) => e.cat))];

  const ov = overridesFor(item, itemOverrides, itemsByKey);
  const deny = asArray(ov.deny);
  if (deny.includes(ALL)) return [];                       // offered nothing, and nothing else to compute

  // Start from the item's dish-category allow-list. An unlisted category exposes nothing, which is
  // how la_musa's unmapped categories behave today.
  const allowedCats = new Set(asArray(categoryAllow[item.cat]));
  const allowedKeys = new Set();

  // ADD may name an extra-category or an individual extra, so a single option can be exposed without
  // dragging its whole category along.
  for (const a of asArray(ov.add)) {
    if (extraCategories.includes(a)) allowedCats.add(a);
    else allowedKeys.add(a);
  }
  // DENY removes either, and is applied AFTER add so that an explicit removal always wins — an
  // override that both adds and denies the same thing resolves to "not offered", which is the
  // fail-closed reading.
  for (const d of deny) {
    allowedCats.delete(d);
    allowedKeys.delete(d);
  }
  const denied = new Set(deny);

  // ORDER: extra-category order first, then extras order within the category. Both shipped renderers
  // produce this today — x_pizza by construction (it loops categories, then filters extras within
  // each), la_musa incidentally, because its EXTRAS array happens to be grouped by category. They are
  // NOT the same rule, and this one is the grouped one; see the handback note.
  const out = [];
  const seen = new Set();
  const emit = (e) => {
    const key = e.id !== undefined ? String(e.id) : String(e.key);
    if (seen.has(key) || denied.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  for (const cat of extraCategories) {
    for (const e of extras) {
      if (e.cat !== cat) continue;
      const key = e.id !== undefined ? String(e.id) : String(e.key);
      if (allowedCats.has(cat) || allowedKeys.has(key)) emit(e);
    }
  }
  return out;
}

// The legacy per-category / per-item maps, DERIVED. They exist only so pre-1B consumers keep working;
// nothing in the catalog may read them back as a source of truth.
//
// They cannot express a deny — the legacy shape is purely additive — which is exactly why they are an
// output. An exposure that removes something (Nutella) is not representable here, so a round-trip
// through these maps is lossy by construction and must never be treated as the contract.
function deriveLegacyMaps(items, ctx) {
  const { categoryAllow = {}, itemOverrides = {} } = ctx || {};
  const byCategory = {};
  for (const [cat, allow] of Object.entries(categoryAllow)) byCategory[cat] = asArray(allow).slice();
  const byItem = {};
  for (const item of items) {
    const ov = itemOverrides[item.key];
    if (!ov) continue;
    const add = asArray(ov.add);
    if (add.length) byItem[item.key] = add.slice();
  }
  return { byCategory, byItem };
}

module.exports = { resolveExposure, deriveLegacyMaps, ALL };
