'use strict';
/* Refuse to run unless the emulator host variables this suite needs are actually set.
 *
 * 🔴 WHY EVERY SUITE NEEDS THIS, not just the ones that remembered. An emulator suite whose host
 * variable is unset does not fail — the Admin SDK quietly targets REAL infrastructure (and in a demo
 * project, returns PERMISSION_DENIED, which reads like a broken test rather than a misrouted one).
 * Worse, if a value is INHERITED from some other shell it targets a FOREIGN emulator and the suite
 * passes green against another tree. tools/emulator-run.js now clears the vars for services it does
 * not start, so the remaining failure mode is being launched outside the runner entirely — which is
 * what this refuses.
 *
 * catalog-rules had a bespoke version of this; catalog-parity and public-menu had none and seeded
 * Admin Firestore regardless. Same class as the hardcoded port: one suite remembered, the rest did
 * not, and nothing said so.
 */
/* 🔴 NO ENTRY FOR `functions`, BECAUSE THE CLI SETS NO HOST VAR FOR IT. I asserted
   FUNCTIONS_EMULATOR_HOST here first and test:quality-runner started refusing to run — a guard that
   invented its own precondition and then failed a working suite on it. Checked against the installed
   CLI: `--only functions,database` exports CLOUD_EVENTARC_EMULATOR_HOST, CLOUD_TASKS_EMULATOR_HOST,
   FIREBASE_DATABASE_EMULATOR_HOST and FIREBASE_EMULATOR_HUB — and nothing for functions itself. A
   service with no var is simply not checkable this way; asserting one anyway is a false guard, which
   is worse than none because it fails honest runs. */
/* R1 (PLAN-emulator-isolation §c.1): THE CHECK IS THE SHARED RUN-ENDPOINT VALIDATOR (lib/emulator-endpoint.js), not
   a copy. It enforces strict loopback (no 0.0.0.0, no suffix hosts, no leading zeros), the EXACT slot from
   XPIZZA_EMU_OFFSET (published by tools/emulator-run.js — there is no path-derived band any more), the hub, the
   Firestore alias agreeing with its primary, and BOTH data services configured (the one this run did not start is the
   NULL endpoint, never absent). On top of that, every service THIS suite names must be a REAL endpoint: a suite that
   needs Firestore cannot run against the NULL one. */
const EE = require('../lib/emulator-endpoint');
module.exports = function requireEmulator(...services) {
  const missing = services.filter((s) => EE.HOST_VAR[s] && !process.env[EE.HOST_VAR[s]]);
  if (missing.length) return refuse(`${missing.map((s) => EE.HOST_VAR[s]).join(', ')} not set`,
    'This suite would run against real infrastructure instead of the emulator.');
  /* 🔴 FAIL CLOSED WITHOUT THE RUN'S SLOT. Without XPIZZA_EMU_OFFSET this cannot tell THIS run's emulator from
     another worktree's on the same machine, so it refuses rather than accept "some local emulator". */
  if (!process.env[EE.OFFSET_VAR]) return refuse(`${EE.OFFSET_VAR} is not set — the run's slot is unknown`,
    'Without it this cannot tell THIS run\'s emulator from another worktree\'s, so it refuses.');
  let v;
  try { v = EE.validateEmulatorEnv(process.env); } catch (e) {
    return refuse(String(e && e.message || e).replace(/^🔴 REFUSED — /, ''), 'A foreign or half-configured emulator is someone else\'s tree — asserting against it proves nothing about this one.');
  }
  for (const s of services) {
    if (v.endpoints[s] === EE.NULL_ENDPOINT) return refuse(`${EE.HOST_VAR[s]} is the NULL endpoint — this run did not start ${s}`,
      `Add ${s} to the script's --only list.`);
  }
};

function refuse(what, why) {
  console.error(`\n🔴 REFUSED — ${what}.`);
  console.error(`   ${why}`);
  console.error('   Run it through the runner:  npm run test:<suite>   (tools/emulator-run.js)\n');
  process.exit(1);
}

/* For the DEV HARNESSES that are not suites (deploy/emulator-e2e.js, deploy/config-read-probe.js, the D4-P1 capture,
   the KDS writer, the portal workers probe): the same validator, called BEFORE the harness requires index.js or any
   client, plus any functions/HTTP URL it will call. A harness may be run under a raw `firebase emulators:exec` (no
   XPIZZA_EMU_OFFSET), so the slot is matched exactly when known and only in-range otherwise — loopback and on-band
   either way, so it can never reach production. A missing signal REFUSES (no prod fall-back). */
module.exports.harness = function requireEmulatorHarness(services, { functionsUrls = [] } = {}) {
  let v;
  try {
    v = EE.validateEmulatorEnv(process.env);
    for (const u of functionsUrls) EE.validateFunctionsUrl(u, process.env);
  } catch (e) {
    return refuse(String(e && e.message || e).replace(/^🔴 REFUSED — /, ''), 'This harness writes through real Admin clients; anything but THIS run\'s local emulators is refused before any client exists.');
  }
  for (const s of services) {
    if (v.endpoints[s] === EE.NULL_ENDPOINT) return refuse(`${EE.HOST_VAR[s]} is the NULL endpoint — this run did not start ${s}`, `Start ${s} for this harness.`);
  }
  return v;
};
