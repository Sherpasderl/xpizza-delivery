'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const M = require('./merchant-orders');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const T0 = 1_700_000_000_000;
const resolveBrand = async (_db, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');
const world = (over = {}) => ({
  restaurants: {
    tb_norte: { order_surface: 'handheld', handhelds: { hh_n1: { kind: 'handheld', revoked: false }, hh_n2: { kind: 'handheld', revoked: false } } },
    tb_centro: { handhelds: { hh_c1: { kind: 'handheld', revoked: false } } },
  },
  orders: { o1: { order_id: 'o1', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'delivery' } },
  tasks: { o1_delivery: { assigned_driver_id: null } },
  ...over,
});
const deps = (db, nowMs = T0) => ({ db, resolveBrand, now: () => nowMs, HttpsError });
const dev = (uid = 'hh_n1', rid = 'tb_norte') => ({ uid, token: { handheld: true, rid } });
const call = (db, action, data, auth = dev(), nowMs) => M.runOrderAction(deps(db, nowMs), auth, action, data);
const throwsCode = async (p, c) => assert.rejects(p, (e) => e.code === c);

test('accept commits; the same op replays the stored result; node unchanged on replay', async () => {
  const db = createFakeDb(world());
  const r = await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 23, op_id: 'op_acc00001' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status, 'preparing');
  const snap = JSON.stringify(db.get('orders/o1'));
  assert.deepStrictEqual(await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 23, op_id: 'op_acc00001' }), r);
  assert.strictEqual(JSON.stringify(db.get('orders/o1')), snap);
});

test('two devices accept the same order concurrently → exactly one wins', async () => {
  const db = createFakeDb(world());
  db.hooks.onTxn = async () => { await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 18, op_id: 'op_other001' }, dev('hh_n2')); };
  const mine = await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 25, op_id: 'op_mine0001' });
  assert.deepStrictEqual([mine.ok, mine.code], [false, 'stale_state']);
  assert.strictEqual(db.get('orders/o1/prep/committed_min'), 18);
});

test('accept racing a dispatcher cancel claim → no transition', async () => {
  const db = createFakeDb(world());
  db.hooks.onTxn = async () => { db.put('orders/o1/cancel_claim_id', 'cc1'); };
  const r = await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 18, op_id: 'op_acc00002' });
  assert.strictEqual(r.code, 'stale_state'); assert.strictEqual(db.get('orders/o1/status'), 'new');
});

test('más tiempo: lost response, then a driver is assigned, then replay → the ORIGINAL success (receipt before task read)', async () => {
  const db = createFakeDb(world());
  await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_acc00003' });
  const first = await call(db, 'more', { rid: 'tb_norte', oid: 'o1', add_min: 10, op_id: 'op_more0001' });
  assert.strictEqual(first.ok, true);
  db.put('tasks/o1_delivery/assigned_driver_id', 'drv_1');
  assert.deepStrictEqual(await call(db, 'more', { rid: 'tb_norte', oid: 'o1', add_min: 10, op_id: 'op_more0001' }), first);
  assert.strictEqual(db.get('orders/o1/prep/extra_min'), 10);
  assert.strictEqual((await call(db, 'more', { rid: 'tb_norte', oid: 'o1', add_min: 5, op_id: 'op_more0002' })).code, 'driver_assigned');
});

test('más tiempo fails CLOSED on a missing / malformed / unreadable delivery task; pickup has no driver gate', async () => {
  for (const mutate of [(db) => db.put('tasks/o1_delivery', null), (db) => db.put('tasks/o1_delivery', 'x'), (db) => db.failReads.add('tasks/o1_delivery')]) {
    const db = createFakeDb(world());
    await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_acc00004' });
    mutate(db);
    assert.strictEqual((await call(db, 'more', { rid: 'tb_norte', oid: 'o1', add_min: 5, op_id: 'op_more0003' })).code, 'driver_assigned');
  }
  const db = createFakeDb(world({ orders: { o1: { order_id: 'o1', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'pickup' } }, tasks: {} }));
  await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_acc00005' });
  assert.strictEqual((await call(db, 'more', { rid: 'tb_norte', oid: 'o1', add_min: 5, op_id: 'op_more0004' })).ok, true);
});

