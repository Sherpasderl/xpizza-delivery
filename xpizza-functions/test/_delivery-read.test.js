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
// envío restaurant limit (PLAN r5 §2.4/§8, the ONE declared I/O delta): chargeOnlineOrder's pre-bookkeeping check — ONE plain
// `get orders/<oid>` on the null-dq route, the op right before the bookkeeping opens (the content-stamp read / a rate-limit op),
// ahead of every write — is set aside with the config read; anything else at that path is untouched, and a second / late one is RED
{
  const pre = { db: 'rtdb', op: 'get', path: 'orders/<oid>' };
  const stamp = { db: 'rtdb', op: 'once', path: 'recent_order_content/<phoneKey>/ck' };
  const rate = { db: 'rtdb', op: 'transaction', path: 'rate_limits/ip/k' };
  assert.deepStrictEqual(DR.without([floor, R, pre, stamp, w], 'precheck + stamp'), [floor, stamp, w], 'the pre-check read before the stamp read is set aside');
  assert.deepStrictEqual(DR.without([R, pre, rate, w], 'precheck + rate'), [rate, w], 'before a rate-limit op (no phone) too');
  assert.deepStrictEqual(DR.without([R, pre, floor, w], 'other get'), [pre, floor, w], 'an orders read NOT opening the bookkeeping is kept (compared to the golden)');
  assert.throws(() => DR.without([R, pre, stamp, pre, rate, w], 'two prechecks'), /pre-check read must occur at most ONCE/);
  assert.throws(() => DR.without([R, w, pre, stamp], 'late precheck'), /pre-check read must precede every RTDB write/);
  assert.deepStrictEqual(DR.without([R, { db: 'fs', op: 'runTransaction', path: '' }, pre, stamp], 'fs read txn first'), [{ db: 'fs', op: 'runTransaction', path: '' }, stamp], 'a Firestore read transaction ahead of it is not an RTDB write');
  ok('without(): the envío limit pre-check read (one plain get orders/<oid> opening the bookkeeping) set aside; two / late → RED; any other orders read kept');
}
console.log(`\n_delivery-read: ${n} passed`);
