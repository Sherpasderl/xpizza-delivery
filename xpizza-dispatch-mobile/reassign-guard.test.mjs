import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canReassign, isPostPickup, isUnassignedDelivery, sectionForOrder } from './board-model.js';

// «Reasignar» post-pickup phase guard. reassignOrder reset BOTH tasks to `assigned` with no phase check,
// so reassigning an order whose pickup was already COMPLETED rewrote the completed pickup → corruption.
// The SDK (xpizza-delivery.js) imports firebase from a CDN, so it can't be imported in node --test; this
// EXTRACTS the real reassignOrder + pickupComplete bodies and runs them over an in-memory RTDB stub. The
// completed-pickup fixture is produced by the REAL pickupComplete writer, not hand-built.

const here = dirname(fileURLToPath(import.meta.url));
const sdk = readFileSync(join(here, '..', 'xpizza-dispatch', 'xpizza-delivery.js'), 'utf8');

const sliceFn = (sig) => { const s = sdk.indexOf(sig); assert.ok(s > -1, `${sig} present`); return sdk.slice(s, sdk.indexOf('\n}', s) + 2); };
const sliceObj = (sig) => { const s = sdk.indexOf(sig); assert.ok(s > -1, `${sig} present`); return sdk.slice(s, sdk.indexOf('\n};', s) + 3); };
const sliceLine = (sig) => { const s = sdk.indexOf(sig); assert.ok(s > -1, `${sig} present`); return sdk.slice(s, sdk.indexOf('\n', s)); };

const SRC = [
  sliceObj('export const DRIVER_STATUS = {'),
  sliceObj('export const TASK_STATUS = {'),
  sliceObj('export const TASK_TYPE = {'),
  sliceObj('export const ORDER_STATUS = {'),
  sliceLine('export const ACCEPT_TIMEOUT_MS ='),
  sliceFn('function casAssign(expected, target) {'),
  sliceFn('export async function reassignOrder('),
  sliceFn('export async function pickupComplete('),
  'return { reassignOrder, pickupComplete };',
].join('\n').replace(/export /g, '');   // strip `export` so they are plain locals in the Function scope

// ── in-memory RTDB stub: ref/get/runTransaction/update/serverTimestamp ───────
const SVT = 1_700_000_100_000;   // serverTimestamp marker (finite)
function makeApp(seed) {
  const root = structuredClone(seed);
  const getP = (p) => (p ? p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), root) : root);
  const setP = (p, v) => { const ks = p.split('/').filter(Boolean); let o = root; for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] ??= {}; o = o[ks[i]]; } const last = ks[ks.length - 1]; if (v === null) delete o[last]; else o[last] = v; };
  const db = {};
  const ref = (_db, p = '') => ({ _p: p });
  const get = async (r) => ({ val: () => { const v = getP(r._p); return v === undefined ? null : v; } });
  const runTransaction = async (r, fn) => { const cur = getP(r._p); const c = cur === undefined ? null : cur; const res = fn(c); if (res === undefined) return { committed: false, snapshot: { val: () => c } }; setP(r._p, res); return { committed: true, snapshot: { val: () => res } }; };
  const update = async (r, obj) => { const base = r._p; for (const [k, v] of Object.entries(obj)) setP(base ? `${base}/${k}` : k, v); };
  const serverTimestamp = () => SVT;
  // eslint-disable-next-line no-new-func
  const api = new Function('db', 'ref', 'get', 'runTransaction', 'update', 'serverTimestamp', SRC)(db, ref, get, runTransaction, update, serverTimestamp);
  return { ...api, root, snapshot: () => structuredClone(root) };
}

// A delivery order assigned+accepted by one driver, pre-pickup. `pstatus` controls the pickup phase.
const seedOrder = (oid, driver, pstatus = 'accepted') => ({
  [`${oid}_pickup`]: { type: 'pickup', status: pstatus, assigned_driver_id: driver, linked_task_id: `${oid}_delivery`, order_id: oid, restaurant_hub: 'x' },
  [`${oid}_delivery`]: { type: 'delivery', status: pstatus, assigned_driver_id: driver, linked_task_id: `${oid}_pickup`, order_id: oid },
});
const baseSeed = () => ({
  orders: { o1: { order_id: 'o1', order_type: 'delivery', status: 'preparing', restaurant_id: 'x', total: 100, created_at: 1 } },
  tasks: { ...seedOrder('o1', 'd1') },
  drivers: { d1: { name: 'Uno', status: 'en_route_delivery', current_task_id: 'o1_delivery' }, d2: { name: 'Dos', status: 'available' } },
});

