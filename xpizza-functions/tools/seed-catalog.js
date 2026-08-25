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

const RESTAURANTS = {
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship', pricing_key_mode: 'name', active: true }, menu: MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship', pricing_key_mode: 'id',   active: true }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa },
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
      console.log(`  ${rid}: ${r.items} items + ${r.extras} extras written, ${r.reconciled} stale doc(s) deleted` +
        `  [menu ${tableHash(MENU_BY_RESTAURANT[rid])} / extras ${tableHash(EXTRAS_BY_RESTAURANT[rid])}]`);
    }
    console.log('NEXT (required): node tools/verify-catalog.js — proves the production seed landed byte-identical');
    process.exit(0);
  })
  .catch((e) => { console.error('seed failed:', e && e.message); process.exit(1); });
