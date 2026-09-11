'use strict';
// READ-ONLY post-seed / post-publish PRODUCTION verification. Reads the real Firestore catalog back and
// compares counts/keys/prices to menu-pricing.js — prints a diff, exits NON-ZERO on any mismatch. The
// emulator proves the CODE; only this proves the PRODUCTION store landed.
// Run (owner, post-seed OR post publish-version, PRE rules-deploy): node tools/verify-catalog.js
// After a MERCHANT EDIT (portal 2b-1), ask the post-edit question instead: node tools/verify-catalog.js --vs-active
// This script only READS. It never writes to Firestore.
//
// 1c-b2: getRestaurantDocs is now POINTER-FIRST — it resolves restaurants/{rid}/meta/active_version and
// reads the pointed IMMUTABLE version (with completeness verification), falling back to the flat layout
// only when the pointer is cleanly absent. So this verifier reads via the pointer automatically once the
// catalog is migrated, and prints which versionId served (null = still on the flat layout).
try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { getRestaurantDocs } = require('../catalog/catalog-firestore');
const { readSource, sourceToBuildInputs } = require('../catalog/source-store');   // portal 2a
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { assertStoreCodeParity, assertStoreMatchesActive } = require('../catalog/publish-parity');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');
const { previewVersion } = require('../catalog/catalog-publish');                 // portal 2b-1
const { getActiveVersionId, readVersionDocs } = require('../catalog/catalog-firestore');

// Portal 2b-1 — WHICH QUESTION THIS TOOL ASKS.
//
//   default        store == CODE. The 2a cutover question. Right up to the first intended edit, and
//                  right again after a rollback-to-code.
//   --vs-active    store == the ACTIVE PUBLISHED VERSION. The post-2b question. Once a merchant edits
//                  their menu, divergence from code is the POINT, so the default mode fails by design —
//                  and a verifier that always fails is one people stop running.
//
// The modes are EXCLUSIVE, not additive. Running the code comparison in --vs-active mode would fail on
// every intended edit, which is the exact uselessness this mode exists to remove.
const VS_ACTIVE = process.argv.includes('--vs-active');

// THE PROJECT GUARD, before anything resolves a credential or constructs a client: a refusal
// here cannot have read or written a byte. See tools/require-project.js.
const PROJECT_ID = requireProject();
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
const db = admin.firestore();

// The active published version, built the same way the store is, so the two are comparable.
async function activeBuiltOf(rid) {
  const versionId = await getActiveVersionId(db, rid);
  if (versionId == null) throw new Error(`no_active_version: ${rid} — nothing published to compare against`);
  const [preview, docs] = await Promise.all([previewVersion(db, rid, versionId), readVersionDocs(db, rid, versionId)]);
  const { extras } = buildTablesFromDocs(docs.itemDocs, docs.extraDocs);
  return { built: { items: preview.items, structure: preview.structure, extras }, versionId };
}

(async () => {
  let bad = 0;
  for (const rid of (VS_ACTIVE ? [] : ['x_pizza', 'la_musa'])) {
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
    try { ({ source } = await readSource(db, rid)); } catch (e) {
      if (/source_missing/.test(String(e && e.message))) { console.log(`${rid}: no source store yet (pre-2a) — skipping store parity`); continue; }
      throw e;
    }
    const inputs = sourceToBuildInputs(source);
    const storeBuilt = { ...buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable }), extras: inputs.extras };
    if (VS_ACTIVE) {
      try {
        const { built, versionId } = await activeBuiltOf(rid);
        assertStoreMatchesActive(rid, storeBuilt, built);
        console.log(`${rid}: source store == active version ${versionId} ✓`);
      } catch (e) { bad++; console.error(String(e && e.message)); }
    } else {
      const codeBuilt = { ...buildCatalogV2(rid), extras: EXTRAS_BY_RESTAURANT[rid] || {} };
      try { assertStoreCodeParity(rid, storeBuilt, codeBuilt); console.log(`${rid}: source store == code (build-parity ✓)`); }
      catch (e) { bad++; console.error(String(e && e.message)); }
    }
  }
  if (bad) { console.error(`verify-catalog FAILED: ${bad} mismatch(es)${VS_ACTIVE ? '' : ' — do NOT proceed to the rules deploy'}`); process.exit(1); }
  console.log(VS_ACTIVE ? 'verify-catalog: the source store matches the active published version ✓' : 'verify-catalog: production catalog == code tables ✓');
  process.exit(0);
})().catch((e) => { console.error('verify-catalog error:', e && e.message); process.exit(1); });
