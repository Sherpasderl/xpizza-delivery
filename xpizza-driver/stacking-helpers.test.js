// Pure stacking-helper tests — run: `node stacking-helpers.test.js` (repo idiom).
// F2 §5: hubs now come from the ORDER node (allOrders[oid].hub_lat/hub_lng + restaurant_id), the 2nd arg.
import assert from 'node:assert/strict';
import { stackedTasksToAccept } from './stacking-helpers.js';

let passed = 0;
function t(name, fn) { fn(); passed++; }

// Driver "me" accepts order A (its pickup). Order B is a stacked order still 'assigned'.
const base = {
  A_pickup:   { assigned_driver_id: 'me', order_id: 'A', type: 'pickup',   status: 'assigned' },
  A_delivery: { assigned_driver_id: 'me', order_id: 'A', type: 'delivery', status: 'assigned' },
  B_pickup:   { assigned_driver_id: 'me', order_id: 'B', type: 'pickup',   status: 'assigned' },
  B_delivery: { assigned_driver_id: 'me', order_id: 'B', type: 'delivery', status: 'assigned' },
};
// Orders with NO stamped hub (legacy) → both resolve to the X. Pizza fallback → same-hub → still cascade.
// That IS the legacy-no-hub regression pin: legacy stacks keep cascading exactly as before.
const ordersUnstamped = { A: {}, B: {} };

t('cascades the OTHER order\'s assigned tasks (both pickup+delivery)', () => {
  const ids = stackedTasksToAccept(base, ordersUnstamped, 'me', 'A').sort();
  assert.deepEqual(ids, ['B_delivery', 'B_pickup']);
});

t('NEVER touches the current order (A) — its delivery keeps the normal flow', () => {
  const ids = stackedTasksToAccept(base, ordersUnstamped, 'me', 'A');
  assert.ok(!ids.includes('A_pickup') && !ids.includes('A_delivery'));
});

t('lone order → empty (no-op; single-order flow unchanged)', () => {
  const lone = { A_pickup: base.A_pickup, A_delivery: base.A_delivery };
  assert.deepEqual(stackedTasksToAccept(lone, { A: {} }, 'me', 'A'), []);
});

t('already-accepted stacked order → NOT cascaded (no-op vs today\'s auto-assign)', () => {
  const preAccepted = { ...base, B_pickup: { ...base.B_pickup, status: 'accepted' }, B_delivery: { ...base.B_delivery, status: 'accepted' } };
  assert.deepEqual(stackedTasksToAccept(preAccepted, ordersUnstamped, 'me', 'A'), []);
});

t('mixed: only the assigned ones of the other order', () => {
  const mixed = { ...base, B_delivery: { ...base.B_delivery, status: 'accepted' } };
  assert.deepEqual(stackedTasksToAccept(mixed, ordersUnstamped, 'me', 'A'), ['B_pickup']);
});

t('ignores other drivers, completed, and cancelled', () => {
  const noisy = {
    ...base,
    C_pickup: { assigned_driver_id: 'other', order_id: 'C', type: 'pickup', status: 'assigned' },
    D_pickup: { assigned_driver_id: 'me', order_id: 'D', type: 'pickup', status: 'completed' },
    E_pickup: { assigned_driver_id: 'me', order_id: 'E', type: 'pickup', status: 'cancelled' },
  };
  const ids = stackedTasksToAccept(noisy, { A: {}, B: {}, C: {}, D: {}, E: {} }, 'me', 'A').sort();
  assert.deepEqual(ids, ['B_delivery', 'B_pickup']);
});

t('null/empty tasks → empty', () => {
  assert.deepEqual(stackedTasksToAccept(null, null, 'me', 'A'), []);
  assert.deepEqual(stackedTasksToAccept({}, {}, 'me', 'A'), []);
});

const XP = { lat: 15.507489753573818, lng: -88.0398486953722 };
const LM = { lat: 15.50414, lng: -88.03848 };

t('S2: cross-hub other order (la_musa) → NOT cascaded (stays assigned for explicit swipe)', () => {
  const orders = {
    A: { restaurant_id: 'x_pizza', hub_lat: XP.lat, hub_lng: XP.lng },
    B: { restaurant_id: 'la_musa', hub_lat: LM.lat, hub_lng: LM.lng },
  };
  assert.deepEqual(stackedTasksToAccept(base, orders, 'me', 'A'), []);
});

t('S2: mismatched-coord other order (la_musa rid + x_pizza coords) → NOT cascaded (fail-closed)', () => {
  const orders = {
    A: { restaurant_id: 'x_pizza', hub_lat: XP.lat, hub_lng: XP.lng },
    B: { restaurant_id: 'la_musa', hub_lat: XP.lat, hub_lng: XP.lng },   // rid says la_musa but coords are X. Pizza → null
  };
  assert.deepEqual(stackedTasksToAccept(base, orders, 'me', 'A'), []);
});

t('S2: same-hub stamped other order (both x_pizza) → cascaded', () => {
  const orders = {
    A: { restaurant_id: 'x_pizza', hub_lat: XP.lat, hub_lng: XP.lng },
    B: { restaurant_id: 'x_pizza', hub_lat: XP.lat, hub_lng: XP.lng },
  };
  assert.deepEqual(stackedTasksToAccept(base, orders, 'me', 'A').sort(), ['B_delivery', 'B_pickup']);
});

t('S5: same-hub stamped la_musa pair → cascaded (brand-agnostic by coords, not literal)', () => {
  const orders = {
    A: { restaurant_id: 'la_musa', hub_lat: LM.lat, hub_lng: LM.lng },
    B: { restaurant_id: 'la_musa', hub_lat: LM.lat, hub_lng: LM.lng },
  };
  assert.deepEqual(stackedTasksToAccept(base, orders, 'me', 'A').sort(), ['B_delivery', 'B_pickup']);
});

t('S5: candidate order ABSENT from allOrders → null hub → NOT cascaded (fail-closed, §5 point-get precondition)', () => {
  const orders = { A: { restaurant_id: 'x_pizza', hub_lat: XP.lat, hub_lng: XP.lng } };   // B missing
  assert.deepEqual(stackedTasksToAccept(base, orders, 'me', 'A'), []);
});

console.log(`✓ stacking-helpers: ${passed} tests passed`);
