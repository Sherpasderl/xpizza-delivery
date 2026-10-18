'use strict';
/**
 * H1c-server (PLAN-H1c, APPROVED) — the handheld push against the REAL RTDB emulator (real transactions, the real indexed location query,
 * null-first transaction semantics). Messaging is a recording stub (tests reach loopback only). Run: npm run test:merchant-push
 *   1. register: the row + ownership index; re-pair moves ownership; unregister is epoch-fenced
 *   2. reconcile: the fence before the read; pending ids + transition at (push log, else created_at) via the indexed query
 *   3. S2 intake → one data message per eligible device + the push log; S3 accept → exactly one resolved; marker-only reject → resolved
 *   4. codex r4 reorderings on the real push-log transaction; legacy / KDS / other location → zero sends and zero writes
 *   5. dead token compare-and-clear on a real row (the T1→T2 race keeps T2)
 *   6. the five functions are exported by index.js (the h1c block)
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const IO = require('../merchant/merchant-push-io');
const fns = require('../index');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const db = getDatabase();
const T0 = Date.now();
const EP = 'epoch_abcdefghij0123'; const EP2 = 'epoch_ZYXWVUTSRQ9876';
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const resolveBrand = async (_d, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');
const dev = (uid, rid = 'tb_norte') => ({ uid, token: { handheld: true, rid } });
function recorder(fail = {}) { const sent = []; return { sent, sendEach: async (msgs) => { sent.push(...msgs); return { responses: msgs.map((m) => (fail[m.token] ? { success: false, error: { code: fail[m.token] } } : { success: true })) }; } }; }
const deps = (messaging = recorder(), extra = {}) => ({ db, resolveBrand, HttpsError, now: () => Date.now(), messaging, queryLocationOrders: IO.queryLocationOrders, ...extra });
const ev = (oid, before, after, at) => ({ params: { orderId: oid }, time: new Date(at).toISOString(), data: { before: { val: () => before }, after: { val: () => after } } });
const order = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', created_at: T0 - 9000, ...over });

(async () => {
  await db.ref().set({
    restaurants: {
      tb_norte: { order_surface: 'handheld', handhelds: { hh_a: { kind: 'handheld', revoked: false }, hh_b: { kind: 'handheld', revoked: false } } },
      tb_centro: { order_surface: 'kds', handhelds: { hh_c: { kind: 'handheld', revoked: false, fcm_token: 'TC', push_epoch: EP } } },
    },
    orders: { o1: order('o1'), o2: order('o2'), o3: order('o3'), oc: order('oc', { restaurant_id: 'tb_centro' }), ol: order('ol', { routing_reason: null }) },
  });

  // 1. register / re-pair / unregister
  const r1 = await IO.registerPush(deps(), dev('hh_a'), { rid: 'tb_norte', token: 'TOKA', epoch: EP });
  assert.strictEqual(r1.registered_token_hash, IO.sha('TOKA'));
  assert.deepStrictEqual(await val(`merchant_push_tokens/${IO.sha('TOKA')}`), { rid: 'tb_norte', uid: 'hh_a' });
  await IO.registerPush(deps(), dev('hh_b'), { rid: 'tb_norte', token: 'TOKA', epoch: EP2 });       // the same installation re-paired
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_a/fcm_token'), null, 'ownership moved');
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_b/fcm_token'), 'TOKA');
  assert.deepStrictEqual(await IO.unregisterPush(deps(), dev('hh_b'), { rid: 'tb_norte', epoch: EP }), { ok: true, cleared: false }, 'a stale epoch never unregisters');
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_b/fcm_token'), 'TOKA');
  await IO.registerPush(deps(), dev('hh_a'), { rid: 'tb_norte', token: 'TOKA2', epoch: EP });
  ok('register writes the row + index; re-pair moves ownership; unregister is epoch-fenced (real transactions)');

  // 2. reconcile through the REAL indexed query
  await db.ref('merchant_push_log/o2').set({ new_at: T0 + 30 });
  const before = Date.now();
  const rc = await IO.pendingOrders(deps(), dev('hh_a'), { rid: 'tb_norte' });
  assert.ok(rc.fence >= before && rc.fence <= Date.now());
  assert.deepStrictEqual(rc.pending, [{ order_id: 'o1', at: T0 - 9000 }, { order_id: 'o2', at: T0 + 30 }, { order_id: 'o3', at: T0 - 9000 }], 'legacy (no routing) excluded');
  ok('reconcile: the fence before the read; pending + transition at, via the indexed location query');

  // 3. S2 / S3 on real data
  const m3 = recorder();
  const s2 = await IO.onStatusWritten(deps(m3), ev('o1', null, 'new', T0 + 100));
  assert.deepStrictEqual([s2.type, s2.sent], ['new_order', 2]);
  assert.deepStrictEqual(m3.sent.map((m) => [m.token, m.data.epoch, m.data.at]).sort(), [['TOKA', EP2, String(T0 + 100)], ['TOKA2', EP, String(T0 + 100)]]);
  assert.deepStrictEqual(await val('merchant_push_log/o1'), { new_at: T0 + 100 });
  await db.ref('orders/o1').update({ status: 'preparing', handheld_answered: { kind: 'accepted' } });   // accept = status + marker
  const m4 = recorder();
  await IO.onStatusWritten(deps(m4), ev('o1', 'new', 'preparing', T0 + 200));
  await IO.onAnsweredWritten(deps(m4), ev('o1', null, { kind: 'accepted' }, T0 + 200));
  assert.deepStrictEqual(m4.sent.map((m) => m.data.type), ['resolved', 'resolved'], 'one resolved per device, ONE logical resolution');
  assert.strictEqual(await val('merchant_push_log/o1'), null);
  await db.ref('orders/o3/handheld_answered').set({ kind: 'rejected' });                              // marker-only reject
  const m5 = recorder();
  assert.strictEqual((await IO.onAnsweredWritten(deps(m5), ev('o3', null, { kind: 'rejected' }, T0 + 300))).type, 'resolved');
  ok('S2 intake → one data message per eligible device + the push log; S3 accept → one resolution; a marker-only reject → resolved');

  // 4. reorderings + zero-effect guards
  await IO.onStatusWritten(deps(), ev('o2', null, 'new', T0 + 500));
  await db.ref('orders/o2/status').set('preparing');
  await IO.onStatusWritten(deps(), ev('o2', 'new', 'preparing', T0 + 400));                          // a delayed S3 OLDER than the entry
  assert.deepStrictEqual(await val('merchant_push_log/o2'), { new_at: T0 + 500 }, 'kept');
  await db.ref('orders/o2/status').set('new');
  await IO.onStatusWritten(deps(), ev('o2', 'releasing', 'new', T0 + 50));                           // a delayed S2
  assert.deepStrictEqual(await val('merchant_push_log/o2'), { new_at: T0 + 500 }, 'not overwritten');
  const snap = JSON.stringify(await val('/'));
  const mz = recorder();
  for (const oid of ['oc', 'ol']) { await IO.onStatusWritten(deps(mz), ev(oid, null, 'new', T0 + 600)); await IO.onStatusWritten(deps(mz), ev(oid, 'new', 'preparing', T0 + 601)); }
  assert.strictEqual(mz.sent.length, 0);
  assert.strictEqual(JSON.stringify(await val('/')), snap, 'zero writes');
  ok('codex r4 reorderings hold on the real transaction; KDS-location and legacy orders → zero sends and zero writes');

  // 5. dead token: compare-and-clear on the real row (T1→T2 race)
  const raceMsg = { sendEach: async (msgs) => { await db.ref('restaurants/tb_norte/handhelds/hh_a/fcm_token').set('TOKA3'); return { responses: msgs.map(() => ({ success: false, error: { code: 'messaging/registration-token-not-registered' } })) }; } };
  await IO.sendTo(deps(raceMsg), 'tb_norte', 'new_order', 'o2', T0 + 700);
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_a/fcm_token'), 'TOKA3', 'the replacement token is kept');
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_b/fcm_token'), null, 'the dead one (still TOKA) is cleared');
  ok('dead tokens: compare-and-clear against the exact token sent (T1→T2 keeps T2) on real rows');

  // 6. wiring
  for (const name of ['merchantRegisterPush', 'merchantUnregisterPush', 'merchantPendingOrders', 'merchantPushOnStatus', 'merchantPushOnAnswered']) {
    assert.strictEqual(typeof fns[name], 'function', `index.js exports ${name}`);
  }
  ok('index.js exports the five h1c functions');

  console.log(`\nmerchant-push: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('merchant-push FAILED:', e && e.stack || e); process.exit(1); });
