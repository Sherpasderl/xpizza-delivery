/**
 * One-shot backfill for Step 2a (native push).
 *
 * Sets /drivers/{uid}/push_reachable from each driver's existing
 * push_subscription, and location_source='pwa' where absent.
 *
 * Run any time relative to deploy: pickEligibleDriver falls back to a real
 * web subscription when push_reachable is absent, so existing PWA drivers stay
 * assignable even before this runs. Run it to set the CANONICAL flag (so the
 * server value is authoritative) and seed location_source='pwa'.
 *
 * Run from xpizza-functions/ with Application Default Credentials:
 *   dry-run:  GOOGLE_APPLICATION_CREDENTIALS=/path/key.json node scripts/backfill-driver-push.js
 *   apply:    GOOGLE_APPLICATION_CREDENTIALS=/path/key.json node scripts/backfill-driver-push.js --apply
 *
 * Idempotent: re-running only rewrites the same computed values. No FCM tokens
 * exist at backfill time, so reachability is computed from web push_subscription
 * only; the registerDriverPushToken callable + the subscription trigger keep
 * push_reachable current afterwards.
 */
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { computePushReachable } = require('../driver-push');

const APPLY = process.argv.includes('--apply');

initializeApp({ databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com' });

(async () => {
  const db = getDatabase();
  const snap = await db.ref('drivers').once('value');
  const drivers = snap.val() || {};

  const updates = {};
  let total = 0, reachableTrue = 0, sourceSet = 0;

  for (const [uid, d] of Object.entries(drivers)) {
    total++;
    const reachable = computePushReachable({ push_subscription: d.push_subscription, fcm_token: null });
    if (reachable) reachableTrue++;
    if (d.push_reachable !== reachable) updates[`drivers/${uid}/push_reachable`] = reachable;
    if (d.location_source === undefined || d.location_source === null) {
      updates[`drivers/${uid}/location_source`] = 'pwa';
      sourceSet++;
    }
  }

  console.log(`drivers=${total}  reachable=true:${reachableTrue}  location_source<-pwa:${sourceSet}  pending writes:${Object.keys(updates).length}`);

  if (!APPLY) {
    console.log('\nDRY-RUN — no writes. Re-run with --apply to commit. Changes:');
    console.log(JSON.stringify(updates, null, 2));
    process.exit(0);
  }

  if (Object.keys(updates).length) await db.ref().update(updates);
  console.log('applied.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
