'use strict';
// ── menu-extract — derive the per-restaurant menu manifest from the ORDER FORMS ──────────────────
// (KDS Phase 2b · Slice 2 · KDS_2B_PLAN.md §3 "Menu manifest")
//
// The canonical manifest published to Firebase /menus/{rid} is `[{ key, label, category }]`, derived
// from the `const MENU = [ … ]` array embedded in each order form — the SAME source of truth the
// server pricing (menu-pricing.js MENU_BY_RESTAURANT) is kept in sync with. This module is the single
// extractor shared by build-menus.mjs (writes menus/*.json), publish-menus.mjs (owner publish), and
// menus.test.mjs (keys-golden). NEW FILE — it only READS the forms, never writes them.
//
// Key mapping mirrors the pricing key (menu-pricing.js contract, unchanged):
//   x_pizza → key = item.name   (the pricing table is name-keyed; label is the same name)
//   la_musa → key = item.id     (the pricing table is id/slug-keyed; label is item.name)
// `key` is the RAW pricing key — NOT availKey()-encoded. Surfaces apply availKey() themselves to build
// the RTDB path; the manifest stores exactly the MENU_BY_RESTAURANT[rid] keys.
//
// Parse approach: reuse menu-parity.test.js's "slice the top-level `const MENU = [ … ];` literal" idea,
// but EVAL the sliced array literal (object literals only, no external refs / calls) instead of a
// regex — robust to names with spaces, accents, `&`, apostrophes. The `];` that closes the array is
// unique (entries close with `},`; inline `tags:[]` / `tags:[ … ]` close with `]` + `,`, never `];`).
// Deterministic: form order is preserved as-is (no re-sorting).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// rid → { form: path to the order form, keyField: which item field is the pricing key }
const SOURCES = {
  x_pizza: { form: join(REPO_ROOT, 'xpizza-orders', 'index.html'), keyField: 'name' },
  la_musa: { form: join(REPO_ROOT, 'la-musa-orders', 'index.html'), keyField: 'id' },
};

export const RESTAURANT_IDS = Object.keys(SOURCES);

// Slice the `const MENU = [ … ]` array literal out of a form's source and eval it to the item array.
function extractMenuArray(formSrc) {
  const marker = 'const MENU = [';
  const declStart = formSrc.indexOf(marker);
  if (declStart === -1) throw new Error('MENU array not found in form');
  const bracketStart = declStart + marker.length - 1; // index of the opening `[`
  const end = formSrc.indexOf('];', bracketStart);    // unique array close
  if (end === -1) throw new Error('MENU array close (];) not found in form');
  const literal = formSrc.slice(bracketStart, end + 1); // `[ … ]` inclusive
  // Object-literals only, no identifiers/calls — eval via Function to a real array.
  // eslint-disable-next-line no-new-func
  const arr = Function(`"use strict"; return (${literal});`)();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('MENU array parsed empty');
  return arr;
}

// Build the manifest for one restaurant: [{ key, label, category }] in form order.
export function extractManifest(rid) {
  const src = SOURCES[rid];
  if (!src) throw new Error(`unknown restaurant: ${rid}`);
  const items = extractMenuArray(readFileSync(src.form, 'utf8'));
  return items.map((it) => {
    const key = it[src.keyField];
    if (key == null || String(key) === '') throw new Error(`${rid}: item missing '${src.keyField}' key`);
    if (it.name == null || String(it.name) === '') throw new Error(`${rid}: item '${key}' missing name/label`);
    if (it.cat == null || String(it.cat) === '') throw new Error(`${rid}: item '${key}' missing category (cat)`);
    return { key: String(key), label: String(it.name), category: String(it.cat) };
  });
}

// All manifests keyed by rid — the shape written to menus/{rid}.json and Firebase /menus/{rid}.
export function extractAllManifests() {
  const out = {};
  for (const rid of RESTAURANT_IDS) out[rid] = extractManifest(rid);
  return out;
}

// Stable, byte-identical serialization: 2-space indent + a single trailing newline.
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
