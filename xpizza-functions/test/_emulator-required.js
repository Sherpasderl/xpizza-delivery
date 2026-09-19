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
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const VAR = {
  firestore: 'FIRESTORE_EMULATOR_HOST',
  database: 'FIREBASE_DATABASE_EMULATOR_HOST',
};
module.exports = function requireEmulator(...services) {
  const missing = services.filter((s) => VAR[s] && !process.env[VAR[s]]);
  if (missing.length) return refuse(`${missing.map((s) => VAR[s]).join(', ')} not set`,
    'This suite would run against real infrastructure instead of the emulator.');

  /* 🔴 PRESENT IS NOT THE SAME AS OURS. This checked only that the variable existed, while its own
     comment claimed it refused invocation outside the runner — untrue: a suite handed
     FIRESTORE_EMULATOR_HOST=foreign.example:1234 passed the check and asserted happily against
     whatever was there. Presence was the weaker half of the property; the point was never "some
     emulator", it was "THIS checkout's emulator". So validate both halves: the host must be
     loopback, and the port must be the one this checkout's band assigns. Then the comment is true. */
  let expected = null;
  try {
    const { planPorts, offsetFor, ROOT } = require('../tools/emulator-run.js');
    expected = planPorts(offsetFor(ROOT));
  } catch (_) { expected = null; }   // runner unavailable → fall back to the loopback check alone

  for (const s of services) {
    const raw = VAR[s] && process.env[VAR[s]];
    if (!raw) continue;
    const i = String(raw).lastIndexOf(':');
    const host = i > 0 ? String(raw).slice(0, i) : String(raw);
    const port = i > 0 ? Number(String(raw).slice(i + 1)) : NaN;
    if (!LOOPBACK.has(host.replace(/^\[|\]$/g, ''))) {
      return refuse(`${VAR[s]}=${raw} is not loopback`,
        'That is someone else\'s emulator — asserting against it proves nothing about this tree.');
    }
    if (expected && Number.isFinite(port) && expected[s] !== undefined && port !== expected[s]) {
      return refuse(`${VAR[s]}=${raw} is not this checkout's port (expected ${expected[s]})`,
        'A loopback port from a DIFFERENT checkout is the exact collision the per-checkout bands remove.');
    }
  }
};

function refuse(what, why) {
  console.error(`\n🔴 REFUSED — ${what}.`);
  console.error(`   ${why}`);
  console.error('   Run it through the runner:  npm run test:<suite>   (tools/emulator-run.js)\n');
  process.exit(1);
}
