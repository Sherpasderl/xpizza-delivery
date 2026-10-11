'use strict';
/* Preloaded by tools/emulator-run.js into every `node <file>` of a suite command (beside count-marks.js).
 *
 * The launcher points a data service it did NOT start at the NULL endpoint (127.0.0.1:1) so nothing can fall back to
 * production — but a NULL service the suite touches by accident must fail FAST: measured on firebase-admin, a NULL
 * Firestore read rejects only after ~46 s and a NULL RTDB read never settles. lib/admin.js arms the same guard for
 * the default app; this covers a suite that builds its OWN app. Services the suite declared deliberately dead
 * (XPIZZA_EMU_DEAD) are left to the real SDK — a dead-backend test measures exactly that behaviour.
 *
 * Silent when there is nothing to guard. If the guard cannot be armed it throws: an unguarded NULL is a hang.
 */
const { NULL_ENDPOINT, HOST_VAR, DATA_SERVICES, DEAD_VAR, installNullGuard } = require('../lib/emulator-endpoint');

// Exactly the validator's rule: only the literal "firestore" opts out; anything else is NOT an opt-out (fail closed).
const dead = new Set(process.env[DEAD_VAR] === 'firestore' ? ['firestore'] : []);
const nulls = DATA_SERVICES.filter((s) => process.env[HOST_VAR[s]] === NULL_ENDPOINT && !dead.has(s));
if (nulls.length) installNullGuard(nulls, require('firebase-admin/app'));
