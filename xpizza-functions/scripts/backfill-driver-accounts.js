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
const { DRIVER_BACKFILL, DISPATCHER_UID, accountRecord, authRtdbCoherent } = require('../driver-accounts-backfill.lib');

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
  initializeApp({ databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com' });
  const db = getDatabase();
  const auth = getAuth();

  // Safety: the dispatcher uid must never appear in the list (dual-role protection).
  if (DRIVER_BACKFILL.some((d) => d.uid === DISPATCHER_UID)) {
    console.error('REFUSING: the dispatcher uid is in the driver backfill list.');
    process.exit(1);
  }

  console.log(`${apply ? 'APPLY' : 'DRY-RUN'} · ${DRIVER_BACKFILL.length} driver accounts`);
  let created = 0, existed = 0, missing = 0;
  for (const d of DRIVER_BACKFILL) {
    try {
      await auth.getUser(d.uid);
    } catch (e) {
      console.error(`  AUTH MISSING: ${d.uid} (${d.label}) — ${e.code || e.message}`);
      missing++;
      continue;
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
