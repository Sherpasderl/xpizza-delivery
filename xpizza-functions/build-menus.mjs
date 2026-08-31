'use strict';
// ── build-menus — regenerate the committed menu manifests from the CATALOG ────────────────────────
// (KDS Phase 2b · Slice 2 · KDS_2B_PLAN.md §3 · re-pointed FORM→CATALOG in Phase 1c-b1)
//
// Emits `[{ key, label, category }]` per restaurant and writes menus/{rid}.json at repo root.
// SOURCE (1c-b1): the schema-v2 CATALOG (catalogSnapshot → generateKdsManifest), NOT the form —
// label/category/key now flow from the catalog display records (display.name / display.cat / key), so
// the kitchen manifest and the served menu share one source. The OUTPUT SHAPE is unchanged, and it is
// byte-identical to the old form-derived manifest (parity-gated in catalog-kds-parity.test.mjs +
// menus.test.mjs). Deterministic: re-running produces BYTE-IDENTICAL files (item_order preserved,
// serializeManifest = 2-space + trailing \n). menus/*.json are GENERATED — never hand-edit; re-run
// `node build-menus.mjs` to refresh. Run from xpizza-functions/.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { RESTAURANT_IDS, serializeManifest } from './menu-extract.mjs';

const require = createRequire(import.meta.url);
const { catalogSnapshot, generateKdsManifest } = require('./catalog/generate-form-bundle');

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'menus');

mkdirSync(OUT_DIR, { recursive: true });
for (const rid of RESTAURANT_IDS) {
  const manifest = generateKdsManifest(rid, catalogSnapshot(rid));   // SOURCE: the catalog (was the form)
  const outPath = join(OUT_DIR, `${rid}.json`);
  writeFileSync(outPath, serializeManifest(manifest));
  console.log(`  wrote ${outPath} (${manifest.length} items)`);
}
console.log('build-menus: OK');
