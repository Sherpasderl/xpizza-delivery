'use strict';
// S2 delivery proof (PLAN-brand-agnostic-convergence r9 §3-S, #334-4; Codex #414 P2-1): the REAL triggers — notifyStaffOnNewOrder,
// flushStaffPushQueue, sweepStuckOrders (index.js exports, in-process) — through the REAL fanoutStaffPush → sendStaffPush, over the
// honest RTDB model; every push is captured at the send seam (web-push sendNotification). Subscribers: a current dispatcher, a
// merchant account, a driver account, a REVOKED dispatcher (dispatchers/{uid} removed), and — in DLV-FAIL-CLOSED — a dispatcher whose
// membership read fails.
//   DLV-NEWORDER / DLV-FLUSH / DLV-STUCK  each trigger pushes to the current dispatcher ONLY
//   DLV-REVOKED       the revoked dispatcher receives nothing, and its subscription (like the merchant's / driver's) is pruned
//   DLV-FAIL-CLOSED   an unreadable membership: no push, and the subscription is kept
//   DLV-REJECTED-SEND           a non-terminal send failure logs its line (asserted to EXECUTE): status + category only
//   DLV-REJECTED-LIST-READ-*    the staff_push list read rejects (its error message carries ids): each trigger's catch line EXECUTES
//                               (notifyStaffOnNewOrder / flushStaffPushQueue / sweepStuckOrders), with no id and no message
//   DLV-LOGS          no captured staff-push log line (fan-out, send, revocation, the three trigger catches) carries a uid or an order id
// Run: node staff-push-delivery.test.js
for (const k of ['FUNCTION_TARGET', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete process.env[k];
const assert = require('assert');
const WATCHDOG = setTimeout(() => { console.error('staff-push-delivery: FAILED — watchdog (20 s)'); process.exit(1); }, 20000);
const { makeHonestDb } = require('./_honest-rtdb-model');

// the send seam: index.js's `webpush` IS this module object
const sends = [];
const webpush = require('web-push');
let SEND_FAIL = null;   // a cell sets an error the send seam rejects with
webpush.sendNotification = async (sub) => { sends.push(sub.endpoint); if (SEND_FAIL) throw SEND_FAIL; return { statusCode: 201 }; };
let DB = null;
const dbMod = require('firebase-admin/database');
dbMod.getDatabase = () => DB;   // BEFORE index.js destructures it
const idx = require('./index.js');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const EP = (uid) => `https://push.example/${uid}`;
const SUB = (uid) => ({ subscription: { endpoint: EP(uid), keys: { p256dh: 'p', auth: 'a' } }, updated_at: 1 });
const UIDS = { disp: 'u_disp_current_00001', merch: 'u_merchant_acct_0001', drv: 'u_driver_acct_000001', revoked: 'u_disp_revoked_00001' };
const OID = 'XPZ-ORDER-SECRET-77';
const world = (extra = {}) => ({
  dispatchers: { [UIDS.disp]: true },                                    // the revoked dispatcher's entry is already removed
  staff_push: { [UIDS.disp]: SUB(UIDS.disp), [UIDS.merch]: SUB(UIDS.merch), [UIDS.drv]: SUB(UIDS.drv), [UIDS.revoked]: SUB(UIDS.revoked) },
  config: { push: { coalesce_window_ms: 60000 } },
  ...extra,
});
const read = async (p) => (await DB.ref(p).once('value')).val();
const snap = (v) => ({ val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v != null });
const capture = () => { const out = []; const o = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { out.push(a.map(String).join(' ')); };
  return { out, done: () => Object.assign(console, o) }; };
const ALL_LOGS = [];
async function run(fn) { sends.length = 0; const c = capture(); try { await fn(); } finally { c.done(); ALL_LOGS.push(...c.out); } return [...sends]; }

(async () => {
  assert.strictEqual(typeof idx.notifyStaffOnNewOrder.run, 'function', 'premise: the real triggers');
  await cell('DLV-NEWORDER: an order turning live pushes to the current dispatcher ONLY', async (L) => {
    DB = makeHonestDb(world());
    const after = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', display_number: 7, created_at: Date.now() };
    const got = await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(after) }, params: { orderId: OID } }));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
  });
  await cell('DLV-FLUSH: the grouped follow-up pushes to the current dispatcher ONLY', async (L) => {
    DB = makeHonestDb(world({ staff_push_state: { last_sent_at: 1, pending: { x_pizza: 2, la_musa: 1, ids: ['a', 'b', 'c'] } } }));
    const got = await run(() => idx.flushStaffPushQueue.run({}));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
  });
  await cell('DLV-STUCK: a stuck-order alert pushes to the current dispatcher ONLY', async (L) => {
    DB = makeHonestDb(world({ orders: { [OID]: { status: 'ready', order_type: 'delivery', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() - 3600000 } } }));
    const got = await run(() => idx.sweepStuckOrders.run({}));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
  });
  await cell('DLV-REVOKED: the revoked dispatcher receives nothing; its (and the merchant\'s / driver\'s) subscription is pruned', async (L) => {
    DB = makeHonestDb(world());
    const after = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() };
    const got = await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(after) }, params: { orderId: OID } }));
    assert.ok(!got.includes(EP(UIDS.revoked)), `🔴 ${L}: the revoked dispatcher was pushed`);
    assert.deepStrictEqual(Object.keys((await read('staff_push')) || {}).sort(), [UIDS.disp], `🔴 ${L}: only the current dispatcher's subscription remains`);
  });
  await cell('DLV-FAIL-CLOSED: an unreadable membership check — no push, subscription kept', async (L) => {
    DB = makeHonestDb(world({ dispatchers: { [UIDS.disp]: true, [UIDS.revoked]: true } }), { beforeRead: async (p) => { if (p === `dispatchers/${UIDS.revoked}`) throw new Error('unavailable'); } });
    const after = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() };
    const got = await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(after) }, params: { orderId: OID } }));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
    assert.deepStrictEqual(await read(`staff_push/${UIDS.revoked}`), SUB(UIDS.revoked), `🔴 ${L}: an unknown is never deleted`);
  });
  const live = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() };
  const lines = (from) => ALL_LOGS.slice(from);
  await cell('DLV-REJECTED-SEND: a non-terminal send failure logs its line — status + category only', async (L) => {
    DB = makeHonestDb(world()); SEND_FAIL = Object.assign(new Error(`push failed for ${UIDS.disp} ${OID}`), { statusCode: 500 }); const from = ALL_LOGS.length;
    try { await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(live) }, params: { orderId: OID } })); } finally { SEND_FAIL = null; }
    assert.ok(lines(from).includes('sendStaffPush: failed status=500 (neworder)'), `🔴 ${L}: the failed-send line executed, redacted (${JSON.stringify(lines(from))})`);
  });
  const listReadFails = (extra = {}) => makeHonestDb(world(extra), { beforeRead: async (p) => { if (p === 'staff_push') throw Object.assign(new Error(`read failed at /staff_push for ${UIDS.disp} order ${OID}`), { code: 'unavailable' }); } });
  await cell('DLV-REJECTED-LIST-READ-NEW: notifyStaffOnNewOrder\'s catch line executes, with no id and no message', async (L) => {
    DB = listReadFails(); const from = ALL_LOGS.length;
    await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(live) }, params: { orderId: OID } }));
    assert.ok(lines(from).includes('notifyStaffOnNewOrder: fanout failed unavailable'), `🔴 ${L}: ${JSON.stringify(lines(from))}`);
  });
  await cell('DLV-REJECTED-LIST-READ-FLUSH: flushStaffPushQueue\'s catch line executes, with no message', async (L) => {
    DB = listReadFails({ staff_push_state: { last_sent_at: 1, pending: { x_pizza: 1, la_musa: 0, ids: ['a'] } } }); const from = ALL_LOGS.length;
    await run(() => idx.flushStaffPushQueue.run({}));
    assert.ok(lines(from).includes('flushStaffPushQueue: fanout failed unavailable'), `🔴 ${L}: ${JSON.stringify(lines(from))}`);
  });
  await cell('DLV-REJECTED-LIST-READ-STUCK: sweepStuckOrders\'s catch line executes, with no id and no message', async (L) => {
    DB = listReadFails({ orders: { [OID]: { status: 'ready', order_type: 'delivery', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() - 3600000 } } }); const from = ALL_LOGS.length;
    await run(() => idx.sweepStuckOrders.run({}));
    assert.ok(lines(from).includes('sweepStuckOrders: fanout failed unavailable'), `🔴 ${L}: ${JSON.stringify(lines(from))}`);
  });
  await cell('DLV-LOGS: no fan-out / send / revocation log line carries a uid or an order id', async (L) => {
    const lines = ALL_LOGS.filter((l) => /fanoutStaffPush|sendStaffPush|staff_push_revoked|notifyStaffOnNewOrder|flushStaffPushQueue|sweepStuckOrders/.test(l));
    assert.ok(lines.some((l) => /fanoutStaffPush: 1\/1 sent \(neworder\)/.test(l)) && lines.some((l) => /fanoutStaffPush: 1\/1 sent \(stuck\)/.test(l)), `${L}: premise, the fan-out logged (${JSON.stringify(lines)})`);
    assert.ok(lines.length >= 8, `${L}: premise, every staff-push line family was captured (${lines.length})`);
    const leak = lines.filter((l) => Object.values(UIDS).some((u) => l.includes(u)) || l.includes(OID));
    assert.deepStrictEqual(leak, [], `🔴 ${L}`);
  });
  clearTimeout(WATCHDOG);
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`staff-push-delivery: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
