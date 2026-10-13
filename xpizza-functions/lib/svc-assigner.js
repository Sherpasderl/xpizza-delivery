// S1a (PLAN-S1 §3) — the narrowly-privileged "svc-assigner" database handle.
//
// Server mutations that CREATE/RESTORE task ownership or OPEN a shift go through a SECOND Admin app whose
// databaseAuthVariableOverride presents `auth = { uid: 'svc-assigner', svc_assigner: true }`, so the §2 commit-time
// eligibility invariant in the RTDB rules binds these server writes exactly as it binds a client. Every OTHER server
// write keeps the ordinary unrestricted default Admin app (lib/admin.js).
//
// LAZY, NAMED, SINGLETON on purpose: portal/portal-split.test.js asserts that merely REQUIRING the deployed modules
// leaves exactly ONE (default) Admin app at module load. So this app is created on FIRST USE (inside a handler), never
// at require time. The default app (lib/admin.js) is created first by index.js and carries the emulator-coherence
// guard for the process; getDatabase() on the prod URL auto-redirects to the emulator under FIREBASE_DATABASE_EMULATOR_HOST.
const { getApp, initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const SVC_APP_NAME = 'svc-assigner';
let _app = null;

// The RTDB handle bound to the svc-assigner identity. Reused across calls (one named app per process).
function svcAssignerDb() {
  if (!_app) {
    try {
      _app = getApp(SVC_APP_NAME);   // reuse if some earlier call (or a test) already created it
    } catch (_) {
      _app = initializeApp({
        databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com',
        databaseAuthVariableOverride: { uid: 'svc-assigner', svc_assigner: true },
      }, SVC_APP_NAME);
    }
  }
  return getDatabase(_app);
}

module.exports = { svcAssignerDb, SVC_APP_NAME };
