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

// ⚠️ AUTH-SHAPE PARITY (codex r1 P1-7 follow-up): databaseAuthVariableOverride makes the rules' `auth` variable EXACTLY
// this object. The rules key on auth.uid === 'svc-assigner', and a svc path (the claim transaction's /tasks read) also
// evaluates `auth.token.customer !== true` — so `token` MUST be present or auth.token.customer dereferences a missing
// object. A present (empty-of-customer) token resolves auth.token.customer to null (!== true → allowed), exactly as a
// non-customer. The parity harness proves the identical shape via authenticatedContext('svc-assigner', SVC_AUTH.token),
// and svc-auth-parity.guard asserts this literal matches the harness.
const SVC_AUTH = Object.freeze({ uid: 'svc-assigner', token: Object.freeze({ svc_assigner: true }) });
let _app = null;

// The RTDB handle bound to the svc-assigner identity. Reused across calls (one named app per process).
function svcAssignerDb() {
  if (!_app) {
    try {
      _app = getApp(SVC_APP_NAME);   // reuse if some earlier call (or a test) already created it
    } catch (_) {
      _app = initializeApp({
        databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com',
        databaseAuthVariableOverride: SVC_AUTH,
      }, SVC_APP_NAME);
    }
  }
  return getDatabase(_app);
}

module.exports = { svcAssignerDb, SVC_APP_NAME, SVC_AUTH };
