'use strict';
// READ-ONLY post-seed / post-publish PRODUCTION verification. Reads the real Firestore catalog back and
// compares counts/keys/prices to menu-pricing.js — prints a diff, exits NON-ZERO on any mismatch. The
// emulator proves the CODE; only this proves the PRODUCTION store landed.
// Run (owner, post-seed OR post publish-version, PRE rules-deploy): node tools/verify-catalog.js
// This script only READS. It never writes to Firestore.
//
// 1c-b2: getRestaurantDocs is now POINTER-FIRST — it resolves restaurants/{rid}/meta/active_version and
// reads the pointed IMMUTABLE version (with completeness verification), falling back to the flat layout
// only when the pointer is cleanly absent. So this verifier reads via the pointer automatically once the
// catalog is migrated, and prints which versionId served (null = still on the flat layout).
try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { getRestaurantDocs } = require('../catalog/catalog-firestore');
const { readSource, sourceToBuildInputs } = require('../catalog/source-store');   // portal 2a
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { assertStoreCodeParity } = require('../catalog/publish-parity');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  let bad = 0;
  for (const rid of ['x_pizza', 'la_musa']) {
    const d = await getRestaurantDocs(db, rid);                 // pointer-first; throws on not-found/empty/malformed/completeness
    const back = buildTablesFromDocs(d.itemDocs, d.extraDocs);
    console.log(`${rid}: serving via ${d.versionId ? `active_version ${d.versionId}` : 'the FLAT layout (not yet migrated)'}`);
    for (const [label, got, want] of [['menu', back.menu, MENU_BY_RESTAURANT[rid]], ['extras', back.extras, EXTRAS_BY_RESTAURANT[rid] || {}]]) {
      for (const k of new Set([...Object.keys(got), ...Object.keys(want)])) {
        if (got[k] !== want[k]) {
          bad++;
          const inCatalog = Object.prototype.hasOwnProperty.call(got, k);
          const inCode = Object.prototype.hasOwnProperty.call(want, k);
          const why = !inCatalog ? 'MISSING from catalog' : !inCode ? 'EXTRA in catalog (stale doc — re-run the seed to reconcile)' : 'PRICE differs';
          console.error(`MISMATCH ${rid}.${label}[${JSON.stringify(k)}]: catalog=${got[k]} code=${want[k]} — ${why}`);
        }
      }
      const gotN = Object.keys(got).length, wantN = Object.keys(want).length;
      if (gotN !== wantN) { bad++; console.error(`COUNT ${rid}.${label}: catalog=${gotN} code=${wantN}`); }
    }
    console.log(`${rid}: ${Object.keys(back.menu).length} items + ${Object.keys(back.extras).length} extras checked`);
  }
  // Portal 2a: when a source store exists, ALSO prove store-built == code-built. The loop above
  // verifies the SERVED catalog against the code tables; this verifies the SOURCE the next publish
  // would use — so a drifted store is caught here rather than at the next cutover.
  for (const rid of ['x_pizza', 'la_musa']) {
    let source = null;
    try { source = await readSource(db, rid); } catch (e) {
      if (/source_missing/.test(String(e && e.message))) { console.log(`${rid}: no source store yet (pre-2a) — skipping store parity`); continue; }
      throw e;
    }
    const inputs = sourceToBuildInputs(source);
    const storeBuilt = { ...buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable }), extras: inputs.extras };
    const codeBuilt = { ...buildCatalogV2(rid), extras: EXTRAS_BY_RESTAURANT[rid] || {} };
    try { assertStoreCodeParity(rid, storeBuilt, codeBuilt); console.log(`${rid}: source store == code (build-parity ✓)`); }
    catch (e) { bad++; console.error(String(e && e.message)); }
  }
  if (bad) { console.error(`verify-catalog FAILED: ${bad} mismatch(es) — do NOT proceed to the rules deploy`); process.exit(1); }
  console.log('verify-catalog: production catalog == code tables ✓');
  process.exit(0);
})().catch((e) => { console.error('verify-catalog error:', e && e.message); process.exit(1); });
