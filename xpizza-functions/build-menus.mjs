'use strict';
// ── build-menus — regenerate the committed menu manifests from the order forms ───────────────────
// (KDS Phase 2b · Slice 2 · KDS_2B_PLAN.md §3)
//
// Reads the `const MENU = [ … ]` array from BOTH order forms (via menu-extract.mjs — READ-ONLY on the
// forms), emits `[{ key, label, category }]` per restaurant, and writes menus/{rid}.json at repo root.
// Deterministic: re-running produces BYTE-IDENTICAL files (form order preserved, 2-space + trailing \n).
// The committed menus/*.json are GENERATED — never hand-edit; re-run `node build-menus.mjs` to refresh.
// Run: node build-menus.mjs   (from xpizza-functions/)
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RESTAURANT_IDS, extractManifest, serializeManifest } from './menu-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'menus');

mkdirSync(OUT_DIR, { recursive: true });
for (const rid of RESTAURANT_IDS) {
  const manifest = extractManifest(rid);
  const outPath = join(OUT_DIR, `${rid}.json`);
  writeFileSync(outPath, serializeManifest(manifest));
  console.log(`  wrote ${outPath} (${manifest.length} items)`);
}
console.log('build-menus: OK');
