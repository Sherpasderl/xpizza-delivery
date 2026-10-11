'use strict';
/* MIXED SIGNALS REFUSE — for the operator CLIs and scripts (codex R1-build P1-1).
 *
 * A production CLI run from a shell that still carries ONE emulator host var (a stale FIRESTORE_EMULATOR_HOST, say)
 * used to send that service to an emulator and the other to PRODUCTION. That is never what anyone meant. Rule:
 *   · no emulator signal  → production, exactly as before (this returns 'prod' and changes nothing);
 *   · any emulator signal → the configuration must be COHERENT: both data services set, each strict loopback on its own
 *     band (the exact slot when XPIZZA_EMU_OFFSET is known) or the exact NULL endpoint, the Firestore alias agreeing,
 *     the hub on its band — the shared validator in its LENIENT form (a CLI's deliberately dead backend, e.g. a test
 *     pointing the registry at 127.0.0.1:1, is allowed; lib/admin.js's started/dead rules are suite-level). Otherwise
 *     REFUSE, before any client exists.
 * Called by tools/require-project.js (so every require-project CLI gets it) and directly by the functions-root scripts.
 */
const EE = require('../lib/emulator-endpoint');

module.exports = function refuseMixedSignals(who, env = process.env) {
  if (!EE.hasEmulatorSignal(env)) return 'prod';
  try { EE.validateEmulatorEnv(env, { lenient: true }); return 'emulator'; } catch (e) {
    console.error(`\n🔴 REFUSED — ${who}: ${String(e && e.message || e).replace(/^🔴 REFUSED — /, '')}.`);
    console.error('   Emulator variables are present but do not describe ONE coherent local run — part of this tool would reach');
    console.error('   an emulator and part PRODUCTION. Unset them all for production, or run under tools/emulator-run.js.\n');
    process.exit(2);
  }
};
