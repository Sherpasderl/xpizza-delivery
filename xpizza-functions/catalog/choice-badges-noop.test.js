'use strict';
// 1D add-product B (rev 6) PB-2 step 2.7 — BYTE-IDENTITY of the catalog outputs across the contract change (choiceBadges,
// render ON, compat 2): for today's data (no groups on x_pizza, la_musa's Pad Thai, no structure.badges — unused badges
// stay ABSENT, §0b.6) the validated source, the built catalog, the form bundle, the public body and the KDS manifest are
// byte-identical to the pre-2.7 tree. Hashes are captured on that tree:
//   CB_GOLDEN_CAPTURE=1 node catalog/choice-badges-noop.test.js   (ONLY on the pre-2.7 tree)
// Run: node catalog/choice-badges-noop.test.js
const assert = require('assert');
const crypto = require('crypto');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { canonicalize, validateSource, sourceToBuildInputs } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2, rebuildFormMenu } = require('./form-menu-source');
const { generateFormBundle, generateKdsManifest } = require('./generate-form-bundle');
const { canonicalJson } = require('./canonical-json');

const GOLDEN = join(__dirname, 'choice-badges-noop.golden.json');
const h = (v) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');

const out = {};
for (const rid of ['x_pizza', 'la_musa']) {
  const src = canonicalize(buildSourceFromCode(rid));
  assert.doesNotThrow(() => validateSource(src, rid), `${rid}: today's source validates under the current contract`);
  const i = sourceToBuildInputs(src);
  const built = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras });
  const menu = { items: built.items, structure: built.structure, extras: built.extras };
  const body = generateFormBundle(rid, menu);
  for (const f of ['extras_by_category', 'extras_by_item', 'badges']) if (menu.structure[f] !== undefined) body[f] = menu.structure[f];   // public-menu.js CARRIED_FROM_STRUCTURE
  assert.strictEqual(menu.structure.badges, rid === 'x_pizza' ? undefined : menu.structure.badges, 'x_pizza: structure.badges stays ABSENT (no item uses a badge)');
  out[rid] = {
    source: h(src),
    built: h(built),
    bundle: h(rebuildFormMenu(rid, built.items, built.structure, built.extras)),
    publicBody: h(body),
    kds: h(generateKdsManifest(rid, menu)),
  };
}

if (process.env.CB_GOLDEN_CAPTURE === '1') {
  writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
  console.log('captured → choice-badges-noop.golden.json');
} else {
  assert.ok(existsSync(GOLDEN), 'the golden exists (captured on the pre-2.7 tree)');
  assert.deepStrictEqual(out, JSON.parse(readFileSync(GOLDEN, 'utf8')), '🔴 a catalog output moved across the 2.7 contract change');
  console.log(`  ✓ 1 today's data on both brands: source, built catalog, form bundle, public body and KDS manifest are byte-identical to the pre-2.7 tree (${Object.keys(out.x_pizza).length} artifacts × 2)`);
  console.log('\nchoice-badges-noop: OK (1)');
}
