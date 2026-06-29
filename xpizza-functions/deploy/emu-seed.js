'use strict';

/**
 * Emulator-ONLY seed helper for the (S) readiness and (C) probe dry-runs. Writes x_pizza identity
 * into the DB emulator. Refuses to run without FIREBASE_DATABASE_EMULATOR_HOST (never prod — prod
 * seeding is seed_identity.js).
 *
 * Usage: node deploy/emu-seed.js [active|inactive|invalid|missing]   (default: active)
 */
const admin = require('firebase-admin');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('emu-seed: refusing to run without FIREBASE_DATABASE_EMULATOR_HOST (emulator only)');
  process.exit(1);
}
// Seed the SAME namespace the deployed function reads (the function's hardcoded prod ns — see
// deploy/emu-ns.js), so createOrder/getIdentity inside the functions emulator find this identity.
const { emuDatabaseURL } = require('./emu-ns');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: emuDatabaseURL() });

const VALID = {
  name: 'X Pizza', hub_lat: 15.507489753573818, hub_lng: -88.0398486953722, phone: '+50497952893',
  whatsapp_instance: 'instance170156', whatsapp_enabled: true, delivery_radius_km: 7,
  hours: {
    sun: { open: true, start: '12:00', end: '19:45' }, mon: { open: true, start: '12:00', end: '19:45' },
    tue: { open: true, start: '12:00', end: '19:45' }, wed: { open: true, start: '12:00', end: '19:45' },
    thu: { open: true, start: '12:00', end: '20:45' }, fri: { open: true, start: '12:00', end: '20:45' },
    sat: { open: true, start: '12:00', end: '20:45' },
  },
  active: true, version: 1,
};

(async () => {
  const ref = admin.database().ref('restaurants/x_pizza/identity');
  const mode = process.argv[2] || 'active';
  if (mode === 'missing') { await ref.remove(); console.log('emu-seed: x_pizza identity REMOVED'); }
  else if (mode === 'inactive') { await ref.set({ ...VALID, active: false }); console.log('emu-seed: x_pizza identity (active:false)'); }
  else if (mode === 'invalid') { await ref.set({ ...VALID, hub_lat: 'oops' }); console.log('emu-seed: x_pizza identity INVALID (hub_lat string)'); }
  else { await ref.set(VALID); console.log('emu-seed: x_pizza identity valid + active'); }
  process.exit(0);
})().catch((e) => { console.error('emu-seed: FAIL —', e.message); process.exit(1); });
