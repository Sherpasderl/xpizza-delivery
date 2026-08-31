'use strict';
// CLI wrapper — seeds the LIVE catalog from the menu-pricing tables. ADDITIVE (nothing reads it yet).
// Run (controlled, owner/advisor post-gate): node tools/seed-catalog.js
// Then ALWAYS run the required verification: node tools/verify-catalog.js
try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; the seed needs only ADC */ }
const crypto = require('crypto');
const { execSync } = require('child_process');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const { buildCatalogV2 } = require('../catalog/form-menu-source');   // 1c-a: schema-v2 bootstrap (display from the forms, price from menu-pricing)

// 1c-a: each restaurant now seeds schema-v2 — {key, price} exactly as before, PLUS the verbatim form
// display record per item and a menu_structure doc. Prices still come from menu-pricing (the
// authority); only the DISPLAY half is sourced from the forms.
const V2 = { x_pizza: buildCatalogV2('x_pizza'), la_musa: buildCatalogV2('la_musa') };
const RESTAURANTS = {
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship', pricing_key_mode: 'name', active: true, schema_version: 2 }, menu: MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza, v2Items: V2.x_pizza.items, structure: V2.x_pizza.structure },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship', pricing_key_mode: 'id',   active: true, schema_version: 2 }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa, v2Items: V2.la_musa.items, structure: V2.la_musa.structure },
};

// Codex: a money-adjacent controlled op must be auditable — record WHAT was written and from WHICH source.
// The table hash is order-independent (sorted) so the same tables always hash the same.
const tableHash = (t) => crypto.createHash('sha256').update(JSON.stringify(Object.entries(t || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)))).digest('hex').slice(0, 12);
const gitSha = () => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return 'unknown'; } };

admin.initializeApp({ credential: admin.credential.applicationDefault() });
seedCatalog(admin.firestore(), RESTAURANTS)
  .then((report) => {
    console.log(`catalog seed complete (additive) — source ${gitSha()} @ ${new Date().toISOString()}`);
    for (const [rid, r] of Object.entries(report)) {
      console.log(`  ${rid}: ${r.items} items (schema-v2) + ${r.extras} extras written, ${r.reconciled} stale doc(s) deleted` +
        `  [menu ${tableHash(MENU_BY_RESTAURANT[rid])} / extras ${tableHash(EXTRAS_BY_RESTAURANT[rid])}]`);
    }
    console.log('NEXT (required): node tools/verify-catalog.js — proves the production seed landed byte-identical');
    process.exit(0);
  })
  .catch((e) => { console.error('seed failed:', e && e.message); process.exit(1); });