// ── pre-pickup: reassign works, BOTH legs reset for fresh acceptance ─────────
test('pre-pickup order: reassign succeeds and resets both legs to assigned (fresh acceptance)', async () => {
  for (const pstatus of ['assigned', 'accepted', 'in_progress']) {
    const app = makeApp({ ...baseSeed(), tasks: { ...seedOrder('o1', 'd1', pstatus) } });
    const res = await app.reassignOrder('o1', 'd2', 'd1');
    assert.deepEqual(res, { ok: true }, `[${pstatus}] reassign ok`);
    const t = app.root.tasks;
    assert.equal(t.o1_pickup.assigned_driver_id, 'd2', `[${pstatus}] pickup → d2`);
    assert.equal(t.o1_delivery.assigned_driver_id, 'd2', `[${pstatus}] delivery → d2`);
    assert.equal(t.o1_pickup.status, 'assigned', `[${pstatus}] pickup reset to assigned`);
    assert.equal(t.o1_delivery.status, 'assigned', `[${pstatus}] delivery reset to assigned`);
    assert.ok(t.o1_pickup.accepted_at == null, `[${pstatus}] pickup accepted_at cleared (RTDB drops null)`);
    assert.equal(t.o1_pickup.restaurant_hub, 'x', `[${pstatus}] restaurant/hub field preserved`);
  }
});

test('an at_restaurant driver is still reassignable (gate the order phase, not the driver status)', async () => {
  const app = makeApp({ ...baseSeed(), drivers: { d1: { status: 'at_restaurant', current_task_id: 'o1_delivery' }, d2: { status: 'available' } } });
  assert.deepEqual(await app.reassignOrder('o1', 'd2', 'd1'), { ok: true });
});

// ── the fix: a REAL completed pickup refuses, with ZERO writes ───────────────
test('post-pickup (via the REAL pickupComplete writer): reassign refuses picked_up and writes nothing', async () => {
  const app = makeApp(baseSeed());
  await app.pickupComplete('d1', 'o1_pickup');          // the real writer: pickup→completed, order→out_for_delivery, picked_up_at
  assert.equal(app.root.tasks.o1_pickup.status, 'completed', 'writer completed the pickup');
  assert.equal(app.root.orders.o1.status, 'out_for_delivery', 'writer set out_for_delivery');
  assert.ok(Number.isFinite(app.root.orders.o1.picked_up_at), 'writer stamped picked_up_at');

  const before = app.snapshot();
  const res = await app.reassignOrder('o1', 'd2', 'd1');
  assert.deepEqual(res, { ok: false, reason: 'picked_up' }, 'refused with picked_up');
  assert.deepEqual(app.snapshot(), before, 'order + tasks + drivers byte-unchanged on refusal');
});

test('refusal fires on EACH signal independently (pickup completed / out_for_delivery / picked_up_at)', async () => {
  // pickup completed only
  let app = makeApp({ ...baseSeed(), tasks: { ...seedOrder('o1', 'd1'), o1_pickup: { ...seedOrder('o1', 'd1').o1_pickup, status: 'completed' } } });
  assert.equal((await app.reassignOrder('o1', 'd2', 'd1')).reason, 'picked_up', 'pickup completed → refuse');
  // out_for_delivery only (the corrupted shape: pickup reset to assigned while order stayed out_for_delivery)
  app = makeApp({ ...baseSeed(), orders: { o1: { order_id: 'o1', order_type: 'delivery', status: 'out_for_delivery', restaurant_id: 'x', total: 100 } } });
  assert.equal((await app.reassignOrder('o1', 'd2', 'd1')).reason, 'picked_up', 'out_for_delivery → refuse');
  // picked_up_at only
  app = makeApp({ ...baseSeed(), orders: { o1: { order_id: 'o1', order_type: 'delivery', status: 'preparing', picked_up_at: SVT, restaurant_id: 'x', total: 100 } } });
  assert.equal((await app.reassignOrder('o1', 'd2', 'd1')).reason, 'picked_up', 'picked_up_at → refuse');
});

