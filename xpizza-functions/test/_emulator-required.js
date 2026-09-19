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
const VAR = {
  firestore: 'FIRESTORE_EMULATOR_HOST',
  database: 'FIREBASE_DATABASE_EMULATOR_HOST',
};
module.exports = function requireEmulator(...services) {
  const missing = services.filter((s) => VAR[s] && !process.env[VAR[s]]);
  if (!missing.length) return;
  console.error(`\n🔴 REFUSED — ${missing.map((s) => VAR[s]).join(', ')} not set.`);
  console.error('   This suite would run against real infrastructure instead of the emulator.');
  console.error('   Run it through the runner:  npm run test:<suite>   (tools/emulator-run.js)\n');
  process.exit(1);
};
