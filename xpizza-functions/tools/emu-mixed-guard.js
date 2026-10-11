'use strict';
/* MIXED SIGNALS REFUSE — for the operator CLIs and scripts (codex R1-build P1-1, r2 P1-2).
 *
 * A production CLI run from a shell that still carries ONE emulator host var (a stale FIRESTORE_EMULATOR_HOST, say)
 * used to send that service to an emulator and the other to PRODUCTION. That is never what anyone meant. Rule:
 *   · no emulator signal  → production, exactly as before (this returns 'prod' and changes nothing);
 *   · any emulator signal → the configuration must be COHERENT: both data services set, each strict loopback on its own
 *     band (the exact slot when XPIZZA_EMU_OFFSET is known) or the exact NULL endpoint, the Firestore alias agreeing,
 *     the hub on its band — the shared validator in its LENIENT form. Otherwise REFUSE, before any client exists.
 *
 * 🔴 THE CHECK MUST SEE THE FINAL ENVIRONMENT (codex r2 P1-2). Eleven CLIs load dotenv AFTER require-project's early
 * check, so a .env could introduce a foreign emulator host the check never saw. Rather than re-check at eleven call
 * sites, armClientRecheck() hooks the ONE place every Firestore / RTDB client is constructed — firebase-admin's
 * FirebaseApp.getOrInitService — and re-runs the check there, against process.env AS IT IS at construction time.
 */
const EE = require('../lib/emulator-endpoint');

function refuseMixedSignals(who, env = process.env) {
  if (!EE.hasEmulatorSignal(env)) return 'prod';
  try { EE.validateEmulatorEnv(env, { lenient: true }); return 'emulator'; } catch (e) {
    console.error(`\n🔴 REFUSED — ${who}: ${String(e && e.message || e).replace(/^🔴 REFUSED — /, '')}.`);
    console.error('   Emulator variables are present but do not describe ONE coherent local run — part of this tool would reach');
    console.error('   an emulator and part PRODUCTION. Unset them all for production, or run under tools/emulator-run.js.\n');
    process.exit(2);
  }
}

/* A PRODUCTION-ONLY tool (it talks to deployed endpoints by design): ANY emulator signal is refused outright. */
function refuseAnySignal(who, env = process.env) {
  if (!EE.hasEmulatorSignal(env)) return 'prod';
  console.error(`\n🔴 REFUSED — ${who} is PRODUCTION-ONLY (it calls deployed endpoints), but emulator variables are set.`);
  console.error('   Unset FIRESTORE_EMULATOR_HOST / FIREBASE_DATABASE_EMULATOR_HOST / FUNCTIONS_EMULATOR / the hub and run it again.\n');
  process.exit(2);
}

const ARMED = Symbol.for('xpizza.emu.clientRecheck');
/* Re-run refuseMixedSignals at EVERY data-client construction (firestore / database), on the live process.env. */
function armClientRecheck(who, adminApp = require('firebase-admin/app')) {
  const proto = EE.firebaseAppPrototype(adminApp);
  if (!proto || proto[ARMED]) return false;
  const inner = proto.getOrInitService;
  proto.getOrInitService = function recheckedGetOrInitService(name, init) {
    if (name === 'firestore' || name === 'database') refuseMixedSignals(`${who} (re-checked at ${name} client construction)`);
    return inner.call(this, name, init);
  };
  proto[ARMED] = true;
  return true;
}

module.exports = refuseMixedSignals;
module.exports.refuseMixedSignals = refuseMixedSignals;
module.exports.refuseAnySignal = refuseAnySignal;
module.exports.armClientRecheck = armClientRecheck;
