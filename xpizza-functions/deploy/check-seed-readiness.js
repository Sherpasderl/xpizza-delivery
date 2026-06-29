'use strict';

/**
 * (S) Pre-reader deploy gate. A function-service-account read of /restaurants/{rid}/identity that
 * asserts it passes the EXACT hot-path routing contract (isRoutingValid, imported — NOT re-implemented)
 * AND active === true, BEFORE the config-reading functions are deployed — so the live reader never
 * meets a missing/invalid/inactive config (no cold-cache 503 window, no inactive rejection).
 *
 * Admin SDK (bypasses rules). Exits non-zero on any failure. Run AFTER seeding, BEFORE deploy.
 * Env: FB_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS (or SERVICE_ACCOUNT_JSON), [READINESS_RID].
 */
const admin = require('firebase-admin');
const { isRoutingValid } = require('../restaurant-config');

const RID = process.env.READINESS_RID || 'x_pizza';

(async () => {
  // Emulator dry-run (FIREBASE_DATABASE_EMULATOR_HOST set) needs no real creds; prod uses the SA.
  const EMU = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  admin.initializeApp(
    EMU
      ? { projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza' }
      : { credential: admin.credential.applicationDefault(), databaseURL: process.env.FB_DATABASE_URL }
  );
  const id = (await admin.database().ref(`restaurants/${RID}/identity`).once('value')).val();

  if (!id) throw new Error(`/restaurants/${RID}/identity is MISSING — seed before deploying the reader`);
  if (!isRoutingValid(id)) throw new Error(`${RID} identity fails isRoutingValid (the hot-path contract): ${JSON.stringify(id)}`);
  if (id.active !== true) throw new Error(`${RID} identity.active !== true (is ${id.active}) — the reader would reject/fail-closed`);

  console.log(`readiness: OK — ${RID} identity valid + active (hub ${id.hub_lat},${id.hub_lng}, radius ${id.delivery_radius_km}km, v${id.version})`);
  process.exit(0);
})().catch((e) => { console.error('readiness: FAIL —', e.message); process.exit(1); });
