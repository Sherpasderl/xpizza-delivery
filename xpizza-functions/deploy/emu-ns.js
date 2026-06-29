'use strict';

/**
 * The deployed functions' Admin app hardcodes the prod databaseURL (index.js:98 —
 * 'https://xpizza-delivery-default-rtdb.firebaseio.com'). Inside the functions emulator,
 * FIREBASE_DATABASE_EMULATOR_HOST redirects the HOST to local but keeps the NAMESPACE label, so
 * createOrder/getIdentity read the emulator's 'xpizza-delivery-default-rtdb' namespace.
 *
 * The harness must seed/read THAT same namespace (not the PID-derived one) to agree with the
 * function. Centralized here so emu-seed.js / check-seed-readiness.js / config-read-probe.js can't
 * drift. The emulator host keeps every op local regardless of the ns label — this never touches prod.
 */
const EMU_NS = 'xpizza-delivery-default-rtdb'; // must match index.js:98's databaseURL namespace

function emuDatabaseURL() {
  const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!host) throw new Error('emu-ns: FIREBASE_DATABASE_EMULATOR_HOST not set (emulator only)');
  return `http://${host}?ns=${EMU_NS}`;
}

module.exports = { EMU_NS, emuDatabaseURL };