// ── stacked siblings through the real writer; unrelated orders/pointers intact ─
test('stacked sibling completed by the real writer also refuses; unrelated order + foreign pointer untouched', async () => {
  const seed = {
    orders: {
      o1: { order_id: 'o1', order_type: 'delivery', status: 'preparing', restaurant_id: 'x', total: 100 },
      o2: { order_id: 'o2', order_type: 'delivery', status: 'preparing', restaurant_id: 'x', total: 50 },
      o3: { order_id: 'o3', order_type: 'delivery', status: 'preparing', restaurant_id: 'y', total: 70 },
    },
    tasks: { ...seedOrder('o1', 'd1'), ...seedOrder('o2', 'd1'), ...seedOrder('o3', 'd3') },
    drivers: { d1: { status: 'en_route_delivery', current_task_id: 'o1_delivery' }, d2: { status: 'available' }, d3: { status: 'en_route_delivery', current_task_id: 'o3_delivery' } },
  };
  const app = makeApp(seed);
  await app.pickupComplete('d1', 'o1_pickup');          // real writer also completes the stacked o2 pickup
  assert.equal(app.root.tasks.o2_pickup.status, 'completed', 'the real writer completed the stacked sibling pickup');

  const o3Before = structuredClone(app.root.tasks.o3_delivery);
  const d3Before = structuredClone(app.root.drivers.d3);
  assert.equal((await app.reassignOrder('o2', 'd2', 'd1')).reason, 'picked_up', 'the stacked sibling now refuses too');
  assert.deepEqual(app.root.tasks.o3_delivery, o3Before, 'unrelated order o3 untouched');
  assert.deepEqual(app.root.drivers.d3, d3Before, 'a driver pointer naming another order untouched');
});

test('cross-hub: a driver en_route on one order can still be reassigned on a DIFFERENT pre-pickup order', async () => {
  const seed = {
    orders: { o1: { order_id: 'o1', order_type: 'delivery', status: 'out_for_delivery', restaurant_id: 'x', total: 100 }, o4: { order_id: 'o4', order_type: 'delivery', status: 'preparing', restaurant_id: 'y', total: 60 } },
    tasks: { ...seedOrder('o1', 'd1', 'completed'), ...seedOrder('o4', 'd1') },
    drivers: { d1: { status: 'en_route_delivery', current_task_id: 'o1_delivery' }, d2: { status: 'available' } },
  };
  const app = makeApp(seed);
  assert.equal((await app.reassignOrder('o1', 'd2', 'd1')).reason, 'picked_up', 'the post-pickup order refuses');
  assert.deepEqual(await app.reassignOrder('o4', 'd2', 'd1'), { ok: true }, 'the pre-pickup cross-hub order still reassigns');
});

// ── CAS / rollback / stale-claim preserved ───────────────────────────────────
test('a stale expectedFromDriver aborts with no write (CAS preserved)', async () => {
  const app = makeApp(baseSeed());
  const before = app.snapshot();
  const res = await app.reassignOrder('o1', 'd2', 'dX');   // the order moved away from dX already
  assert.deepEqual(res, { ok: false, reason: 'already_assigned' }, 'CAS aborts on a stale captured driver');
  assert.deepEqual(app.snapshot(), before, 'no write on a failed claim');
});

test('stale-claim (≥90 s since claim) rolls the delivery CAS back to the old driver', async () => {
  const app = makeApp(baseSeed());
  const realNow = Date.now;
  let n = 0;
  // claimTime read first, the stale check second → make the second read 91 s later.
  Date.now = () => (n++ === 0 ? 1_000_000 : 1_000_000 + 91_000);
  try {
    const res = await app.reassignOrder('o1', 'd2', 'd1');
    assert.deepEqual(res, { ok: false, reason: 'claim_stale' }, 'stale claim refused');
    assert.equal(app.root.tasks.o1_delivery.assigned_driver_id, 'd1', 'delivery CAS rolled back to the old driver');
    assert.equal(app.root.tasks.o1_pickup.status, 'accepted', 'pickup never touched (reset block not reached)');
  } finally { Date.now = realNow; }
});

// ── board-model: narrow ONLY canReassign; classification/visibility unchanged ─
test('canReassign hides the action post-pickup while the order stays visible & classified', () => {
  const tasks = { o1_delivery: { assigned_driver_id: 'd1', status: 'accepted' }, o1_pickup: { status: 'completed' } };
  const order = { order_type: 'delivery', status: 'out_for_delivery' };
  assert.equal(isPostPickup(order, 'o1', tasks), true, 'isPostPickup true for a completed-pickup order');
  assert.equal(canReassign(order, 'o1', tasks), false, 'canReassign is FALSE post-pickup (action hidden)');
  // Classification/visibility must be UNCHANGED: the order is an assigned live delivery, still on the board.
  assert.equal(isUnassignedDelivery(order, 'o1', tasks), false, 'still not "sin asignar" (has a driver) — classification unchanged');
  assert.ok(sectionForOrder(order), 'still maps to a live section — stays visible on the board');

  // A pre-pickup assigned order is still reassignable.
  const pre = { order_type: 'delivery', status: 'preparing' };
  const preTasks = { o2_delivery: { assigned_driver_id: 'd1', status: 'accepted' }, o2_pickup: { status: 'accepted' } };
  assert.equal(isPostPickup(pre, 'o2', preTasks), false);
  assert.equal(canReassign(pre, 'o2', preTasks), true, 'pre-pickup assigned order stays reassignable');
});
