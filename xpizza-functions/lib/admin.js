// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §1) — the ONE firebase-admin default app, shared by index.js (full load)
// and portal/functions.js (isolated portal entrypoints). Moved VERBATIM from index.js; Node's module cache makes it run
// once per process, and a second default app still throws exactly as before (firebase-admin lifecycle).
// Sloppy mode on purpose: the moved code keeps index.js's semantics.
const { initializeApp } = require('firebase-admin/app');

initializeApp({
  databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com'
});
