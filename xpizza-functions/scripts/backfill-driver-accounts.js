#!/usr/bin/env node
/**
 * One-time, IDEMPOTENT backfill of /driver_accounts from the OWNER-CONFIRMED explicit uid list
 * (driver-accounts-backfill.lib.js) — NOT a /drivers scan. For each uid it verifies the Auth user exists,
 * then writes the account record create-if-absent via a transaction (never overwrites an existing account).
 *
 * DRY-RUN by default (reports what it would do); pass --apply to write.
 * Run against the emulator by setting FIREBASE_DATABASE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST.
 *
 *   node scripts/backfill-driver-accounts.js            # dry run
 *   node scripts/backfill-driver-accounts.js --apply    # write (create-if-absent)
 */
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const {
  DRIVER_BACKFILL, DISPATCHER_UID, accountRecord, authRtdbCoherent,
  EXPECTED_PROJECT, RTDB_URL, assertProject, lookupAuthExistence, getAdcAccessToken,
} = require('../driver-accounts-backfill.lib');

(async () => {
  const apply = process.argv.includes('--apply');
  // Mixed/foreign emulator signals ⇒ refuse before any client (part would reach an emulator, part production).
  // No signal ⇒ the intended one-time PRODUCTION backfill proceeds; run against the emulator via tools/emulator-run.js.
  const emuMode = require('../tools/emu-mixed-guard')('backfill-driver-accounts');
  // codex r1 P1-6: Auth and RTDB must be COHERENT (both emulator or both prod) before constructing any client —
  // emu-mixed-guard does not inspect FIREBASE_AUTH_EMULATOR_HOST, so an Auth-only-emulator env would hit the emulator
  // for getUser() while account writes hit production RTDB.
  if (!authRtdbCoherent(emuMode, process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
    console.error('REFUSING: Auth and RTDB destinations are incoherent — set BOTH emulator hosts (FIREBASE_AUTH_EMULATOR_HOST + FIREBASE_DATABASE_EMULATOR_HOST) or NEITHER.');
    process.exit(2);
  }

  // [[cutover-pin-gcp-project]] — before ANY write, assert the target project and pin it explicitly, so a
  // drifted ambient gcloud/GOOGLE_CLOUD_PROJECT can never redirect the backfill to the wrong project.
  // (Emulator mode uses the demo project, so this prod pin only applies to the real one-time backfill.)
  if (emuMode !== 'emulator') {
    try { assertProject(process.env); } catch (e) { console.error(e.message); process.exit(2); }
    process.env.GOOGLE_CLOUD_PROJECT = EXPECTED_PROJECT;
    initializeApp({ projectId: EXPECTED_PROJECT, databaseURL: RTDB_URL });
  } else {
    initializeApp({ databaseURL: RTDB_URL });
  }
  const db = getDatabase();
  const auth = getAuth();

  // Safety: the dispatcher uid must never appear in the list (dual-role protection).
  if (DRIVER_BACKFILL.some((d) => d.uid === DISPATCHER_UID)) {
    console.error('REFUSING: the dispatcher uid is in the driver backfill list.');
    process.exit(1);
  }

  // Verify Auth existence. PROD: ONE batch REST accounts:lookup via an ADC access token + X-Goog-User-Project
  // (getAuth().getUser fails under local ADC — see the lib note / driver-onboarding-runbook). A non-200 THROWS
  // here and aborts the whole run — it is never counted as "missing → skip". EMULATOR: keep per-uid getUser.
  let authFound = null; // Set of existing uids (prod); null ⇒ use per-uid getUser (emulator)
  if (emuMode !== 'emulator') {
    const accessToken = getAdcAccessToken();  // FAIL CLOSED + sanitized: never surfaces the child's stdout/stderr
    authFound = await lookupAuthExistence(DRIVER_BACKFILL.map((d) => d.uid), { fetchImpl: fetch, accessToken, project: EXPECTED_PROJECT });
  }

  console.log(`${apply ? 'APPLY' : 'DRY-RUN'} · ${DRIVER_BACKFILL.length} driver accounts · project ${emuMode === 'emulator' ? '(emulator)' : EXPECTED_PROJECT}`);
  let created = 0, existed = 0, missing = 0;
  for (const d of DRIVER_BACKFILL) {
    if (authFound) {
      // prod: existence was determined by the batch lookup (a failed lookup already threw above).
      if (!authFound.has(d.uid)) { console.error(`  AUTH MISSING: ${d.uid} (${d.label})`); missing++; continue; }
    } else {
      try {
        await auth.getUser(d.uid);
      } catch (e) {
        // Only a DETERMINED absence is "missing". Any other error (internal/transport) FAILS CLOSED — abort,
        // never silently skip a uid that may actually exist.
        if (e.code === 'auth/user-not-found') { console.error(`  AUTH MISSING: ${d.uid} (${d.label})`); missing++; continue; }
        throw e;
      }
    }
    const ref = db.ref(`driver_accounts/${d.uid}`);
    if (!apply) {
      const snap = await ref.get();
      console.log(`  ${snap.exists() ? 'exists      ' : 'WOULD create'} ${d.uid} (${d.label})`);
      continue;
    }
    // create-if-absent: the transaction aborts (returns undefined) when a record already exists -> never overwrites.
    const res = await ref.transaction((cur) => (cur === null ? accountRecord(d, Date.now()) : undefined));
    if (res.committed) { created++; console.log(`  created ${d.uid} (${d.label})`); }
    else { existed++; console.log(`  exists  ${d.uid} (${d.label})`); }
  }
  console.log(`\n${apply ? `created ${created}, already existed ${existed}` : 'dry run complete'}${missing ? `, AUTH MISSING ${missing}` : ''}`);
  if (missing) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
