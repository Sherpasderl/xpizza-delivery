'use strict';
// S1a (PLAN-S1 §6, advisor condition 3) — COVERAGE guard: every driver onCall in index.js calls the shared
// hard-stop assertDriverCallerActive, and the known-driver-callable list is COMPLETE. When S1b adds
// submitDriverProfile = onCall, the completeness check fails until it is listed AND wraps the guard — so S1b
// cannot forget the hard-stop. Pure structural read of index.js (no fold; it checks the LIVE wiring).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// The driver onCall callables that MUST carry the hard-stop. submitDriverProfile joins this list in S1b.
const DRIVER_CALLABLES = ['registerDriverPushToken', 'unregisterDriverPushToken', 'startDriverShift', 'endDriverShift'];

// 1. COMPLETENESS — every onCall export whose name contains "Driver" is accounted for (no silent new one).
const found = [...idx.matchAll(/exports\.(\w*[Dd]river\w*)\s*=\s*onCall\(/g)].map((m) => m[1]).sort();
assert.deepStrictEqual(found, [...DRIVER_CALLABLES].sort(),
  `🔴 the set of driver onCall callables changed — update DRIVER_CALLABLES AND wrap each in assertDriverCallerActive.\n  found:    ${found.join(', ')}\n  expected: ${[...DRIVER_CALLABLES].sort().join(', ')}`);
ok(`completeness: exactly the ${DRIVER_CALLABLES.length} known driver onCall callables exist (a new one fails this until listed)`);

// 2. each driver callable's body calls the shared hard-stop (with the caller uid + the decoded token).
for (const name of DRIVER_CALLABLES) {
  const start = idx.indexOf(`exports.${name} = onCall(`);
  assert.ok(start > -1, `🔴 driver callable ${name} not found in index.js`);
  const next = idx.indexOf('\nexports.', start + 1);
  const body = idx.slice(start, next === -1 ? idx.length : next);
  assert.ok(/await assertDriverCallerActive\(uid, request\.auth\?\.token, \{ db: getDatabase\(\), auth: getAuth\(\), HttpsError \}\)/.test(body),
    `🔴 driver callable ${name} does not call the shared hard-stop assertDriverCallerActive(uid, request.auth?.token, …)`);
}
ok(`all ${DRIVER_CALLABLES.length} driver callables invoke assertDriverCallerActive before their work`);

// 3. non-vacuity — a doctored body without the guard is detected, and an extra driver onCall trips completeness.
{
  const nameless = idx.replace(/await assertDriverCallerActive\([^;]*\);\s*\/\/ S1a §6\n/, '');
  assert.notStrictEqual(nameless, idx, 'premise: a guard call was removed');
  const start = nameless.indexOf('exports.registerDriverPushToken = onCall(');
  const body = nameless.slice(start, nameless.indexOf('\nexports.', start + 1));
  assert.ok(!/assertDriverCallerActive/.test(body), 'non-vacuity: removing a guard call is observable in the body slice');
  const extra = idx.replace('exports.registerDriverPushToken = onCall(', 'exports.submitDriverProfile = onCall({}, async () => {});\nexports.registerDriverPushToken = onCall(');
  const found2 = [...extra.matchAll(/exports\.(\w*[Dd]river\w*)\s*=\s*onCall\(/g)].map((m) => m[1]).sort();
  assert.notDeepStrictEqual(found2, [...DRIVER_CALLABLES].sort(), 'non-vacuity: a NEW driver onCall (submitDriverProfile) trips the completeness check');
}
ok('non-vacuity: a missing guard call and a new unlisted driver onCall are each caught');

console.log(`\ndriver-callable-guard-coverage.guard: OK (${n})`);
