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
/* 🔴 0.0.0.0 IS NOT LOOPBACK. It is the wildcard bind address; as a destination it is reachable from
   off-box and is exactly the shape a foreign emulator would arrive as. It was in this set. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const VAR = {
  firestore: 'FIRESTORE_EMULATOR_HOST',
  database: 'FIREBASE_DATABASE_EMULATOR_HOST',
};
module.exports = function requireEmulator(...services) {
  const missing = services.filter((s) => VAR[s] && !process.env[VAR[s]]);
  if (missing.length) return refuse(`${missing.map((s) => VAR[s]).join(', ')} not set`,
    'This suite would run against real infrastructure instead of the emulator.');

  /* 🔴 FAIL CLOSED WHEN THE BAND CANNOT BE COMPUTED. This used to swallow the failure and fall back
     to the loopback check alone, so a broken or moved runner silently downgraded the guarantee to
     "some local emulator" — the weaker property this exists to replace. If we cannot tell whether the
     emulator is ours, we do not run. */
  let expected;
  try {
    const { planPorts, offsetFor, ROOT } = require('../tools/emulator-run.js');
    expected = planPorts(offsetFor(ROOT));
  } catch (e) {
    return refuse(`the port bands could not be computed (${(e && e.message) || e})`,
      'Without them this cannot tell THIS checkout\'s emulator from another one, so it refuses.');
  }

  /* The hub is checked whether or not the suite asked for it. rules-unit-testing DISCOVERS its
     endpoints through FIREBASE_EMULATOR_HUB and PREFERS what it discovers over the per-service
     variables — so a suite could hold a perfectly correct local database address and still be pointed
     at a foreign checkout's database by an inherited hub. The runner clears it, so this only bites a
     direct invocation, which is precisely the case this helper is for. */
  const toCheck = services.map((s) => [VAR[s], expected[s]]).filter(([v]) => v);
  toCheck.push(['FIREBASE_EMULATOR_HUB', expected.hub]);

  for (const [varName, wantPort] of toCheck) {
    const raw = process.env[varName];
    if (!raw) continue;                       // absent is handled above for services; absent hub is fine
    const i = String(raw).lastIndexOf(':');
    const host = i > 0 ? String(raw).slice(0, i) : String(raw);
    const portText = i > 0 ? String(raw).slice(i + 1) : '';
    if (!LOOPBACK.has(host.replace(/^\[|\]$/g, ''))) {
      return refuse(`${varName}=${raw} is not loopback`,
        'That is someone else\'s emulator — asserting against it proves nothing about this tree.');
    }
    /* 🔴 AN UNREADABLE PORT REFUSES; IT DOES NOT SKIP THE CHECK. The comparison used to run only when
       the port parsed, so a bare "127.0.0.1" or "127.0.0.1:garbage" sailed past the band check
       entirely — the two shapes most likely to come from a hand-set variable. */
    if (!/^\d+$/.test(portText)) {
      return refuse(`${varName}=${raw} has no readable port`,
        'The band check cannot run on it, and an unchecked address is how a foreign emulator gets in.');
    }
    if (wantPort !== undefined && Number(portText) !== wantPort) {
      return refuse(`${varName}=${raw} is not this checkout's port (expected ${wantPort})`,
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
