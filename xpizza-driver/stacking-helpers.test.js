// Pure stacking-helper tests — run: `node stacking-helpers.test.js` (repo idiom).
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

t('cascades the OTHER order\'s assigned tasks (both pickup+delivery)', () => {
  const ids = stackedTasksToAccept(base, 'me', 'A').sort();
  assert.deepEqual(ids, ['B_delivery', 'B_pickup']);
});

t('NEVER touches the current order (A) — its delivery keeps the normal flow', () => {
  const ids = stackedTasksToAccept(base, 'me', 'A');
  assert.ok(!ids.includes('A_pickup') && !ids.includes('A_delivery'));
});

t('lone order → empty (no-op; single-order flow unchanged)', () => {
  const lone = { A_pickup: base.A_pickup, A_delivery: base.A_delivery };
  assert.deepEqual(stackedTasksToAccept(lone, 'me', 'A'), []);
});

t('already-accepted stacked order → NOT cascaded (no-op vs today\'s auto-assign)', () => {
  const preAccepted = { ...base, B_pickup: { ...base.B_pickup, status: 'accepted' }, B_delivery: { ...base.B_delivery, status: 'accepted' } };
  assert.deepEqual(stackedTasksToAccept(preAccepted, 'me', 'A'), []);
});

t('mixed: only the assigned ones of the other order', () => {
  const mixed = { ...base, B_delivery: { ...base.B_delivery, status: 'accepted' } };
  assert.deepEqual(stackedTasksToAccept(mixed, 'me', 'A'), ['B_pickup']);
});

t('ignores other drivers, completed, and cancelled', () => {
  const noisy = {
    ...base,
    C_pickup: { assigned_driver_id: 'other', order_id: 'C', type: 'pickup', status: 'assigned' },
    D_pickup: { assigned_driver_id: 'me', order_id: 'D', type: 'pickup', status: 'completed' },
    E_pickup: { assigned_driver_id: 'me', order_id: 'E', type: 'pickup', status: 'cancelled' },
  };
  const ids = stackedTasksToAccept(noisy, 'me', 'A').sort();
  assert.deepEqual(ids, ['B_delivery', 'B_pickup']);
});

t('null/empty tasks → empty', () => {
  assert.deepEqual(stackedTasksToAccept(null, 'me', 'A'), []);
  assert.deepEqual(stackedTasksToAccept({}, 'me', 'A'), []);
});

console.log(`✓ stacking-helpers: ${passed} tests passed`);
