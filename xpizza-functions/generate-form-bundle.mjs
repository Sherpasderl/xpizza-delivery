'use strict';
// ── generate-form-bundle — regenerate the committed form served-menu BUNDLE from the catalog ──────
// (Phase 1c-b1 — spec §Generation)
//
// Emits {brand-form}/menu-bundle.generated.json for both brands from the schema-v2 catalog snapshot
// (the SAME records the KDS manifest is built from), byte-identical to today's hard-coded form MENU
// (parity-gated in catalog-form-bundle.test.js). NOTHING reads the bundle yet — 1c-b3 flips the forms.
// Deterministic: re-running produces BYTE-IDENTICAL files. Never hand-edit — re-run this to refresh.
// Run: node generate-form-bundle.mjs   (from xpizza-functions/)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { catalogSnapshot, generateFormBundle, serialize } = require('./catalog/generate-form-bundle');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT = {
  x_pizza: join(REPO_ROOT, 'xpizza-orders', 'menu-bundle.generated.json'),
  la_musa: join(REPO_ROOT, 'la-musa-orders', 'menu-bundle.generated.json'),
};

for (const rid of ['x_pizza', 'la_musa']) {
  const bundle = generateFormBundle(rid, catalogSnapshot(rid));
  writeFileSync(OUT[rid], serialize(bundle));
  console.log(`  wrote ${OUT[rid]} (${bundle.dishes.length} dishes)`);
}
console.log('generate-form-bundle: OK');
