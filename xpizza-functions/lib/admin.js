// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §1) — the ONE firebase-admin default app, shared by index.js (full load)
// and portal/functions.js (isolated portal entrypoints). Moved VERBATIM from index.js; Node's module cache makes it run
// once per process, and a second default app still throws exactly as before (firebase-admin lifecycle).
// Sloppy mode on purpose: the moved code keeps index.js's semantics.
const { initializeApp } = require('firebase-admin/app');

// R1 emulator isolation (PLAN-emulator-isolation §b.6): an emulator signal (FUNCTIONS_EMULATOR exactly "true", or a
// non-empty emulator host var) ⇒ validate this run's endpoints first, and refuse (throw) a half-configured or foreign
// one rather than let the init below reach production. Any other FUNCTIONS_EMULATOR value is NOT a signal (a deployed
// "false" takes the production path). Required ONLY on this branch; with no signal nothing extra loads.
if (process.env.FUNCTIONS_EMULATOR === 'true' || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_FIRESTORE_EMULATOR_ADDRESS
  || process.env.FIREBASE_DATABASE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR_HUB) require('./emulator-endpoint').guardEmulatorProcess();

initializeApp({
  databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com'
});
