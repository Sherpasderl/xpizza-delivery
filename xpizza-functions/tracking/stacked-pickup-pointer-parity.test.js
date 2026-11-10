'use strict';
// Tracker-parity guard for the #962 hotfix. Non-vacuous (Codex r1 P2): a SECOND order that is picked up and
// out_for_delivery (so it is the delivery-phase `first` and WOULD qualify as live) is present, and the pointer
// value alone decides live vs neutral. Proves: with the builder's promoted PICKUP pointer the live order reads
// NEUTRAL (not falsely live); moving ONLY the pointer to that delivery reads LIVE. Covers the OFF-path mirror
// predicate (activeDropOrderId rejects a pickup pointer). Real derive.js + real getDriverOrders + real builder.
const assert = require('node:assert/strict');
const { deriveOrderTracker } = require('./derive');
const { activeDropOrderId } = require('../tracking-mirror');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; }
}

const UID = 'elmer';
// Order B: stacked, pickup ACCEPTED (not completed), delivery accepted — the promoted-but-not-picked-up stop. Earliest.
const b_pickup   = { order_id: 'b', type: 'pickup',   status: 'accepted', assigned_driver_id: UID, created_at: 110, linked_task_id: 'b_delivery' };
const b_delivery = { order_id: 'b', type: 'delivery', status: 'accepted', assigned_driver_id: UID, created_at: 111, linked_task_id: 'b_pickup' };
// Order C: PICKED UP (pickup completed), delivery in_progress, out_for_delivery — a real delivery-phase order that
// would read `live` if the pointer named its delivery. This is the "second picked-up out_for_delivery order".
const c_pickup   = { order_id: 'c', type: 'pickup',   status: 'completed',   assigned_driver_id: UID, created_at: 120, linked_task_id: 'c_delivery' };
const c_delivery = { order_id: 'c', type: 'delivery', status: 'in_progress', assigned_driver_id: UID, created_at: 121, linked_task_id: 'c_pickup' };
const ownerTasks = { b_pickup, b_delivery, c_pickup, c_delivery };
const deriveC = (pointer) => deriveOrderTracker({
  orderId: 'c', order: { status: 'out_for_delivery' }, pickup: c_pickup, delivery: c_delivery,
  owner: { uid: UID, active: true, current_shift_id: 's', current_task_id: pointer }, ownerTasks,
});

(async () => {
  // Feed the BUILDER's real output: completing a prior delivery D promotes the earliest accepted delivery (B),
  // whose pickup is not completed (valid pair) → pointer = B's PICKUP.
  const { buildCompleteTaskUpdates } = await import('../../xpizza-driver/driver-complete.js');
  const d_delivery = { order_id: 'd', type: 'delivery', status: 'in_progress', assigned_driver_id: UID, created_at: 100, linked_task_id: 'd_pickup' };
  const builderOut = buildCompleteTaskUpdates({ driverId: UID, taskId: 'd_delivery', task: d_delivery, allTasks: { d_delivery, b_pickup, b_delivery, c_pickup, c_delivery }, now: 1000 });
  const promotedPointer = builderOut[`drivers/${UID}/current_task_id`];

  t('builder promotes B’s PICKUP (valid pair) as the pointer', () => {
    assert.equal(promotedPointer, 'b_pickup');
  });

  t('NON-VACUOUS: with the builder’s PICKUP pointer, the live-eligible order C reads NEUTRAL (not live)', () => {
    const r = deriveC(promotedPointer);
    assert.equal(r.mode, 'neutral', 'a pickup pointer must not make the picked-up out_for_delivery order live');
  });

  t('changing ONLY the pointer to C’s delivery → C reads LIVE (the fix suppresses nothing legitimate)', () => {
    const r = deriveC('c_delivery');
    assert.equal(r.mode, 'live');
  });

  t('OFF-path mirror predicate: activeDropOrderId rejects a pickup pointer, resolves a delivery pointer', () => {
    assert.equal(activeDropOrderId('b_pickup'), null, 'a pickup pointer names no active drop (OFF ingest writes no is_active_drop:true)');
    assert.equal(activeDropOrderId('c_delivery'), 'c', 'a delivery pointer resolves to its order');
  });

  console.log(`stacked-pickup-pointer-parity: ${passed} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
