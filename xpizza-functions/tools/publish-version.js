'use strict';
// CLI — MIGRATE the live catalog to versioned-publish: publishVersion v1 for both brands from the
// current menu-pricing tables (+ the schema-v2 display records / structure), then FLIP the
// active_version pointer. ADDITIVE + atomic (the flip is the only cutover; the flat layout stays until
// contracted). This writes a NEW version and moves the pointer — run it CONTROLLED (owner, post-gate).
//
// Run (owner, post functions-deploy):  node tools/publish-version.js
// Then ALWAYS verify via the pointer:  node tools/verify-catalog.js
//
// 🔒 Value-identity: version 1 == the flat catalog == code (the emulator money-proof gates this). The
// reader serves version 1 via the pointer; the 1b guard still serves CODE + alarms on any divergence.
try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; publish needs only ADC */ }
const { execSync } = require('child_process');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { publishVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror, RTDB_URL } = require('../catalog/mirror-rtdb');   // 1b: the RTDB disaster-fallback writer

const gitSha = () => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return 'unknown'; } };

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: RTDB_URL,   // 1b REVISE: ADC + GOOGLE_CLOUD_PROJECT alone do NOT resolve RTDB — without
                           // this, admin.database() throws and the tool dies before writing anything.
});
const db = admin.firestore();
const mirror = makeRtdbMirror(admin.database());   // 1b: injected so the publish acks the mirror under its lease

(async () => {
  const source_sha = gitSha();
  for (const rid of ['x_pizza', 'la_musa']) {
    const { items, structure } = buildCatalogV2(rid);   // schema-v2 items (price from menu-pricing) + structure
    const res = await publishVersion(db, rid, { items, structure, extras: EXTRAS_BY_RESTAURANT[rid] || {}, source_sha }, { mirror });
    const codeItems = Object.keys(MENU_BY_RESTAURANT[rid]).length;
    const codeExtras = Object.keys(EXTRAS_BY_RESTAURANT[rid] || {}).length;
    if (res.item_count !== codeItems || res.extra_count !== codeExtras) {
      throw new Error(`publish count drift ${rid}: version=${res.item_count}/${res.extra_count} code=${codeItems}/${codeExtras}`);
    }
    console.log(`  ${rid}: published ${res.versionId} — ${res.item_count} items + ${res.extra_count} extras` +
      `  [menu ${res.menu_hash.slice(0, 12)} / extras ${res.extras_hash.slice(0, 12)}] → active_version flipped`);
  }
  console.log(`catalog versioned-publish complete — source ${source_sha} @ ${new Date().toISOString()}`);
  console.log('NEXT (required): node tools/verify-catalog.js — proves the pointer serves version 1 byte-identical to code');
  process.exit(0);
})().catch((e) => { console.error('publish-version failed:', e && e.stack || e); process.exit(1); });
