/**
 * H1a — the handheld cores against a REAL RTDB (emulator, Admin SDK). Run: npm run test:merchant
 *   1. Null-first safety on a COLD cache: the first transaction call sees null for an EXISTING order; the updater proposes
 *      null, the server rejects the stale hash and re-runs with the real value → the accept commits (never a false
 *      not_found). A truly absent order → not_found and NO node is created.
 *   2. Two devices accept concurrently → exactly one preparing; the other stale_state.
 *   3. Replay of the same op returns the stored result; the node is byte-identical.
 *   4. Reject → the intent + rejected marker commit on the order (status stays new). The cancel itself (A-R1) runs through
 *      the real cancel core in test/merchant-reject.emulator.test.js.
 *   5. Concurrent pause (CLI-shaped transaction) + busy on the same node → both survive, one event row.
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
require('../lib/admin');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const O = require('../merchant/merchant-orders');
const C = require('../merchant/merchant-control');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const db = getDatabase();
const resolveBrand = async (_db, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');
let seq = 0;
const deps = () => ({ db, resolveBrand, HttpsError, now: () => Date.now(), timestamp: () => ServerValue.TIMESTAMP, newOpId: () => `oc_emu_${Date.now().toString(36)}_${++seq}` });
const dev = (uid) => ({ uid, token: { handheld: true, rid: 'tb_norte' } });
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);

(async () => {
  await db.ref().set({
    restaurants: { tb_norte: { order_surface: 'handheld', handhelds: { hh_a: { kind: 'handheld', revoked: false }, hh_b: { kind: 'handheld', revoked: false } } } },
    orders: {
      o1: { order_id: 'o1', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'delivery' },
      o2: { order_id: 'o2', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'delivery' },
      o3: { order_id: 'o3', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'pickup' },
    },
    tasks: { o1_delivery: { assigned_driver_id: null }, o2_delivery: { assigned_driver_id: null } },
  });

  // 1. cold cache (no listener / no prior read of orders/o1 in this process)
  const r1 = await O.runOrderAction(deps(), dev('hh_a'), 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 22, op_id: 'op_cold0001' });
  assert.deepStrictEqual([r1.ok, r1.status], [true, 'preparing'], `cold-cache accept: ${JSON.stringify(r1)}`);
  const absent = await O.runOrderAction(deps(), dev('hh_a'), 'accept', { rid: 'tb_norte', oid: 'nope', prep_min: 22, op_id: 'op_cold0002' });
  assert.deepStrictEqual([absent.ok, absent.code], [false, 'not_found']);
  assert.strictEqual((await db.ref('orders/nope').once('value')).val(), null, 'no node created for an absent order');
  ok('null-first: a cold-cache accept commits on the existing order; an absent order is not_found and is not created');

  // 2. concurrent accepts
  const [a, b] = await Promise.all([
    O.runOrderAction(deps(), dev('hh_a'), 'accept', { rid: 'tb_norte', oid: 'o2', prep_min: 18, op_id: 'op_race000a' }),
    O.runOrderAction(deps(), dev('hh_b'), 'accept', { rid: 'tb_norte', oid: 'o2', prep_min: 30, op_id: 'op_race000b' }),
  ]);
  assert.deepStrictEqual([a.ok, b.ok].sort(), [false, true], `exactly one wins: ${JSON.stringify([a, b])}`);
  const loser = a.ok ? b : a;
  assert.strictEqual(loser.code, 'stale_state');
  const o2 = (await db.ref('orders/o2').once('value')).val();
  assert.strictEqual(Object.keys(o2.handheld_ops).length, 1, 'one receipt only');
  ok('two devices accept concurrently → exactly one preparing, the other stale_state, one receipt');

  // 3. replay
  const before = JSON.stringify((await db.ref('orders/o1').once('value')).val());
  assert.deepStrictEqual(await O.runOrderAction(deps(), dev('hh_a'), 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 22, op_id: 'op_cold0001' }), r1);
  assert.strictEqual(JSON.stringify((await db.ref('orders/o1').once('value')).val()), before);
  ok('replay of the same op returns the stored result; the node is byte-identical');

  // 4. reject → intent + marker on the order (A-R1's cancel is covered by merchant-reject.emulator.test.js)
  const rj = await O.runOrderAction(deps(), dev('hh_a'), 'reject', { rid: 'tb_norte', oid: 'o3', reason: 'saturada', op_id: 'op_reject01' });
  assert.strictEqual(rj.ok, true);
  const o3 = (await db.ref('orders/o3').once('value')).val();
  assert.deepStrictEqual([o3.status, o3.handheld_answered.kind, o3.reject_intent.op_id], ['new', 'rejected', 'op_reject01']);
  ok('reject → intent + rejected marker + receipt in one commit on a real RTDB; status stays new');

  // 5. concurrent pause + busy
  const [p] = await Promise.all([
    C.writePause(deps(), 'tb_norte', { op: 'pause', forMs: 30 * 60000, reason: 'Cocina llena', actor: 'handheld:hh_a', principal: 'hh_a' }),
    C.writeBusy(deps(), 'tb_norte', { add_min: 15, dur_min: 60, actor: 'handheld:hh_b' }),
  ]);
  const node = (await db.ref('order_control/tb_norte').once('value')).val();
  assert.strictEqual(p.ok, true);
  assert.strictEqual(node.current.paused, true);
  assert.strictEqual(node.busy.add_min, 15);
  assert.deepStrictEqual(Object.keys(node.events), [p.op_id]);
  ok('concurrent pause + busy on one node: both survive; one event row');

  console.log(`\nmerchant emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('merchant emulator FAILED:', e && e.stack || e); process.exit(1); });
