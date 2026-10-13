// Pure data + record builder for the one-time /driver_accounts backfill (S1a).
// The uid list is OWNER-CONFIRMED (2026-10-13, verified read-only in prod) and EXPLICIT — it is NOT derived
// from a /drivers scan (self-created /drivers data is not proof of staff membership). The executable tool
// (scripts/backfill-driver-accounts.js) verifies each uid exists in Auth and writes create-if-absent.

// The 6 real driver accounts. Order is immaterial; uids are verbatim from the owner.
const DRIVER_BACKFILL = [
  { uid: 'HUQ4nOdvNvQcbxoqyYinp8wAC7f2', label: 'xavierlacayo (owner driver account)' },
  { uid: 'IulqMqE4eoYiIBQQmP3PMukpdig1', label: 'Gabriel' },
  { uid: 'SQCET7U9FqQ3QqfXvxqNIjGujwo2', label: 'Jose Fernando' },
  { uid: 'YdIzZGATQfPv0q2IVgX54xyP7382', label: 'Elmer' },
  { uid: 'xaHcwaRND1V63w8tpXi5VZ7n9P72', label: 'Hermez' },
  { uid: 'b7ca8bb823009c956473f7519032', label: 'Play Reviewer (test)', note: 'play-review' },
];

// The ONLY dispatcher uid (owner-confirmed). It must NEVER be backfilled as a driver — the cuadre rules
// forbid a dispatcher uid from stamping delivered_by, and the owner delivers with a SEPARATE driver uid.
const DISPATCHER_UID = 'rSCvNmml23aJlWVX5SbFjZElk4m1';

// The account record written for a grandfathered driver: operational from the start, flagged as grandfathered.
function accountRecord(driver, now) {
  const r = { enabled: true, onboarding_state: 'active', grandfathered: true, updated_at: now };
  if (driver.note) r.note = driver.note;
  return r;
}

// codex r1 P1-6 — Auth and RTDB destinations must be COHERENT before any client: emu-mixed-guard ignores
// FIREBASE_AUTH_EMULATOR_HOST, so an Auth-only-emulator env would send getUser() to an emulator while account
// writes land in PRODUCTION RTDB (or vice-versa). emuMode is emu-mixed-guard's return ('prod' | 'emulator').
function authRtdbCoherent(emuMode, authEmuHostSet) { return (emuMode === 'emulator') === !!authEmuHostSet; }

module.exports = { DRIVER_BACKFILL, DISPATCHER_UID, accountRecord, authRtdbCoherent };
