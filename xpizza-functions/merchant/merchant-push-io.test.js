'use strict';
// H1c-server — the I/O half against the in-memory fake DB and a recording messaging stub (PLAN-H1c r3/r4 server tests).
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const IO = require('./merchant-push-io');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const T0 = 1_700_000_000_000;
const EP = 'epoch_abcdefghij0123'; const EP2 = 'epoch_ZYXWVUTSRQ9876';
const resolveBrand = async (_db, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');
const dev = (uid = 'hh_n1', rid = 'tb_norte') => ({ uid, token: { handheld: true, rid } });
const rejectsCode = (p, c) => assert.rejects(p, (e) => e.code === c);
const order = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', created_at: T0 - 5000, ...over });
const world = (over = {}) => ({
  restaurants: {
    tb_norte: { order_surface: 'handheld', handhelds: { hh_n1: { kind: 'handheld', revoked: false }, hh_n2: { kind: 'handheld', revoked: false } } },
    tb_centro: { order_surface: 'kds', handhelds: { hh_c1: { kind: 'handheld', revoked: false, fcm_token: 'TC', push_epoch: EP } } },
  },
  orders: { o1: order('o1'), o2: order('o2'), ok: order('ok', { restaurant_id: 'tb_centro' }), ol: order('ol', { routing_reason: undefined }) },
  ...over,
});
function messaging(fail = {}) {
  const sent = [];
  return { sent, sendEach: async (msgs) => { sent.push(...msgs); return { responses: msgs.map((m) => (fail[m.token] ? { success: false, error: { code: fail[m.token] } } : { success: true })) }; } };
}
const deps = (db, extra = {}) => ({ db, resolveBrand, HttpsError, now: () => T0, messaging: messaging(), queryLocationOrders: async (d, rid) => {
  const all = (await d.ref('orders').once('value')).val() || {};
  return Object.fromEntries(Object.entries(all).filter(([, o]) => o && o.restaurant_id === rid));
}, ...extra });
const ev = (oid, before, after, time = T0) => ({ params: { orderId: oid }, time: new Date(time).toISOString(), data: { before: { val: () => before }, after: { val: () => after } } });

test('S1 register: device-auth refusals (anonymous, human, revoked, wrong rid, forged uid) and bad payloads', async () => {
  const db = createFakeDb(world());
  const d = deps(db);
  await rejectsCode(IO.registerPush(d, null, { rid: 'tb_norte', token: 'T', epoch: EP }), 'unauthenticated');
  await rejectsCode(IO.registerPush(d, { uid: 'human', token: {} }, { rid: 'tb_norte', token: 'T', epoch: EP }), 'permission-denied');
  await rejectsCode(IO.registerPush(d, dev('hh_n1', 'tb_centro'), { rid: 'tb_norte', token: 'T', epoch: EP }), 'permission-denied', 'claim rid ≠ rid');
  await rejectsCode(IO.registerPush(d, dev('hh_forged'), { rid: 'tb_norte', token: 'T', epoch: EP }), 'permission-denied', 'unregistered uid');
  db.put('restaurants/tb_norte/handhelds/hh_n2/revoked', true);
  await rejectsCode(IO.registerPush(d, dev('hh_n2'), { rid: 'tb_norte', token: 'T', epoch: EP }), 'permission-denied', 'revoked');
  for (const bad of [{ rid: 'tb_norte', token: 'a b', epoch: EP }, { rid: 'tb_norte', token: 'T', epoch: 'short' }, { rid: 'tb_norte', token: 'T', epoch: EP, uid: 'x' }]) {
    await rejectsCode(IO.registerPush(d, dev(), bad), 'invalid-argument');
  }
});

test('S1 register: writes the row + index and returns the hash; re-pair MOVES ownership (compare-and-clear of the old row)', async () => {
  const db = createFakeDb(world());
  const r = await IO.registerPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', token: 'TOK1', epoch: EP });
  assert.deepStrictEqual(r, { ok: true, registered_token_hash: IO.sha('TOK1') });
  assert.deepStrictEqual([db.get('restaurants/tb_norte/handhelds/hh_n1/fcm_token'), db.get('restaurants/tb_norte/handhelds/hh_n1/push_epoch')], ['TOK1', EP]);
  assert.deepStrictEqual(db.get(`merchant_push_tokens/${IO.sha('TOK1')}`), { rid: 'tb_norte', uid: 'hh_n1' });
  // the same installation re-paired as hh_n2: the token moves; hh_n1 no longer holds it
  await IO.registerPush(deps(db), dev('hh_n2'), { rid: 'tb_norte', token: 'TOK1', epoch: EP2 });
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n1/fcm_token'), null);
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n2/fcm_token'), 'TOK1');
  assert.deepStrictEqual(db.get(`merchant_push_tokens/${IO.sha('TOK1')}`), { rid: 'tb_norte', uid: 'hh_n2' });
  // the old owner had ALREADY switched to another token: compare-and-clear leaves it alone
  await IO.registerPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', token: 'TOK9', epoch: EP });
  await IO.registerPush(deps(db), dev('hh_n2'), { rid: 'tb_norte', token: 'TOK9', epoch: EP2 });
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n1/fcm_token'), null);
});

test('S1 unregister: epoch-fenced — a stale cleanup never unregisters a newer pairing', async () => {
  const db = createFakeDb(world());
  await IO.registerPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', token: 'TOK1', epoch: EP2 });   // the NEW pairing's epoch
  assert.deepStrictEqual(await IO.unregisterPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', epoch: EP }), { ok: true, cleared: false });
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n1/fcm_token'), 'TOK1', 'the old epoch\'s cleanup touched nothing');
  assert.deepStrictEqual(await IO.unregisterPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', epoch: EP2 }), { ok: true, cleared: true });
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n1/fcm_token'), null);
  assert.strictEqual(db.get(`merchant_push_tokens/${IO.sha('TOK1')}`), null);
});

test('S1b reconcile: the fence is taken BEFORE the read; pending = new + unanswered + served here; at = log new_at, else created_at', async () => {
  const db = createFakeDb(world({ merchant_push_log: { o2: { new_at: T0 + 30 } } }));
  let clock = T0; const order_ = [];
  const d = deps(db, { now: () => { order_.push('now'); return clock; }, queryLocationOrders: async (x, rid) => { order_.push('read'); clock += 999; return deps(x).queryLocationOrders(x, rid); } });
  const r = await IO.pendingOrders(d, dev(), { rid: 'tb_norte' });
  assert.deepStrictEqual(order_, ['now', 'read'], 'fence first');
  assert.deepStrictEqual(r, { fence: T0, pending: [{ order_id: 'o1', at: T0 - 5000 }, { order_id: 'o2', at: T0 + 30 }] }, 'legacy (no routing) and the other location excluded');
  await rejectsCode(IO.pendingOrders(deps(db), dev('hh_n1', 'tb_centro'), { rid: 'tb_norte' }), 'permission-denied');
});

test('S2: intake → one data message per eligible device (at = event.time, the row epoch) + the push log; an answered order is suppressed', async () => {
  const db = createFakeDb(world());
  db.put('restaurants/tb_norte/handhelds/hh_n1/fcm_token', 'TA'); db.put('restaurants/tb_norte/handhelds/hh_n1/push_epoch', EP);
  db.put('restaurants/tb_norte/handhelds/hh_n2/fcm_token', 'TB'); db.put('restaurants/tb_norte/handhelds/hh_n2/push_epoch', EP2);
  const d = deps(db);
  const r = await IO.onStatusWritten(d, ev('o1', null, 'new', T0 + 7));
  assert.deepStrictEqual([r.type, r.sent], ['new_order', 2]);
  assert.deepStrictEqual(d.messaging.sent.map((m) => [m.token, m.data.type, m.data.at, m.data.epoch]), [['TA', 'new_order', String(T0 + 7), EP], ['TB', 'new_order', String(T0 + 7), EP2]]);
  assert.deepStrictEqual(db.get('merchant_push_log/o1'), { new_at: T0 + 7 });
  db.put('orders/o2/handheld_answered', { kind: 'rejected' });
  const d2 = deps(db);
  assert.deepStrictEqual(await IO.onStatusWritten(d2, ev('o2', null, 'new')), { skipped: 'not_pending' });
  assert.strictEqual(d2.messaging.sent.length, 0);
});

test('S3: accept (status + marker in one write) → exactly ONE resolved; a marker-only reject → resolved; deletion / unrelated → nothing', async () => {
  const db = createFakeDb(world({ merchant_push_log: { o1: { new_at: T0 } } }));
  db.put('restaurants/tb_norte/handhelds/hh_n1/fcm_token', 'TA'); db.put('restaurants/tb_norte/handhelds/hh_n1/push_epoch', EP);
  // accept: status new→preparing AND the marker, in one transaction
  db.put('orders/o1/status', 'preparing'); db.put('orders/o1/handheld_answered', { kind: 'accepted' });
  const d = deps(db);
  await IO.onStatusWritten(d, ev('o1', 'new', 'preparing', T0 + 50));
  await IO.onAnsweredWritten(d, ev('o1', null, { kind: 'accepted' }, T0 + 50));
  assert.deepStrictEqual(d.messaging.sent.map((m) => m.data.type), ['resolved'], 'ONE logical resolution');
  assert.strictEqual(db.get('merchant_push_log/o1'), null, 'the log entry resolved');
  // marker-only reject: status stays new
  db.put('orders/o2/handheld_answered', { kind: 'rejected' });
  const d2 = deps(db);
  assert.strictEqual((await IO.onAnsweredWritten(d2, ev('o2', null, { kind: 'rejected' }, T0 + 60))).type, 'resolved');
  assert.deepStrictEqual(d2.messaging.sent.map((m) => [m.data.type, m.data.order_id]), [['resolved', 'o2']]);
  const d3 = deps(db);
  assert.deepStrictEqual(await IO.onStatusWritten(d3, ev('o2', 'new', null)), { skipped: 'no_transition' }, 'deletion: no push');
  assert.deepStrictEqual(await IO.onStatusWritten(d3, ev('o1', 'preparing', 'ready')), { skipped: 'no_transition' });
  assert.strictEqual(d3.messaging.sent.length, 0);
});

test('S2/S3 guards: legacy (no routing), a KDS location, an absent/malformed surface, another location → ZERO sends AND ZERO writes', async () => {
  const snapshot = (db) => JSON.stringify(db.get(''));
  for (const [oid, setup] of [['ol', () => {}], ['ok', () => {}], ['o1', (db) => db.put('restaurants/tb_norte/order_surface', null)], ['o1', (db) => db.put('restaurants/tb_norte/order_surface', 'Handheld')]]) {
    const db = createFakeDb(world()); setup(db);
    db.put('restaurants/tb_norte/handhelds/hh_n1/fcm_token', 'TA'); db.put('restaurants/tb_norte/handhelds/hh_n1/push_epoch', EP);
    const before = snapshot(db); const d = deps(db);
    await IO.onStatusWritten(d, ev(oid, null, 'new'));
    await IO.onStatusWritten(d, ev(oid, 'new', 'preparing'));
    await IO.onAnsweredWritten(d, ev(oid, null, { kind: 'rejected' }));
    assert.strictEqual(d.messaging.sent.length, 0, `${oid}: no send`);
    assert.strictEqual(snapshot(db), before, `${oid}: no write`);
  }
});

test('codex r4: delayed handlers — S3@20 after S2@30 keeps the log; S2@10 after S2@30 does not overwrite', async () => {
  const db = createFakeDb(world());
  const d = deps(db);
  await IO.onStatusWritten(d, ev('o1', null, 'new', T0 + 30));
  db.put('orders/o1/status', 'preparing');
  await IO.onStatusWritten(d, ev('o1', 'new', 'preparing', T0 + 20));          // a delayed resolution OLDER than the re-entry
  assert.deepStrictEqual(db.get('merchant_push_log/o1'), { new_at: T0 + 30 }, 'kept');
  db.put('orders/o1/status', 'new');
  await IO.onStatusWritten(d, ev('o1', 'releasing', 'new', T0 + 10));         // a delayed S2@10
  assert.deepStrictEqual(db.get('merchant_push_log/o1'), { new_at: T0 + 30 }, 'not overwritten');
});

test('fan-out: a dead token is compare-and-cleared (+ its index); a transient failure and invalid-argument keep the token; partial failure', async () => {
  const db = createFakeDb(world());
  for (const [u, t] of [['hh_n1', 'DEAD'], ['hh_n2', 'TRANSIENT']]) { db.put(`restaurants/tb_norte/handhelds/${u}/fcm_token`, t); db.put(`restaurants/tb_norte/handhelds/${u}/push_epoch`, EP); }
  db.put(`merchant_push_tokens/${IO.sha('DEAD')}`, { rid: 'tb_norte', uid: 'hh_n1' });
  const m = messaging({ DEAD: 'messaging/registration-token-not-registered', TRANSIENT: 'messaging/internal-error' });
  const r = await IO.sendTo(deps(db, { messaging: m }), 'tb_norte', 'new_order', 'o1', T0);
  assert.deepStrictEqual(r, { sent: 0, failed: 2, cleared: 1 });
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n1/fcm_token'), null);
  assert.strictEqual(db.get(`merchant_push_tokens/${IO.sha('DEAD')}`), null);
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n2/fcm_token'), 'TRANSIENT');
  const m2 = messaging({ TRANSIENT: 'messaging/invalid-argument' });
  await IO.sendTo(deps(db, { messaging: m2 }), 'tb_norte', 'new_order', 'o1', T0);
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n2/fcm_token'), 'TRANSIENT', 'invalid-argument retained');
});

test('fan-out T1→T2 race: the row re-registered to T2 while the send to T1 failed dead → T2 is kept', async () => {
  const db = createFakeDb(world());
  db.put('restaurants/tb_norte/handhelds/hh_n1/fcm_token', 'T1'); db.put('restaurants/tb_norte/handhelds/hh_n1/push_epoch', EP);
  const m = { sendEach: async (msgs) => { db.put('restaurants/tb_norte/handhelds/hh_n1/fcm_token', 'T2'); return { responses: msgs.map(() => ({ success: false, error: { code: 'messaging/registration-token-not-registered' } })) }; } };
  const r = await IO.sendTo(deps(db, { messaging: m }), 'tb_norte', 'new_order', 'o1', T0);
  assert.strictEqual(r.cleared, 0);
  assert.strictEqual(db.get('restaurants/tb_norte/handhelds/hh_n1/fcm_token'), 'T2');
});
