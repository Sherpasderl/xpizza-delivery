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
const { spliceFormFile } = require('./catalog/splice-form-bundle');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT = {
  x_pizza: join(REPO_ROOT, 'xpizza-orders', 'menu-bundle.generated.json'),
  la_musa: join(REPO_ROOT, 'la-musa-orders', 'menu-bundle.generated.json'),
};
// The SPLICED forms are the second committed artifact of this same bundle, and
// form-bundle-splice.test.js pins the block inside each form to what this generator produces. Until
// 1A that splice had no runner — the block was placed once by hand — so the first shape change to
// the bundle broke a gate with no scripted way to satisfy it. Regeneration is one command now, which
// is the only version of "regenerate the artifacts" that can be followed twice and give the same
// answer. spliceFormFile is itself fail-closed: it re-extracts and round-trips before it writes.
const FORM = {
  x_pizza: join(REPO_ROOT, 'xpizza-orders', 'index.html'),
  la_musa: join(REPO_ROOT, 'la-musa-orders', 'index.html'),
};

for (const rid of ['x_pizza', 'la_musa']) {
  const bundle = generateFormBundle(rid, catalogSnapshot(rid));
  writeFileSync(OUT[rid], serialize(bundle));
  console.log(`  wrote ${OUT[rid]} (${bundle.dishes.length} dishes, ${bundle.extras.length} extras)`);
  const { changed } = spliceFormFile(FORM[rid], bundle, rid);
  console.log(`  ${changed ? 'spliced' : 'unchanged'} ${FORM[rid]}`);
}
console.log('generate-form-bundle: OK');
