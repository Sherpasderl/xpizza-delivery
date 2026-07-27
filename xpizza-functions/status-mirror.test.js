'use strict';

// Unit test for the P3 status-mirror decision core (status-mirror.js). Proves UPDATE-ONLY-IF-EXISTS:
// guest / no-entry (pending, unpaid) → NULL (never create a partial history entry — codex HIGH-1);
// attributed + existing entry → the field-level status update path. (Trigger-level fail-open / no-loop /
// race are emulator-level.) Run: node status-mirror.test.js
const assert = require('assert');
const { decideStatusMirror } = require('./status-mirror');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const O = 'PZX-500', UID = 'u_' + 'a'.repeat(24);

// guest (no customer_uid) → no-op
assert.strictEqual(decideStatusMirror(O, null, true, 'delivered'), null); ok('guest (no uid) → null');
assert.strictEqual(decideStatusMirror(O, '', true, 'delivered'), null); ok('empty uid → null');

// NO history entry yet (pending_payment / unpaid) → NEVER create (the HIGH-1 guarantee)
assert.strictEqual(decideStatusMirror(O, UID, false, 'pending_payment'), null); ok('no entry → null (never index an unpaid order)');
assert.strictEqual(decideStatusMirror(O, UID, false, 'new'), null); ok('no entry + new → still null (materialize owns creation)');

// missing status → no-op
assert.strictEqual(decideStatusMirror(O, UID, true, null), null); ok('null status → null');
assert.strictEqual(decideStatusMirror(O, UID, true, ''), null); ok('empty status → null');
assert.strictEqual(decideStatusMirror('', UID, true, 'new'), null); ok('no orderId → null');

// attributed + entry EXISTS → the field-level status update (targets the existing entry's status leaf)
assert.deepStrictEqual(decideStatusMirror(O, UID, true, 'delivered'),
  { path: `user_orders/${UID}/${O}/status`, value: 'delivered' }); ok('entry exists → update status leaf (delivered)');
assert.deepStrictEqual(decideStatusMirror(O, UID, true, 'cancelled'),
  { path: `user_orders/${UID}/${O}/status`, value: 'cancelled' }); ok('entry exists → update status leaf (cancelled)');

console.log(`\nstatus-mirror: ${n} assertions passed`);
