'use strict';
// Phase 1c-b3 — write the catalog-generated menu bundle into each order form's HTML.
// Run: node tools/splice-form-bundle.js        (idempotent; re-running yields byte-identical HTML)
//
// Fail-closed: any marker-count, serialization or post-splice round-trip failure throws and NOTHING is
// written. The committed form HTML is what Netlify serves, so a bad splice would BE production.
const { readFileSync } = require('fs');
const { join } = require('path');
const { catalogSnapshot, generateFormBundle } = require('../catalog/generate-form-bundle');
const { spliceFormFile } = require('../catalog/splice-form-bundle');

const FORMS = {
  x_pizza: join(__dirname, '..', '..', 'xpizza-orders', 'index.html'),
  la_musa: join(__dirname, '..', '..', 'la-musa-orders', 'index.html'),
};
const BUNDLES = {
  x_pizza: join(__dirname, '..', '..', 'xpizza-orders', 'menu-bundle.generated.json'),
  la_musa: join(__dirname, '..', '..', 'la-musa-orders', 'menu-bundle.generated.json'),
};

function main() {
  for (const rid of Object.keys(FORMS)) {
    // The bundle is regenerated from the catalog here rather than trusted from disk, and cross-checked
    // against the committed artifact — so the form can never be spliced with a stale bundle.
    const fresh = generateFormBundle(rid, catalogSnapshot(rid));
    const committed = JSON.parse(readFileSync(BUNDLES[rid], 'utf8'));
    if (JSON.stringify(fresh) !== JSON.stringify(committed)) {
      throw new Error(`bundle_drift: ${rid} — the committed menu-bundle.generated.json differs from the catalog-generated bundle; re-run the 1c-b1 generation first`);
    }
    const { changed } = spliceFormFile(FORMS[rid], fresh, rid);
    console.log(`${rid}: ${changed ? 'spliced' : 'already up to date'} — ${fresh.dishes.length} dishes`);
  }
  console.log('form bundles spliced (idempotent, fail-closed)');
}
if (require.main === module) { try { main(); } catch (e) { console.error('splice failed:', e && e.message); process.exit(1); } }
module.exports = { FORMS, BUNDLES, main };
