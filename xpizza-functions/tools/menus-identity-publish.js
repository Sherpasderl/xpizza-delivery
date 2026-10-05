#!/usr/bin/env node
'use strict';
// Portal 1D · D4-b §E.3 — publish menus_identity/{rid} for EVERY restaurant (validate all → conditional write → read-back).
// 🔴 EMULATOR-ONLY IN D4-b. The first production publication belongs to the D4-c activation (PLAN-D4b §E, D4-c barrier),
// so this refuses to run unless BOTH emulator host variables are set. Nothing here touches /menus/{rid}.
//   node tools/emulator-run.js --only firestore,database --project xpizza-delivery "node tools/menus-identity-publish.js --project xpizza-delivery"
const admin = require('firebase-admin');
const { publishIdentityManifests } = require('../catalog/identity-manifest');
const { createCatalogVerifier } = require('../catalog/catalog-verifier');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');

const { requireProject } = require('./require-project');
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const PROJECT_ID = requireProject();      // FIRST: states the project (the repo's own), as every connecting tool must

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('menus-identity-publish: REFUSING — D4-b publishes menus_identity on the EMULATORS only (production publication is D4-c).');
  process.exit(2);
}
// The emulator host variables (required above) route BOTH clients to the emulators; RTDB_URL only names the namespace.
admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const db = admin.firestore();
publishIdentityManifests({ db, rtdb: admin.database(), listIds: makeFirestoreRegistryReader(db), verifier: createCatalogVerifier({ db }) })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error('menus-identity-publish FAILED:', e && e.message); process.exit(1); });
