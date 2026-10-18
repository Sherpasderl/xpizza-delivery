'use strict';
/**
 * H1a amendment A-R1 §2 (advisor ruling, P1-3) — the REAL automatic assigners skip an order a handheld rejected. The three
 * handlers are the deployed exports of index.js, invoked in-process through their own .run(event) against the RTDB
 * emulator (index.js is require-safe under the emulator, as test/public-menu.emulator.test.js relies on). Every held case
 * runs beside an identical CONTROL that IS assigned, so a skip caused by anything other than the hold fails the test.
 * Run: npm run test:merchant-assign-hold   (~70 s: the real 30 s grace and 60 s accept timers run)
 *   1. autoAssignOnOrderCreate: a reject landing during the grace window → no driver; the control order gets one.
 *   2. monitorAssignmentTimeout: a held order's first-strike timeout → takeover (released to SIN ASIGNAR + the
 *      no_response_takeover alert), never a reassign; the control is reassigned to another driver.
 *   3. sweepPendingOrders offer pass: a held order is never offered; the control is.
 *   4. the sweeper's FRESH re-check: an order that becomes held between the claim and the finalize is rolled back.
 *   5. codex r1 P1-2 — a reject landing AFTER the initial check (right after the assigner's delivery claim commits, via the REAL
 *      cancelOrderCore + stub PixelPay): autoAssign rolls back (cancelled and manual_review); the timeout reassign never gives
 *      the order to the next driver — a cancelled order keeps today's cancel end state, a manual_review order goes to SIN ASIGNAR.
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const fns = require('../index');
const { cancelOrderCore } = require('../cancel-order-core');
const { voidOrRefund } = require('../pixelpay-cancel');
const O = require('../merchant/merchant-orders');
const R = require('../merchant/merchant-reject');

const db = getDatabase();
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const NOW = Date.now();
// Third synthetic brand ('tb_'), never a production literal.
const order = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'delivery',
  recipient_name: 'Cliente', total: 100, created_at: NOW - 10 * 60000, ...over });
const rejected = (oid) => ({ kind: 'rejected', at: Date.now(), by: 'hh_a', op_id: `op_${oid}` });
const tasksFor = (oid, over = {}) => ({
  [`${oid}_pickup`]: { order_id: oid, type: 'pickup', status: 'pending', assigned_driver_id: null, ...over },
  [`${oid}_delivery`]: { order_id: oid, type: 'delivery', status: 'pending', assigned_driver_id: null, ...over },
});
const driver = (name) => ({ name, status: 'available', push_reachable: true, lat: 15.5, lng: -88.0, active: true });
const written = (before, after, ref) => ({ params: { orderId: ref, taskId: ref }, data: { before: { val: () => before }, after: { val: () => after } } });

// The claim-window hook: when an assigner's delivery CAS-claim COMMITS on a watched path, the test awaits a real reject before
// control returns to the assigner — deterministically inside the claim → finalize gap (one-shot per path).
const claimHooks = new Map();
(() => {
  let o = Object.getPrototypeOf(db.ref('x'));
  while (o && !Object.prototype.hasOwnProperty.call(o, 'transaction')) o = Object.getPrototypeOf(o);
  const orig = o.transaction;
  o.transaction = async function (...a) {
    const r = await orig.apply(this, a);
    const path = decodeURIComponent(new URL(this.toString()).pathname).replace(/^\//, '');
    const h = claimHooks.get(path);
    if (h && r && r.committed && r.snapshot && r.snapshot.val()) { claimHooks.delete(path); await h(); }
    return r;
  };
})();
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const stubCore = (args) => cancelOrderCore({ db, client: { voidTransaction: async () => ({ ok: true }) }, voidOrRefund, alert: async () => {}, serverTimestamp: Date.now() }, args);
let claimSeq = 0;
const realReject = (oid) => R.runReject({ db, resolveBrand: async (_d, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown'), HttpsError, now: () => Date.now(),
  cancelCore: stubCore, newClaimId: () => `claim_hold_${++claimSeq}` }, { uid: 'hh_a', token: { handheld: true, rid: 'tb_norte' } },
  { rid: 'tb_norte', oid, reason: 'saturada', gone_items: [], op_id: `op_${oid}_r1` }, O.runOrderActionDetailed);
const outcomes = {};
const hookClaim = (oid) => claimHooks.set(`tasks/${oid}_delivery/assigned_driver_id`, async () => { outcomes[oid] = (await realReject(oid)).state; });
const ambiguousCard = (oid) => ({ payment_method: 'online', payment_status: 'confirmed', active_attempt_id: `att_${oid}`, total_cents: 10000 });

(async () => {
  await db.ref().set({
    config: { auto_assign_enabled: true },
    drivers: { dA: driver('A'), dB: driver('B'), dM1: { ...driver('M1') }, dM2: { ...driver('M2') }, dE: driver('E'), dF: driver('F'),
      dM3: driver('M3'), dM4: driver('M4'), dG: driver('G'), dH: driver('H') },
    restaurants: { tb_norte: { order_surface: 'handheld', handhelds: { hh_a: { kind: 'handheld', revoked: false } } } },
    payment_attempts: { att_a2: { order_id: 'a2', hosted_order_id: 'a2-att_a2', hosted_state: 'paid' }, att_m4: { order_id: 'm4', hosted_order_id: 'm4-att_m4', hosted_state: 'paid' } },
    orders: {
      h1: order('h1'), c1: order('c1'),
      m1: order('m1', { handheld_answered: rejected('m1'), reject_intent: { op_id: 'op_m1', at: Date.now() } }), m2: order('m2'),
      a1: order('a1', { payment_method: 'cash' }), a2: order('a2', ambiguousCard('a2')),
      m3: order('m3', { payment_method: 'cash' }), m4: order('m4', ambiguousCard('m4')),
    },
    tasks: {
      ...tasksFor('h1'), ...tasksFor('c1'),
      ...tasksFor('m1', { status: 'assigned', assigned_driver_id: 'dM1', assignment_attempts: 1 }),
      ...tasksFor('m2', { status: 'assigned', assigned_driver_id: 'dM2', assignment_attempts: 1 }),
      ...tasksFor('a1'), ...tasksFor('a2'),
      ...tasksFor('m3', { status: 'assigned', assigned_driver_id: 'dM3', assignment_attempts: 1 }),
      ...tasksFor('m4', { status: 'assigned', assigned_driver_id: 'dM4', assignment_attempts: 1 }),
    },
  });

  // Phase 1 (parallel — the real timers run): autoAssign held + control, monitor held + control.
  const auto = (oid) => fns.autoAssignOnOrderCreate.run(written(null, { ...order(oid) }, oid));
  const mon = (oid, drv) => fns.monitorAssignmentTimeout.run(written(null, drv, `${oid}_pickup`));
  const lateReject = (async () => { await new Promise((r) => setTimeout(r, 1000)); await db.ref('orders/h1/handheld_answered').set(rejected('h1')); })();
  for (const oid of ['a1', 'a2', 'm3', 'm4']) hookClaim(oid);
  await Promise.all([auto('h1'), auto('c1'), mon('m1', 'dM1'), mon('m2', 'dM2'), lateReject, auto('a1'), auto('a2'), mon('m3', 'dM3'), mon('m4', 'dM4')]);

  assert.strictEqual(await val('tasks/h1_pickup/assigned_driver_id'), null, 'held h1 not auto-assigned');
  assert.strictEqual(await val('tasks/h1_delivery/assigned_driver_id'), null);
  const c1d = await val('tasks/c1_pickup/assigned_driver_id');
  assert.ok(c1d === 'dA' || c1d === 'dB', `control c1 auto-assigned (got ${c1d})`);
  ok(`autoAssignOnOrderCreate: a reject during the grace window → no driver; the control got ${c1d}`);

  assert.strictEqual(await val('tasks/m1_pickup/assigned_driver_id'), null, 'held m1 released to SIN ASIGNAR');
  assert.strictEqual(await val('tasks/m1_delivery/assigned_driver_id'), null);
  const alerts = Object.values((await val('dispatcher_alerts')) || {});
  assert.ok(alerts.some((a) => a.type === 'no_response_takeover' && a.order_id === 'm1'), 'takeover alert for m1');
  assert.ok(!alerts.some((a) => a.type === 'no_response_takeover' && a.order_id === 'm2'), 'no takeover for the control');
  const m2d = await val('tasks/m2_pickup/assigned_driver_id');
  assert.ok(m2d && m2d !== 'dM2', `control m2 reassigned to another driver (got ${m2d})`);
  ok(`monitorAssignmentTimeout: held m1 → takeover (released + alert), never reassigned; the control was reassigned to ${m2d}`);

  // 5. codex r1 P1-2 — rejects landing inside the claim → finalize gap
  assert.deepStrictEqual([outcomes.a1, outcomes.a2, outcomes.m3, outcomes.m4], ['cancelled', 'manual_review', 'cancelled', 'manual_review'], JSON.stringify(outcomes));
  for (const oid of ['a1', 'a2']) {
    assert.strictEqual(await val(`tasks/${oid}_delivery/assigned_driver_id`), null, `${oid}: the autoAssign claim rolled back`);
    assert.strictEqual(await val(`tasks/${oid}_pickup/assigned_driver_id`), null, `${oid}: the pickup was never finalized`);
  }
  assert.deepStrictEqual([(await val('orders/a1')).status, (await val('orders/a2')).status], ['cancelled', 'new']);
  ok('autoAssign: a reject inside the claim → finalize gap (cancelled AND manual_review, real core) → both tasks unassigned');
  const m3 = { d: await val('tasks/m3_delivery'), p: await val('tasks/m3_pickup') };
  assert.deepStrictEqual([m3.d.assigned_driver_id, m3.p.assigned_driver_id, m3.d.status, m3.p.status], ['dM3', 'dM3', 'cancelled', 'cancelled'],
    'm3 cancelled: never given to the next driver; the claim rolled back to today\'s cancel end state (no revival)');
  for (const t of ['delivery', 'pickup']) assert.strictEqual(await val(`tasks/m4_${t}/assigned_driver_id`), null, `m4 ${t}: released to SIN ASIGNAR`);
  const alerts2 = Object.values((await val('dispatcher_alerts')) || {});
  assert.ok(alerts2.some((a) => a.type === 'no_response_takeover' && a.order_id === 'm4'), 'm4 takeover alert');
  ok('timeout reassign: a reject inside the claim → finalize gap → never reassigned (cancelled keeps the cancel state; manual_review → SIN ASIGNAR + takeover)');

  // Phase 2: the sweeper offer pass (flag on). Fresh drivers; h2 held, c2 control, h3 becomes held mid-placement.
  await db.ref('drivers').update({ dC: driver('C'), dD: driver('D') });
  await db.ref('config/sweep_pending_enabled').set(true);
  await db.ref('orders').update({ h2: order('h2', { handheld_answered: rejected('h2') }), c2: order('c2'), h3: order('h3') });
  await db.ref('tasks').update({ ...tasksFor('h2'), ...tasksFor('c2'), ...tasksFor('h3') });
  const onClaim = db.ref('tasks/h3_delivery/assigned_driver_id');
  const flip = (snap) => { if (snap.val()) db.ref('orders/h3/handheld_answered').set(rejected('h3')); };
  onClaim.on('value', flip);
  await fns.sweepPendingOrders.run({});
  onClaim.off('value', flip);

  assert.strictEqual(await val('tasks/h2_delivery/assigned_driver_id'), null, 'held h2 never offered');
  assert.strictEqual(await val('tasks/h1_delivery/assigned_driver_id'), null, 'held h1 (from phase 1) still never offered');
  const c2d = await val('tasks/c2_delivery/assigned_driver_id');
  assert.ok(c2d === 'dC' || c2d === 'dD', `control c2 offered (got ${c2d})`);
  ok(`sweepPendingOrders offer pass: held orders skipped; the control was offered to ${c2d}`);

  const h3 = await val('orders/h3');
  assert.strictEqual(h3.handheld_answered && h3.handheld_answered.kind, 'rejected', 'h3 became held mid-placement (the flip ran)');
  assert.strictEqual(await val('tasks/h3_delivery/assigned_driver_id'), null, 'the fresh re-check rolled h3\'s claim back');
  assert.strictEqual(await val('tasks/h3_pickup/assigned_driver_id'), null);
  ok('sweepPendingOrders fresh re-check: an order held between claim and finalize is rolled back to SIN ASIGNAR');

  console.log(`\nmerchant-assign-hold: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('merchant-assign-hold FAILED:', e && e.stack || e); process.exit(1); });
