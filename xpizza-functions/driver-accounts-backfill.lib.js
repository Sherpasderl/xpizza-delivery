const { execFileSync } = require('child_process');

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

// PROD is xpizza-delivery (source of truth: .firebaserc default + the RTDB URL). The backfill reads Auth and
// writes /driver_accounts ONLY here. See [[cutover-pin-gcp-project]] and driver-onboarding-runbook.
const EXPECTED_PROJECT = 'xpizza-delivery';
const RTDB_URL = `https://${EXPECTED_PROJECT}-default-rtdb.firebaseio.com`;

// [[cutover-pin-gcp-project]] — never trust the ambient gcloud/GOOGLE_CLOUD_PROJECT for a prod write; it DRIFTS.
// Validate (pure): throw if the ambient project is set to anything other than the expected one; return the
// expected project so the caller pins it explicitly on initializeApp. An UNSET ambient is fine (ADC resolves it).
function assertProject(env, expected = EXPECTED_PROJECT) {
  const ambient = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT || '';
  if (ambient && ambient !== expected) {
    throw new Error(`REFUSING: ambient GCP project '${ambient}' !== '${expected}'. The backfill writes ONLY to '${expected}'. Unset GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT / GCP_PROJECT, or set it to '${expected}'.`);
  }
  return expected;
}

// Verify Auth existence via the REST Identity Toolkit accounts:lookup (BATCH by localId), because
// firebase-admin's getAuth().getUser FAILS under local user ADC ("identitytoolkit requires a quota project" —
// firebase-admin 12 does not forward quota_project_id; the REST path sends an explicit X-Goog-User-Project header
// that ADC DOES honor; see driver-onboarding-runbook). Returns a Set of the localIds that EXIST.
//   FAIL CLOSED: a non-200 response — OR a thrown transport error — ABORTS (throws). It is NEVER downgraded to
//   "this uid is missing → skip", because an UNDETERMINED lookup must not let a real, enabled account be silently
//   skipped during --apply. Only a 200 whose `users` array omits a uid means that uid is genuinely absent.
async function lookupAuthExistence(uids, { fetchImpl, accessToken, project = EXPECTED_PROJECT }) {
  const res = await fetchImpl(
    `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Goog-User-Project': project,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ localId: uids }),
    },
  );
  // Require EXACTLY 200. Any other status — including a 2xx such as 202 — is an UNDETERMINED result and
  // must ABORT, never be downgraded to "missing → skip".
  if (!res || res.status !== 200) {
    const status = res && typeof res.status !== 'undefined' ? res.status : '??';
    let detail = '';
    try { detail = String(await res.text()).slice(0, 300); } catch (_) { /* best-effort */ }
    // THROW — do not return. A caller must never read a Set out of a non-200 lookup.
    throw new Error(`accounts:lookup failed (HTTP ${status}) — ABORTING, not skipping (an undetermined lookup must not silently skip a real account): ${detail}`);
  }
  const data = await res.json();
  // Validate the shape — a malformed 200 is also undetermined → ABORT. A 200 with `users` ABSENT is the
  // LEGITIMATE "none of these uids exist" result (empty set), NOT an error.
  // NB: a top-level ARRAY is also `typeof 'object'` and non-null — reject it explicitly, else a 200 body of
  // [] or [{}] would slip through with `users` undefined and read as an empty set ("missing"). Only a plain
  // object is a valid lookup body.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('accounts:lookup returned a non-object body — ABORTING, not skipping.');
  }
  if (data.users !== undefined && !Array.isArray(data.users)) {
    throw new Error('accounts:lookup `users` is present but not an array — ABORTING, not skipping.');
  }
  const users = Array.isArray(data.users) ? data.users : [];
  for (const u of users) {
    if (!u || typeof u.localId !== 'string') {
      throw new Error('accounts:lookup returned a user entry without a string localId — ABORTING, not skipping.');
    }
  }
  return new Set(users.map((u) => u.localId));
}

// Obtain a gcloud ADC access token for the REST accounts:lookup. FAIL CLOSED with a SANITIZED error: a failing
// token command can echo a credential on its stdout/stderr, so its child output is NEVER surfaced (the thrown
// error carries no stdout/stderr/child message). `execImpl` is injectable for tests; default runs gcloud.
function getAdcAccessToken({ execImpl } = {}) {
  const run = execImpl || (() => execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  let out;
  try {
    out = run();
  } catch (_) {
    // Swallow the child error entirely (it may contain a token on stdout/stderr) — throw a clean, static message.
    throw new Error('REFUSING: could not obtain a gcloud ADC access token (try `gcloud auth application-default login`). [child output suppressed]');
  }
  const token = String(out || '').trim();
  if (!token) throw new Error('REFUSING: gcloud returned an empty ADC access token.');
  return token;
}

module.exports = {
  DRIVER_BACKFILL, DISPATCHER_UID, accountRecord, authRtdbCoherent,
  EXPECTED_PROJECT, RTDB_URL, assertProject, lookupAuthExistence, getAdcAccessToken,
};
