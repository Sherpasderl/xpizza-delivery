'use strict';
// Tracker-parity guard for the #962 hotfix (buildCompleteTaskUpdates → pointer names the next stop's WORKING task).
// deriveOrderTracker is the tracker_fixes-ON derivation (the flag gates whether it is USED, in recompute.js; the
// function itself is pure). With the fix, after delivering stop 1 the pointer names stop 2's PICKUP while its pickup
// isn't completed. This proves the customer tracker must NOT show that order as `live` (driver actively arriving) on
// a PICKUP pointer — it is `pre`/`neutral` until the pickup completes — and that a normal picked-up delivery pointer
// still derives `live` (the fix suppresses nothing legitimate). Real derive.js + real getDriverOrders byte-copy.
const assert = require('node:assert/strict');
const { deriveOrderTracker } = require('./derive');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; }
}

const UID = 'elmer';
// Carolina stacked-accepted but NOT yet picked up: pickup accepted (not completed), delivery accepted.
const C_pu = { order_id: 'carolina', type: 'pickup', status: 'accepted', assigned_driver_id: UID, created_at: 200, linked_task_id: 'carolina_delivery' };
const C_del = { order_id: 'carolina', type: 'delivery', status: 'accepted', assigned_driver_id: UID, created_at: 201, linked_task_id: 'carolina_pickup' };
const ownerTasks = { carolina_pickup: C_pu, carolina_delivery: C_del };

t('pointer = Carolina PICKUP, pickup not completed, order NOT out_for_delivery → NOT live (pre)', () => {
  const owner = { uid: UID, active: true, current_shift_id: 'shift1', current_task_id: 'carolina_pickup' };
  const r = deriveOrderTracker({ orderId: 'carolina', order: { status: 'ready' }, pickup: C_pu, delivery: C_del, owner, ownerTasks });
  assert.notEqual(r.mode, 'live', 'a pickup pointer on an un-picked-up order must never read as live');
  assert.equal(r.mode, 'pre', 'order not yet out_for_delivery → pre');
});

t('defensive: even if the order were out_for_delivery, a PICKUP pointer → NOT live (neutral)', () => {
  const owner = { uid: UID, active: true, current_shift_id: 'shift1', current_task_id: 'carolina_pickup' };
  const r = deriveOrderTracker({ orderId: 'carolina', order: { status: 'out_for_delivery' }, pickup: C_pu, delivery: C_del, owner, ownerTasks });
  assert.notEqual(r.mode, 'live', 'pointer names the pickup, not the delivery[0] → the live gate must not fire');
  assert.equal(r.mode, 'neutral');
});

t('positive control: once picked up (pickup completed) + out_for_delivery + pointer = DELIVERY → live (fix suppresses nothing)', () => {
  const pu = { ...C_pu, status: 'completed' };
  const del = { ...C_del, status: 'in_progress' };
  const owner = { uid: UID, active: true, current_shift_id: 'shift1', current_task_id: 'carolina_delivery' };
  const r = deriveOrderTracker({ orderId: 'carolina', order: { status: 'out_for_delivery' }, pickup: pu, delivery: del, owner, ownerTasks: { carolina_pickup: pu, carolina_delivery: del } });
  assert.equal(r.mode, 'live', 'picked up + delivery pointer + sole active drop → live');
});

console.log(`stacked-pickup-pointer-parity: ${passed} passed`);
