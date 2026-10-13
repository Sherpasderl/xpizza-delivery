// Unit test for the lazy svc-assigner Admin-app getter (PLAN-S1 §3). Run: node lib/svc-assigner.test.js
// Asserts: (1) requiring the module creates NO app (lazy — so the one-default-app module-load invariant holds);
// (2) first use creates a NAMED 'svc-assigner' app, never a default; (3) the databaseAuthVariableOverride presents
// uid 'svc-assigner' + the svc_assigner claim; (4) it is a singleton (reused, no second app); (5) it returns an RTDB handle.
const assert = require('node:assert/strict');
const { getApps, getApp } = require('firebase-admin/app');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok ${passed} ${name}`); };

// Lazy: the module must not create any app merely by being required.
const before = getApps().map((a) => a.name);
assert.ok(!before.includes('svc-assigner'), 'requiring the module must not create the svc-assigner app');
const { svcAssignerDb, SVC_APP_NAME } = require('./svc-assigner');

t('require-time is inert: no app created until first use', () => {
  assert.equal(getApps().map((a) => a.name).includes('svc-assigner'), false);
  assert.equal(SVC_APP_NAME, 'svc-assigner');
});

let db1;
t('first use creates a NAMED app (not a default) with the svc-assigner auth override', () => {
  db1 = svcAssignerDb();
  const app = getApp('svc-assigner');            // throws if it was created under the wrong name
  assert.equal(app.name, 'svc-assigner');
  assert.notEqual(app.name, '[DEFAULT]');
  const ov = app.options.databaseAuthVariableOverride;
  assert.deepEqual(ov, { uid: 'svc-assigner', svc_assigner: true }, 'override must present uid svc-assigner + the claim');
  assert.equal(app.options.databaseURL, 'https://xpizza-delivery-default-rtdb.firebaseio.com');
});

t('returns an RTDB handle', () => {
  assert.equal(typeof db1.ref, 'function');
});

t('singleton: a second call reuses the same app (no new app created)', () => {
  const n = getApps().length;
  const db2 = svcAssignerDb();
  assert.equal(getApps().length, n, 'no second app on reuse');
  assert.equal(getApp('svc-assigner'), getApp('svc-assigner'));
  assert.equal(typeof db2.ref, 'function');
});

t('never creates a DEFAULT app as a side effect', () => {
  assert.ok(!getApps().some((a) => a.name === '[DEFAULT]'), 'the svc-assigner getter must never create the default app');
});

console.log(`\nsvc-assigner: ${passed} tests passed`);
