'use strict';
// ---------------------------------------------------------------------------
// Phase 1c-b1 — GENERATE the consumer artifacts FROM the schema-v2 catalog.
//
// 1c-a proved the round-trip is lossless (buildCatalogV2 ⇄ rebuildFormMenu). 1c-b1 turns that proof
// into a real GENERATION step: read a catalog snapshot ({ items, structure } — the getRestaurantMenu
// shape) and emit (1) the form served-menu BUNDLE the form will render and (2) the KDS MANIFEST
// (menus/{rid}.json). Both are committed static artifacts, parity-proven equal to today's hand-kept
// sources. NOTHING serves them yet — 1c-b3 flips the forms to read the bundle.
//
// SOURCE-AGNOSTIC BY DESIGN (executor call, flagged for the gate):
//   generate*(rid, catalog) consume a catalog snapshot in getRestaurantMenu's { items, structure }
//   shape — NOT the form. The snapshot can come from two places that carry the SAME records:
//     • getRestaurantMenu(db, rid)  → a REAL Firestore read (the emulator parity test uses this; the
//       sentinel there proves a catalog-only field flows into the artifact — generation reads the
//       catalog, not the form).
//     • catalogSnapshot(rid)        → the in-memory bootstrap (buildCatalogV2) — the deterministic
//       embodiment of the SAME catalog content (1c-a proved buildCatalogV2 == what the seed writes to
//       Firestore, mutation-proven). The COMMITTED build uses this so the artifacts regenerate in
//       plain node/CI with NO live Firestore, exactly as menus.test.mjs already runs form-free of an
//       emulator. The emulator test proves the two snapshots yield byte-identical artifacts.
//   The generator itself NEVER re-slices the form — the whole point of 1c is that the artifact is a
//   pure function of the catalog records. rebuildFormMenu is the one, tested inverse — reused here, no
//   second inverse (PIN).
// ---------------------------------------------------------------------------
const { buildCatalogV2, rebuildFormMenu } = require('./form-menu-source');

// A catalog snapshot in getRestaurantMenu's output shape, built in-memory from the 1c-a bootstrap
// source. Same { items, structure } the Firestore display reader returns — items ordered by
// structure.item_order (sorted EXPLICITLY here so the in-memory and Firestore snapshots are
// order-identical by contract, not by the accident that buildCatalogV2 already emits item_order order).
function catalogSnapshot(restaurantId, opts) {
  const { items, structure } = buildCatalogV2(restaurantId, opts || {});
  const byKey = new Map(items.map((i) => [i.key, i]));
  return { items: structure.item_order.map((k) => byKey.get(k)), structure };
}

// The form served-menu BUNDLE: exactly rebuildFormMenu's output (the dish array in item_order + the aux
// structures — categories/subcats, VARIANT_ITEMS, HAS_PHOTO, PICKUP_ONLY/WEEKEND_ONLY cats). One
// inverse, reused — no second implementation to drift from.
function generateFormBundle(restaurantId, catalog) {
  return rebuildFormMenu(restaurantId, catalog.items, catalog.structure);
}

// The KDS MANIFEST [{ key, label, category }] derived from the SAME catalog records the bundle uses, so
// the served menu and the kitchen manifest can never drift. The mapping is IDENTICAL to what
// menu-extract.mjs applied to the form, now sourced from the catalog:
//   key      = the pricing key (catalog item.key: x_pizza NAME / la_musa id slug)
//   label    = display.name
//   category = display.cat
// Same fail-loud validation as menu-extract (a blank key/name/category throws, never ships a hole).
function generateKdsManifest(restaurantId, catalog) {
  return catalog.items.map(({ key, display }) => {
    if (key == null || String(key) === '') throw new Error(`${restaurantId}: item missing key`);
    if (!display || display.name == null || String(display.name) === '') {
      throw new Error(`${restaurantId}: item '${key}' missing name/label`);
    }
    if (display.cat == null || String(display.cat) === '') {
      throw new Error(`${restaurantId}: item '${key}' missing category (cat)`);
    }
    return { key: String(key), label: String(display.name), category: String(display.cat) };
  });
}

// Byte-stable serialization (2-space indent + a single trailing newline) — matches menu-extract's
// serializeManifest so the committed artifacts are diff-stable and deterministic across runs.
const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

module.exports = { catalogSnapshot, generateFormBundle, generateKdsManifest, serialize };
