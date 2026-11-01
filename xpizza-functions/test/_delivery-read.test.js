'use strict';
// Unit cells for test/_delivery-read.js (codex S3a r1 P2-5): removal is validation — two reads, a write, a late read, a missing
// read on a request that wrote, all fail; one plain early get is removed and nothing else is touched.
const assert = require('assert');
const DR = require('./_delivery-read');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const R = { db: 'rtdb', op: 'get', path: 'platform_config/delivery_pricing' };
const floor = { db: 'rtdb', op: 'get', path: 'platform_config/client_floor/orders' };
const w = { db: 'rtdb', op: 'set', path: 'orders/o1' };
assert.deepStrictEqual(DR.without([floor, R, w], 'one'), [floor, w]);
assert.deepStrictEqual(DR.without([floor], 'none, no write'), [floor], 'a request that wrote nothing may carry none');
assert.throws(() => DR.without([R, R, w], 'two'), /exactly ONCE/);
assert.throws(() => DR.without([{ ...R, op: 'set' }, w], 'write'), /plain rtdb get/);
assert.throws(() => DR.without([w, R], 'late'), /precede every write/);
assert.throws(() => DR.without([floor, w], 'missing'), /WROTE must carry exactly one/);
const harness = { db: 'rtdb', op: 'remove', path: 'rate_limits' };
assert.deepStrictEqual(DR.without([harness, R, w], 'harness first', { ignore: (e) => e === harness }), [harness, w], 'a declared harness op ahead of the read is not the request\'s write');
assert.throws(() => DR.without([harness, R, w], 'harness undeclared'), /precede every write/);
assert.deepStrictEqual(DR.without([w], 'release', { expected: 0 }), [w], 'a non-intake flow carries none');
assert.throws(() => DR.without([R, w], 'release with read', { expected: 0 }), /must carry NO envío config read/);
assert.throws(() => DR.without([floor], 'intake, no write, none', { expected: 1 }), /exactly one/);
ok('without(): one early plain get removed; two reads / a write at that path / a read after a write / none on a writing request → RED');
console.log(`\n_delivery-read: ${n} passed`);
