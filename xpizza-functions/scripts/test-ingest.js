/**
 * Post-deploy validation for ingestDriverLocation (Step 2b curl gate).
 *
 * Sets up a throwaway native shift for a TEST driver uid, mints an ingest token
 * directly (Admin), then POSTs batches to the deployed endpoint and checks the
 * accept/reject behaviour: valid batch, stale/out-of-order drop, future-skew
 * drop, bad token, wrong-shift token, off-shift. Cleans up the token + test
 * fields afterward.
 *
 * Run from xpizza-functions/ with ADC:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/key.json \
 *     node scripts/test-ingest.js <INGEST_URL> <TEST_DRIVER_UID>
 *
 * INGEST_URL is the deployed onRequest URL (from `firebase deploy` output),
 * e.g. https://us-central1-xpizza-delivery.cloudfunctions.net/ingestDriverLocation
 */
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { hashToken } = require('../driver-ingest');

const [, , INGEST_URL, UID] = process.argv;
if (!INGEST_URL || !UID) {
  console.error('usage: node scripts/test-ingest.js <INGEST_URL> <TEST_DRIVER_UID>');
  process.exit(1);
}

initializeApp({ databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com' });
const db = getDatabase();

const HUB = { lat: 15.507489753573818, lng: -88.0398486953722 }; // RESTAURANT_LAT/LNG
const NOW = Date.now();
const SHIFT = `test-shift-${NOW}`;
const RAW = crypto.randomBytes(32).toString('hex');
const HASH = hashToken(RAW);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { console.log(`  ✓ ${name}`); pass++; } else { console.log(`  ✗ ${name}`); fail++; } };

async function post(token, body) {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Driver-Token': token } : {}) },
    body: JSON.stringify(body)
  });
  let json = {};
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

(async () => {
  // --- setup: native shift + token for the test driver ---
  await db.ref(`drivers/${UID}`).update({
    name: db._name || 'TEST driver', active: true, status: 'assigned',
    current_task_id: 'test_task', current_shift_id: SHIFT, location_source: 'native',
    current_hub_lat: null, current_hub_lng: null, current_restaurant_id: null,
    last_location_ts: 0
  });
  await db.ref(`driver_tokens/${HASH}`).set({
    uid: UID, shift_id: SHIFT, device_id: 'test-device',
    issued_at: NOW, expires_at: NOW + 3600000, revoked_at: null
  });

  try {
    // 1. valid batch AT the hub → assigned+task+inGeofence → at_restaurant
    let r = await post(RAW, { locations: [{ ts: NOW - 5000, lat: HUB.lat, lng: HUB.lng, accuracy: 10 }] });
    check('valid batch at hub → 200, accepted 1', r.status === 200 && r.json.accepted === 1);
    check('  geofence: assigned+task at hub → at_restaurant', r.json.status === 'at_restaurant');

    // 2. stale point (older than last_location_ts just set) → dropped
    r = await post(RAW, { locations: [{ ts: NOW - 60000, lat: HUB.lat, lng: HUB.lng }] });
    check('stale point → 200, accepted 0', r.status === 200 && r.json.accepted === 0);

    // 3. future-skew point → dropped
    r = await post(RAW, { locations: [{ ts: NOW + 10 * 60 * 1000, lat: HUB.lat, lng: HUB.lng }] });
    check('future-skew point → 200, accepted 0', r.status === 200 && r.json.accepted === 0);

    // 4. bad token → 401
    r = await post('deadbeef', { locations: [{ ts: NOW, lat: HUB.lat, lng: HUB.lng }] });
    check('bad token → 401', r.status === 401);

    // 5. no token → 401
    r = await post(null, { locations: [{ ts: NOW, lat: HUB.lat, lng: HUB.lng }] });
    check('missing token → 401', r.status === 401);

    // 6. wrong shift (token shift != driver.current_shift_id) → 401 shift_mismatch
    await db.ref(`drivers/${UID}/current_shift_id`).set('some-other-shift');
    r = await post(RAW, { locations: [{ ts: NOW + 1, lat: HUB.lat, lng: HUB.lng }] });
    check('wrong shift → 401 shift_mismatch', r.status === 401 && r.json.error === 'shift_mismatch');
    await db.ref(`drivers/${UID}/current_shift_id`).set(SHIFT);

    // 7. off shift → 403
    await db.ref(`drivers/${UID}/status`).set('off_shift');
    r = await post(RAW, { locations: [{ ts: NOW + 2, lat: HUB.lat, lng: HUB.lng }] });
    check('off shift → 403', r.status === 403);
  } finally {
    // --- cleanup ---
    await db.ref(`driver_tokens/${HASH}`).remove();
    await db.ref(`drivers/${UID}`).update({
      current_shift_id: null, location_source: null, current_task_id: null,
      ingest_token_hash: null, last_location_ts: null, status: 'available'
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
