'use strict';
// Phase 1c-b1 — PARITY GATE B: the CATALOG-generated KDS manifest == the FORM-generated one ────────
// Run: node --test catalog-kds-parity.test.mjs   (from xpizza-functions/)
//
// build-menus.mjs was re-pointed FORM→CATALOG in 1c-b1. This proves the move is a no-op on the bytes:
// the manifest generated from the catalog (catalogSnapshot → generateKdsManifest) equals the manifest
// the form extractor produces (menu-extract.extractManifest) AND the committed menus/{rid}.json, both
// brands. Non-vacuous: a catalog-only label change flows into the catalog manifest and diverges from
// the form — proving the generator reads the catalog records, not the form.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RESTAURANT_IDS, extractManifest, serializeManifest } from './menu-extract.mjs';

const require = createRequire(import.meta.url);
const { catalogSnapshot, generateKdsManifest } = require('./catalog/generate-form-bundle');

const __dirname = dirname(fileURLToPath(import.meta.url));
const MENUS_DIR = join(__dirname, '..', 'menus');

for (const rid of RESTAURANT_IDS) {
  test(`${rid}: catalog-generated KDS manifest == form-generated == committed`, () => {
    const fromCatalog = generateKdsManifest(rid, catalogSnapshot(rid));
    const fromForm = extractManifest(rid);
    assert.deepStrictEqual(fromCatalog, fromForm,
      `${rid}: the catalog-sourced manifest must equal the form-sourced manifest, field-for-field and in order`);
    const committed = readFileSync(join(MENUS_DIR, `${rid}.json`), 'utf8');
    assert.strictEqual(serializeManifest(fromCatalog), committed,
      `${rid}: committed menus/${rid}.json is stale vs the catalog source — re-run \`node build-menus.mjs\``);
  });
}

test('non-vacuity: a catalog-only label change flows into the catalog manifest, diverging from the form', () => {
  const snap = catalogSnapshot('la_musa');
  const mutated = {
    ...snap,
    items: snap.items.map((it, idx) => (idx === 0
      ? { ...it, display: { ...it.display, name: 'SENTINEL LABEL' } } : it)),
  };
  const fromCatalog = generateKdsManifest('la_musa', mutated);
  assert.strictEqual(fromCatalog[0].label, 'SENTINEL LABEL', 'the catalog label must drive the manifest');
  assert.notStrictEqual(extractManifest('la_musa')[0].label, 'SENTINEL LABEL', 'the form does NOT carry the sentinel');
});