test('a copied op_id from another registered device → op_conflict', async () => {
  const db = createFakeDb(world());
  await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_shared01' });
  assert.strictEqual((await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_shared01' }, dev('hh_n2'))).code, 'op_conflict');
});

test('gates and scope: kds surface → not_enabled; A device on B → forbidden; legacy order → not_served; bad input refused', async () => {
  const db = createFakeDb(world());
  db.put('restaurants/tb_norte/order_surface', 'kds');
  await throwsCode(call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_g0000001' }), 'failed-precondition');
  const db2 = createFakeDb(world());
  db2.put('restaurants/tb_centro/order_surface', 'handheld');
  await throwsCode(call(db2, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_g0000002' }, dev('hh_c1', 'tb_centro')), 'permission-denied');
  assert.strictEqual((await call(db2, 'accept', { rid: 'tb_centro', oid: 'o1', prep_min: 20, op_id: 'op_g0000003' }, dev('hh_c1', 'tb_centro'))).code, 'not_served');
  const db3 = createFakeDb(world());
  db3.put('orders/o1/routing_reason', null);
  assert.strictEqual((await call(db3, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_g0000004' })).code, 'not_served');
  for (const bad of [{ prep_min: '20' }, { prep_min: null }, { prep_min: -0 }]) await throwsCode(call(db3, 'accept', { rid: 'tb_norte', oid: 'o1', op_id: 'op_g0000005', ...bad }), 'invalid-argument');
  await throwsCode(call(db3, 'reject', { rid: 'tb_norte', oid: 'o1', reason: 'otro', note: 'x'.repeat(141), op_id: 'op_g0000006' }), 'invalid-argument');
  await throwsCode(call(db3, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'bad id' }), 'invalid-argument');
});

test('with the brand in rollback (activation off) a served order still gets listo and entregado', async () => {
  const db = createFakeDb(world({ brands: { tb: { activation: { state: 'off' } } },
    orders: { o1: { order_id: 'o1', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'pickup' } } }));
  await call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 18, op_id: 'op_off00001' });
  assert.strictEqual((await call(db, 'ready', { rid: 'tb_norte', oid: 'o1', op_id: 'op_off00002' })).status, 'ready');
  assert.strictEqual((await call(db, 'handed', { rid: 'tb_norte', oid: 'o1', op_id: 'op_off00003' })).status, 'completed');
});

test('reject commits the intent + rejected marker on the order; status stays new (the cancel runs in merchant-reject)', async () => {
  const db = createFakeDb(world());
  const r = await call(db, 'reject', { rid: 'tb_norte', oid: 'o1', reason: 'agotado', gone_items: ['Pollo frito 3 piezas'], op_id: 'op_rej00001' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.get('orders/o1/reject_intent/op_id'), 'op_rej00001');
  assert.strictEqual(db.get('orders/o1/handheld_answered/kind'), 'rejected');
  assert.strictEqual(db.get('orders/o1/status'), 'new');
});

test('runOrderActionDetailed: fresh only for the call that committed; replay and abort are not fresh', async () => {
  const db = createFakeDb(world());
  const data = { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_fresh001' };
  assert.strictEqual((await M.runOrderActionDetailed(deps(db), dev(), 'accept', data)).fresh, true);
  assert.strictEqual((await M.runOrderActionDetailed(deps(db), dev(), 'accept', data)).fresh, false);
  const lost = await M.runOrderActionDetailed(deps(db), dev(), 'accept', { ...data, op_id: 'op_fresh002' });
  assert.deepStrictEqual([lost.fresh, lost.outcome.code], [false, 'stale_state']);
});

test('orderState carries the location prep base: valid → the value; invalid / unreadable → null (the device keeps its own)', async () => {
  const db = createFakeDb(world());
  db.put('restaurants/tb_norte/identity/prep_default_min', 22);
  assert.strictEqual((await M.orderState(deps(db), dev(), { rid: 'tb_norte', oid: 'o1' })).prep_default_min, 22);
  db.put('restaurants/tb_norte/identity/prep_default_min', 3);
  assert.strictEqual((await M.orderState(deps(db), dev(), { rid: 'tb_norte', oid: 'o1' })).prep_default_min, null);
  db.put('restaurants/tb_norte/identity/prep_default_min', 22);
  db.failReads.add('restaurants/tb_norte/identity');
  const r = await M.orderState(deps(db), dev(), { rid: 'tb_norte', oid: 'o1' });
  assert.deepStrictEqual([r.prep_default_min, typeof r.driver_assigned], [null, 'boolean'], 'an identity read failure never fails the call');
});

test('orderState driver fields: ONLY this order\'s open-pickup driver — first name, at-restaurant, fresh location; fail closed', async () => {
  const st = async (db) => { const r = await M.orderState(deps(db), dev(), { rid: 'tb_norte', oid: 'o1' }); return { first: r.driver_first_name, here: r.driver_at_restaurant, loc: r.driver_location }; };
  const setup = (pickup, driver) => { const db = createFakeDb(world()); db.put('tasks/o1_pickup', pickup); if (driver) db.put('drivers/drv', driver); return db; };
  const live = { name: '  Ana María López ', status: 'assigned', current_task_id: 'o1_pickup', lat: 15.5, lng: -88.02, last_ping: T0 - 30000, phone: '+504 9999' };
  // the happy path
  assert.deepStrictEqual(await st(setup({ assigned_driver_id: 'drv', status: 'assigned' }, live)), { first: 'Ana', here: false, loc: { lat: 15.5, lng: -88.02, at: T0 - 30000 } });
  assert.deepStrictEqual(await st(setup({ assigned_driver_id: 'drv', status: 'accepted' }, { ...live, status: 'at_restaurant' })), { first: 'Ana', here: true, loc: { lat: 15.5, lng: -88.02, at: T0 - 30000 } });
  const full = await M.orderState(deps(setup({ assigned_driver_id: 'drv', status: 'assigned' }, live)), dev(), { rid: 'tb_norte', oid: 'o1' });
  assert.ok(!JSON.stringify(full).includes('+504') && !('driver_id' in full), 'no phone, no driver id');
  // stale ping / future ping / no coords → no location (name stays)
  assert.deepStrictEqual(await st(setup({ assigned_driver_id: 'drv', status: 'assigned' }, { ...live, last_ping: T0 - 91000 })), { first: 'Ana', here: false, loc: null });
  assert.deepStrictEqual((await st(setup({ assigned_driver_id: 'drv', status: 'assigned' }, { ...live, last_ping: T0 + 60000 }))).loc, null);
  assert.deepStrictEqual((await st(setup({ assigned_driver_id: 'drv', status: 'assigned' }, { ...live, lat: 'x' }))).loc, null);
  // at_restaurant for ANOTHER order's task → false
  assert.strictEqual((await st(setup({ assigned_driver_id: 'drv', status: 'assigned' }, { ...live, status: 'at_restaurant', current_task_id: 'o9_pickup' }))).here, false);
  // pickup done / cancelled / unassigned → nothing at all
  for (const p of [{ assigned_driver_id: 'drv', status: 'completed' }, { assigned_driver_id: 'drv', status: 'cancelled' }, { assigned_driver_id: null, status: 'pending' }]) {
    assert.deepStrictEqual(await st(setup(p, live)), { first: null, here: false, loc: null }, JSON.stringify(p));
  }
  // driver read failure → fail closed
  const broken = setup({ assigned_driver_id: 'drv', status: 'assigned' }, live); broken.failReads.add('drivers/drv');
  assert.deepStrictEqual(await st(broken), { first: null, here: false, loc: null });
  // a pickup ORDER never exposes a driver
  const pk = setup({ assigned_driver_id: 'drv', status: 'assigned' }, live); pk.put('orders/o1/order_type', 'pickup');
  assert.deepStrictEqual(await st(pk), { first: null, here: false, loc: null });
});

test('unauthenticated → unauthenticated; revoked device → permission-denied', async () => {
  const db = createFakeDb(world());
  await throwsCode(call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_u0000001' }, null), 'unauthenticated');
  db.put('restaurants/tb_norte/handhelds/hh_n1/revoked', true);
  await throwsCode(call(db, 'accept', { rid: 'tb_norte', oid: 'o1', prep_min: 20, op_id: 'op_u0000002' }), 'permission-denied');
});

const NOD = { driver_first_name: null, driver_at_restaurant: false, driver_location: null };
test('orderState: driver presence, fail closed, served orders only', async () => {
  const db = createFakeDb(world());
  assert.deepStrictEqual(await M.orderState(deps(db), dev(), { rid: 'tb_norte', oid: 'o1' }), { driver_assigned: false, prep_default_min: null, ...NOD });
  db.put('tasks/o1_delivery/assigned_driver_id', 'drv');
  assert.deepStrictEqual(await M.orderState(deps(db), dev(), { rid: 'tb_norte', oid: 'o1' }), { driver_assigned: true, prep_default_min: null, ...NOD });
  db.failReads.add('tasks/o1_delivery');
  assert.deepStrictEqual(await M.orderState(deps(db), dev(), { rid: 'tb_norte', oid: 'o1' }), { driver_assigned: true, prep_default_min: null, ...NOD });
  const db2 = createFakeDb(world());
  db2.put('orders/o1/restaurant_id', 'tb_centro');
  await throwsCode(M.orderState(deps(db2), dev(), { rid: 'tb_norte', oid: 'o1' }), 'failed-precondition');
});
