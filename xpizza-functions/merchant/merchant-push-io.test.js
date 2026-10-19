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
let claims = 0;
const deps = (db, extra = {}) => ({ db, resolveBrand, HttpsError, now: () => T0, newClaim: () => C(1000 + ++claims), messaging: messaging(), queryLocationOrders: async (d, rid) => {
  const all = (await d.ref('orders').once('value')).val() || {};
  return Object.fromEntries(Object.entries(all).filter(([, o]) => o && o.restaurant_id === rid));
}, ...extra });
// a registration exactly as registerPush writes it: ONE index entry (rows carry no token)
const C = (n) => n.toString(16).padStart(24, '0');
function reg(db, uid, token, epoch, claimN = 1, rid = 'tb_norte', at = T0) {
  db.put(`merchant_push_tokens/${IO.sha(token)}`, { rid, uid, epoch, token, claim: C(claimN), at });
}
// a db whose transaction on ONE path first awaits `before()` (a controlled interleaving), then runs normally
const pauseTxn = (db, path, before) => ({ ...db, ref: (p) => { const r = db.ref(p); return p === path ? { ...r, transaction: async (f) => { await before(); return r.transaction(f); } } : r; } });
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

test('S1 register: ONE index entry {rid, uid, epoch, token, claim, at} (rows untouched) + the hash; a re-pair MOVES the token in that same write', async () => {
  const db = createFakeDb(world());
  const rowBefore = db.get('restaurants/tb_norte/handhelds/hh_n1');
  const r = await IO.registerPush(deps(db, { newClaim: () => C(7) }), dev('hh_n1'), { rid: 'tb_norte', token: 'TOK1', epoch: EP });
  assert.deepStrictEqual(r, { ok: true, registered_token_hash: IO.sha('TOK1') });
  assert.deepStrictEqual(db.get(`merchant_push_tokens/${IO.sha('TOK1')}`), { rid: 'tb_norte', uid: 'hh_n1', epoch: EP, token: 'TOK1', claim: C(7), at: T0 });
  assert.deepStrictEqual(db.get('restaurants/tb_norte/handhelds/hh_n1'), rowBefore, 'the row carries no token');
  await IO.registerPush(deps(db, { now: () => T0 + 1, newClaim: () => C(8) }), dev('hh_n2'), { rid: 'tb_norte', token: 'TOK1', epoch: EP2 });
  assert.deepStrictEqual(db.get(`merchant_push_tokens/${IO.sha('TOK1')}`), { rid: 'tb_norte', uid: 'hh_n2', epoch: EP2, token: 'TOK1', claim: C(8), at: T0 + 1 }, 'moved');
});
test('S1 unregister: removes this device\'s entries under THIS epoch only — another epoch, device or location is never touched', async () => {
  const db = createFakeDb(world());
  reg(db, 'hh_n1', 'TA', EP, 1); reg(db, 'hh_n1', 'TA_OLDTOKEN', EP, 2); reg(db, 'hh_n1', 'TNEW', EP2, 3); reg(db, 'hh_n2', 'TB', EP, 4);
  assert.deepStrictEqual(await IO.unregisterPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', epoch: EP }), { ok: true, cleared: true });
  assert.deepStrictEqual(['TA', 'TA_OLDTOKEN', 'TNEW', 'TB'].map((t) => !!db.get(`merchant_push_tokens/${IO.sha(t)}`)), [false, false, true, true]);
  assert.deepStrictEqual(await IO.unregisterPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', epoch: EP }), { ok: true, cleared: false }, 'idempotent');
  db.failReads.add('merchant_push_tokens');
  await rejectsCode(IO.unregisterPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', epoch: EP2 }), 'unavailable');
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
  reg(db, 'hh_n1', 'TA', EP);
  reg(db, 'hh_n2', 'TB', EP2);
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
  reg(db, 'hh_n1', 'TA', EP);
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
    reg(db, 'hh_n1', 'TA', EP);
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

test('fan-out: a dead token clears ITS registration; a transient failure and invalid-argument keep it; partial failure', async () => {
  const db = createFakeDb(world());
  reg(db, 'hh_n1', 'DEAD', EP, 1); reg(db, 'hh_n2', 'TRANSIENT', EP, 2);
  const m = messaging({ DEAD: 'messaging/registration-token-not-registered', TRANSIENT: 'messaging/internal-error' });
  const r = await IO.sendTo(deps(db, { messaging: m }), 'tb_norte', 'new_order', 'o1', T0);
  assert.deepStrictEqual(r, { sent: 0, failed: 2, cleared: 1 });
  assert.strictEqual(db.get(`merchant_push_tokens/${IO.sha('DEAD')}`), null);
  assert.ok(db.get(`merchant_push_tokens/${IO.sha('TRANSIENT')}`));
  await IO.sendTo(deps(db, { messaging: messaging({ TRANSIENT: 'messaging/invalid-argument' }) }), 'tb_norte', 'new_order', 'o1', T0);
  assert.ok(db.get(`merchant_push_tokens/${IO.sha('TRANSIENT')}`), 'invalid-argument retained');
});
test('fan-out targets: only this location\'s entries of registered, unrevoked rows; a revoked device stops receiving at once', async () => {
  const db = createFakeDb(world());
  reg(db, 'hh_n1', 'TA', EP, 1); reg(db, 'hh_n2', 'TB', EP2, 2); reg(db, 'hh_c1', 'TC', EP, 3, 'tb_centro'); reg(db, 'hh_ghost', 'TG', EP, 4);
  const d = deps(db);
  assert.strictEqual((await IO.sendTo(d, 'tb_norte', 'new_order', 'o1', T0)).sent, 2);
  assert.deepStrictEqual(d.messaging.sent.map((m) => [m.token, m.data.epoch]), [['TA', EP], ['TB', EP2]]);
  db.put('restaurants/tb_norte/handhelds/hh_n2/revoked', true);
  const d2 = deps(db);
  await IO.sendTo(d2, 'tb_norte', 'new_order', 'o1', T0);
  assert.deepStrictEqual(d2.messaging.sent.map((m) => m.token), ['TA']);
});
test('codex r2 P1-2: a STALE request (began first, paused) landing after a newer one → aborted, never overwriting it; the newer one keeps receiving', async () => {
  const db = createFakeDb(world());
  let release; const gate = new Promise((r) => { release = r; }); let paused; const atGate = new Promise((r) => { paused = r; });
  const dbA = pauseTxn(db, `merchant_push_tokens/${IO.sha('T')}`, async () => { paused(); await gate; });
  const a = IO.registerPush(deps(dbA, { now: () => T0 }), dev('hh_n1'), { rid: 'tb_norte', token: 'T', epoch: EP });   // began at T0
  await atGate;
  assert.strictEqual((await IO.registerPush(deps(db, { now: () => T0 + 5 }), dev('hh_n1'), { rid: 'tb_norte', token: 'T', epoch: EP2 })).ok, true);   // same row
  release();
  await rejectsCode(a, 'aborted');
  assert.deepStrictEqual([db.get(`merchant_push_tokens/${IO.sha('T')}`).epoch, db.get(`merchant_push_tokens/${IO.sha('T')}`).at], [EP2, T0 + 5], 'the newer registration stands');
  const d = deps(db);
  await IO.sendTo(d, 'tb_norte', 'new_order', 'o1', T0);
  assert.deepStrictEqual(d.messaging.sent.map((m) => [m.token, m.data.epoch]), [['T', EP2]]);
});
test('codex r2 P1-1: unregister → re-register the SAME token/uid → the delayed old dead-token cleanup and the old unregister are no-ops', async () => {
  const db = createFakeDb(world());
  await IO.registerPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', token: 'T', epoch: EP });
  const e1 = db.get(`merchant_push_tokens/${IO.sha('T')}`);
  // a send under E1 is in flight; meanwhile E1 unregisters and E2 re-registers the same token on the same row
  const m = { sendEach: async (msgs) => {
    await IO.unregisterPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', epoch: EP });
    assert.strictEqual(db.get(`merchant_push_tokens/${IO.sha('T')}`), null);
    await IO.registerPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', token: 'T', epoch: EP2 });
    return { responses: msgs.map(() => ({ success: false, error: { code: 'messaging/registration-token-not-registered' } })) };
  } };
  const r = await IO.sendTo(deps(db, { messaging: m }), 'tb_norte', 'new_order', 'o1', T0);
  assert.strictEqual(r.cleared, 0, 'E1\'s delayed dead-token response matches nothing');
  const e2 = db.get(`merchant_push_tokens/${IO.sha('T')}`);
  assert.ok(e2 && e2.epoch === EP2 && e2.claim !== e1.claim, 'E2 stands, under a new unique claim');
  assert.deepStrictEqual(await IO.unregisterPush(deps(db), dev('hh_n1'), { rid: 'tb_norte', epoch: EP }), { ok: true, cleared: false }, 'a late E1 unregister is a no-op');
  assert.ok(db.get(`merchant_push_tokens/${IO.sha('T')}`));
});
test('codex r1 P2-3: an unreadable push log fails the reconcile (unavailable); only an ABSENT entry falls back to created_at', async () => {
  const db = createFakeDb(world({ merchant_push_log: { o2: { new_at: T0 + 30 } } }));
  db.failReads.add('merchant_push_log/o2');
  await rejectsCode(IO.pendingOrders(deps(db), dev(), { rid: 'tb_norte' }), 'unavailable');
  db.failReads.clear();
  assert.deepStrictEqual((await IO.pendingOrders(deps(db), dev(), { rid: 'tb_norte' })).pending, [{ order_id: 'o1', at: T0 - 5000 }, { order_id: 'o2', at: T0 + 30 }]);
});

test('codex r1 P2-5: retained failures and a throwing send are logged with reason codes — never a token or its hash', async () => {
  const db = createFakeDb(world());
  reg(db, 'hh_n1', 'SECRET_TOKEN_A', EP); reg(db, 'hh_n2', 'SECRET_TOKEN_B', EP);
  const lines = []; const log = { warn: (l) => lines.push(l) };
  await IO.sendTo(deps(db, { log, messaging: messaging({ SECRET_TOKEN_A: 'messaging/invalid-argument', SECRET_TOKEN_B: 'messaging/internal-error' }) }), 'tb_norte', 'new_order', 'o1', T0);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), { event: 'merchant_push', reason: 'send_failed', rid: 'tb_norte', order_id: 'o1', type: 'new_order',
    codes: { 'messaging/invalid-argument': 1, 'messaging/internal-error': 1 }, retained: 2, cleared: 0 });
  const boom = { sendEach: async () => { throw Object.assign(new Error('quota'), { code: 'messaging/quota-exceeded' }); } };
  await assert.rejects(IO.sendTo(deps(db, { log, messaging: boom }), 'tb_norte', 'new_order', 'o1', T0), /quota/);
  assert.strictEqual(JSON.parse(lines[1]).reason, 'send_threw');
  assert.strictEqual(JSON.parse(lines[1]).code, 'messaging/quota-exceeded');
  db.failReads.add('merchant_push_tokens');
  await assert.rejects(IO.sendTo(deps(db, { log }), 'tb_norte', 'new_order', 'o1', T0));
  assert.strictEqual(JSON.parse(lines[2]).reason, 'targets_unreadable');
  for (const l of lines) assert.ok(!/SECRET_TOKEN/.test(l) && !l.includes(IO.sha('SECRET_TOKEN_A')) && !l.includes(IO.sha('SECRET_TOKEN_B')), 'no token / hash in a log line');
});
