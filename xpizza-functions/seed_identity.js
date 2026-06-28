'use strict';

/**
 * Seed /restaurants/{rid}/identity (config-plane identity) for x_pizza and la_musa.
 * Phase 0 Step 2. Run ONCE per environment, deliberately, AFTER the emulator suite is green.
 *
 * SAFETY:
 *  - Idempotent: skips any rid whose /restaurants/{rid}/identity already exists (never clobbers).
 *  - Never reads or writes /restaurants/{rid}/factura_config (owned by the factura system).
 *  - Self-validates each payload shape BEFORE writing — Admin SDK bypasses RTDB .validate, so the
 *    rules' type/shape guarantees must be re-asserted here.
 *  - la_musa ships DARK: active:false + whatsapp_enabled:false (no traffic until full validation).
 *
 * Config via .env: FB_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS (or SERVICE_ACCOUNT_JSON),
 * ULTRAMSG_INSTANCE_ID (x_pizza's connected WhatsApp instance id, e.g. "instance170156").
 */

require('dotenv').config();
const admin = require('firebase-admin');

const XPIZZA_INSTANCE = process.env.ULTRAMSG_INSTANCE_ID;

const IDENTITIES = {
  x_pizza: {
    name: 'X Pizza', // seeded as-is to preserve current behavior (brand 'X. Pizza' tracked separately)
    hub_lat: 15.507489753573818,
    hub_lng: -88.0398486953722,
    phone: '+50497952893',
    whatsapp_instance: XPIZZA_INSTANCE, // from .env (not committed)
    whatsapp_enabled: true,
    delivery_radius_km: 7,
    hours: {
      sun: { open: true, start: '12:00', end: '19:45' },
      mon: { open: true, start: '12:00', end: '19:45' },
      tue: { open: true, start: '12:00', end: '19:45' },
      wed: { open: true, start: '12:00', end: '19:45' },
      thu: { open: true, start: '12:00', end: '20:45' },
      fri: { open: true, start: '12:00', end: '20:45' },
      sat: { open: true, start: '12:00', end: '20:45' },
    },
    active: true,
    version: 1,
  },
  la_musa: {
    name: 'La Musa',
    hub_lat: 15.50414,
    hub_lng: -88.03848,
    phone: '+50493736607',
    whatsapp_instance: '', // instance not provisioned yet (plan step 22)
    whatsapp_enabled: false, // dark
    delivery_radius_km: 9.66,
    hours: {
      mon: { open: false },
      tue: { open: false },
      wed: { open: true, start: '17:00', end: '20:45' },
      thu: { open: true, start: '17:00', end: '20:45' },
      fri: { open: true, start: '17:00', end: '21:45' },
      sat: { open: true, start: '17:00', end: '21:45' },
      sun: { open: true, start: '17:00', end: '20:45' },
    },
    active: false, // dark — no traffic until full integration validation
    version: 1,
  },
};

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Re-assert the shape the RTDB .validate rules enforce (Admin SDK bypasses them). Throws on any violation. */
function assertIdentityShape(rid, id) {
  const req = ['name', 'hub_lat', 'hub_lng', 'phone', 'whatsapp_instance', 'whatsapp_enabled',
    'delivery_radius_km', 'hours', 'active', 'version'];
  for (const k of req) {
    if (!Object.prototype.hasOwnProperty.call(id, k)) throw new Error(`${rid}: missing identity field '${k}'`);
  }
  if (typeof id.name !== 'string' || !id.name) throw new Error(`${rid}: name must be a non-empty string`);
  if (typeof id.hub_lat !== 'number' || typeof id.hub_lng !== 'number') throw new Error(`${rid}: hub_lat/hub_lng must be numbers`);
  if (typeof id.phone !== 'string') throw new Error(`${rid}: phone must be a string`);
  if (typeof id.whatsapp_instance !== 'string') throw new Error(`${rid}: whatsapp_instance must be a string`);
  if (typeof id.whatsapp_enabled !== 'boolean') throw new Error(`${rid}: whatsapp_enabled must be a boolean`);
  if (typeof id.delivery_radius_km !== 'number') throw new Error(`${rid}: delivery_radius_km must be a number`);
  if (typeof id.active !== 'boolean') throw new Error(`${rid}: active must be a boolean`);
  if (typeof id.version !== 'number') throw new Error(`${rid}: version must be a number`);
  // hours: all 7 days, each {open:false} or {open:true, start:'HH:MM', end:'HH:MM'} (no nulls)
  if (!id.hours || typeof id.hours !== 'object') throw new Error(`${rid}: hours must be an object`);
  for (const d of DAYS) {
    const h = id.hours[d];
    if (!h || typeof h !== 'object') throw new Error(`${rid}: hours.${d} missing/invalid`);
    if (h.open === false) continue;
    if (h.open !== true) throw new Error(`${rid}: hours.${d}.open must be a boolean`);
    if (!HHMM.test(h.start) || !HHMM.test(h.end)) throw new Error(`${rid}: hours.${d} start/end must be HH:MM`);
  }
}

async function main() {
  if (!XPIZZA_INSTANCE) throw new Error('ULTRAMSG_INSTANCE_ID not set — required for x_pizza whatsapp_instance');

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.FB_DATABASE_URL,
  });
  const db = admin.database();

  // Validate every payload up front — refuse to write anything if any is malformed.
  for (const [rid, id] of Object.entries(IDENTITIES)) assertIdentityShape(rid, id);

  for (const [rid, id] of Object.entries(IDENTITIES)) {
    const ref = db.ref(`restaurants/${rid}/identity`); // never touches factura_config
    const snap = await ref.once('value');
    if (snap.exists()) {
      console.log(`[seed] ${rid}/identity already exists — skipping (idempotent)`);
      continue;
    }
    await ref.set(id);
    console.log(`[seed] ${rid}/identity written (active=${id.active}, whatsapp_enabled=${id.whatsapp_enabled}, version=${id.version})`);
  }

  console.log('[seed] done');
  process.exit(0);
}

module.exports = { assertIdentityShape, IDENTITIES };

if (require.main === module) {
  main().catch((e) => {
    console.error('[seed] FAILED:', e.message);
    process.exit(1);
  });
}
