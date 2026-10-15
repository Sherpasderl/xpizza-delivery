'use strict';
// COVERAGE guard — S1a (PLAN-S1 §6) + S1b (split). Every DRIVER-gated onCall wraps the shared hard-stop
// assertDriverCallerActive; every DISPATCHER-ADMIN onCall wraps assertDispatcherCaller. Two separate coverage sets,
// each complete, so no new callable can silently skip its gate. Pure structural read of the LIVE index.js (no fold).
//
// Why a split (codex r2 finding 11): the old "every onCall whose name contains Driver" heuristic would wrongly
// demand the driver guard on the dispatcher-admin callables (inviteDriver/approveDriver/setDriverSuspended/
// setDriverDeactivated), and it misses `reactivate` entirely (no "Driver" in the name). So we enumerate both sets
// explicitly and assert the correct gate for each; S1a's original four driver guards are retained verbatim.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// DRIVER-gated onCall (must inline assertDriverCallerActive). submitDriverProfile joined this set in S1b.
const DRIVER_CALLABLES = ['registerDriverPushToken', 'unregisterDriverPushToken', 'startDriverShift', 'endDriverShift', 'submitDriverProfile'];
// DISPATCHER-ADMIN onCall (must inline assertDispatcherCaller). reactivate has NO "Driver" in its name.
const DISPATCHER_ADMIN_CALLABLES = ['inviteDriver', 'approveDriver', 'setDriverSuspended', 'setDriverDeactivated', 'reactivate'];

const bodyOf = (src, name) => {
  const start = src.indexOf(`exports.${name} = onCall(`);
  assert.ok(start > -1, `🔴 callable ${name} not found as an onCall export in index.js`);
  const next = src.indexOf('\nexports.', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
};
const DRIVER_GUARD = /await assertDriverCallerActive\(uid, request\.auth\?\.token, \{[^}]*HttpsError \}\)/;
const DISPATCHER_GUARD = /await adminOps\.assertDispatcherCaller\(uid, request\.auth\?\.token, \{[^}]*HttpsError \}\)/;

// 1. COMPLETENESS of the "Driver"-named onCall set = the driver callables + the "Driver"-named dispatcher-admin
//    ones (reactivate is onCall but unnamed by the heuristic, so it is checked explicitly in step 3).
const foundDriverNamed = [...idx.matchAll(/exports\.(\w*[Dd]river\w*)\s*=\s*onCall\(/g)].map((m) => m[1]).sort();
const expectedDriverNamed = [...DRIVER_CALLABLES, 'inviteDriver', 'approveDriver', 'setDriverSuspended', 'setDriverDeactivated'].sort();
assert.deepStrictEqual(foundDriverNamed, expectedDriverNamed,
  `🔴 the set of "Driver"-named onCall callables changed — update the coverage sets AND wrap each in the correct gate.\n  found:    ${foundDriverNamed.join(', ')}\n  expected: ${expectedDriverNamed.join(', ')}`);
ok(`completeness: exactly the ${expectedDriverNamed.length} known "Driver"-named onCall callables exist`);

// 2. each DRIVER callable inlines the shared hard-stop (preserves S1a's original four + adds submitDriverProfile).
for (const name of DRIVER_CALLABLES) {
  assert.ok(DRIVER_GUARD.test(bodyOf(idx, name)), `🔴 driver callable ${name} does not inline assertDriverCallerActive(uid, request.auth?.token, …)`);
}
ok(`all ${DRIVER_CALLABLES.length} driver callables invoke assertDriverCallerActive (incl. S1a's original four)`);

// 3. each DISPATCHER-ADMIN callable exists as onCall and inlines the dispatcher gate (reactivate enumerated here).
for (const name of DISPATCHER_ADMIN_CALLABLES) {
  const body = bodyOf(idx, name);
  assert.ok(DISPATCHER_GUARD.test(body), `🔴 dispatcher-admin callable ${name} does not inline adminOps.assertDispatcherCaller(uid, request.auth?.token, …)`);
  assert.ok(!DRIVER_GUARD.test(body), `🔴 dispatcher-admin callable ${name} must NOT use the driver guard`);
}
ok(`all ${DISPATCHER_ADMIN_CALLABLES.length} dispatcher-admin callables invoke assertDispatcherCaller (incl. reactivate)`);

// 4. non-vacuity — removing a driver guard call is observable; dropping a dispatcher gate is observable.
{
  const stripped = idx.replace(DRIVER_GUARD, '/* removed */');
  assert.notStrictEqual(stripped, idx, 'premise: a driver guard call exists to remove');
  assert.ok(!DRIVER_GUARD.test(bodyOf(stripped, 'registerDriverPushToken')) || !DRIVER_GUARD.test(bodyOf(stripped, 'endDriverShift')),
    'non-vacuity: removing a driver guard call changes a body slice');
  const strippedDisp = idx.replace(DISPATCHER_GUARD, '/* removed */');
  assert.notStrictEqual(strippedDisp, idx, 'non-vacuity: a dispatcher gate call exists to remove');
}
ok('non-vacuity: a missing driver guard and a missing dispatcher gate are each observable');

console.log(`\ndriver-callable-guard-coverage.guard: OK (${n})`);
