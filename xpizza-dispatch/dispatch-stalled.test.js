// xpizza-dispatch/dispatch-stalled.test.js
import assert from 'node:assert';
import { isStalledAssignment } from './dispatch-stalled.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

const NOW = 1_000_000;
// A delivery task offered to a driver with the acceptance deadline already expired.
const dt = (extra = {}) => ({ assigned_driver_id: 'drv1', status: 'assigned', assignment_deadline: NOW - 1, ...extra });

{
  // The ONE true case: assigned to a driver, still 'assigned' (never accepted), deadline expired.
  assert.strictEqual(isStalledAssignment(dt(), NOW), true);
  ok('assigned + expired deadline → true (the stalled case)');
}

{
  // Accepted / progressing states — the driver DID accept, so status moved past 'assigned'. Never flagged.
  for (const status of ['accepted', 'in_progress', 'at_restaurant', 'en_route_delivery', 'completed', 'cancelled']) {
    assert.strictEqual(isStalledAssignment(dt({ status }), NOW), false, `status='${status}' must NOT be stalled`);
  }
  ok('accepted/in_progress/at_restaurant/en_route/completed/cancelled → false (accept left \'assigned\')');
}

{
  // Unassigned — no driver was ever attached → it belongs to the normal "Sin Asignar" flow, not stalled.
  assert.strictEqual(isStalledAssignment(dt({ assigned_driver_id: null }), NOW), false);
  assert.strictEqual(isStalledAssignment(dt({ assigned_driver_id: undefined }), NOW), false);
  assert.strictEqual(isStalledAssignment(dt({ assigned_driver_id: '' }), NOW), false);
  ok('no assigned_driver_id → false (that is a pending/unassigned order)');
}

{
  // Deadline NOT yet expired — the driver still has time to accept; do not flag prematurely.
  assert.strictEqual(isStalledAssignment(dt({ assignment_deadline: NOW }), NOW), false);       // exactly now → not < now
  assert.strictEqual(isStalledAssignment(dt({ assignment_deadline: NOW + 1 }), NOW), false);
  assert.strictEqual(isStalledAssignment(dt({ assignment_deadline: NOW + 60_000 }), NOW), false);
  ok('deadline >= now → false (acceptance window still open)');
}

{
  // Missing / non-finite deadline — cannot prove the window lapsed → not stalled.
  assert.strictEqual(isStalledAssignment(dt({ assignment_deadline: undefined }), NOW), false);
  assert.strictEqual(isStalledAssignment(dt({ assignment_deadline: null }), NOW), false);
  assert.strictEqual(isStalledAssignment(dt({ assignment_deadline: NaN }), NOW), false);
  assert.strictEqual(isStalledAssignment(dt({ assignment_deadline: 'x' }), NOW), false);
  ok('missing / non-finite deadline → false');
}

{
  // Absent task node.
  assert.strictEqual(isStalledAssignment(null, NOW), false);
  assert.strictEqual(isStalledAssignment(undefined, NOW), false);
  ok('null / undefined task → false');
}

{
  // TWO-LEG GUARD: the delivery leg is dormant 'assigned' + expired (the stalled shape) BUT the driver
  // already accepted the pickup leg → NOT stalled (driver is actively in 'Recogida'). This is the
  // Fernando-Kattan false-positive.
  for (const pstatus of ['accepted', 'in_progress', 'at_restaurant', 'en_route_delivery', 'completed']) {
    assert.strictEqual(isStalledAssignment(dt(), NOW, { status: pstatus }), false, `pickup='${pstatus}' → not stalled`);
  }
  ok('pickup accepted/in_progress/... → delivery NOT stalled (driver accepted the entry leg)');

  // Genuine no-accept: pickup ALSO still 'assigned' (never accepted either leg) → still flags.
  assert.strictEqual(isStalledAssignment(dt(), NOW, { status: 'assigned' }), true);
  ok('pickup still assigned + delivery assigned/expired → true (genuine stall)');

  // Missing / malformed pickup task must not suppress the genuine stall.
  assert.strictEqual(isStalledAssignment(dt(), NOW, null), true);
  assert.strictEqual(isStalledAssignment(dt(), NOW, undefined), true);
  assert.strictEqual(isStalledAssignment(dt(), NOW, {}), true);
  ok('no / malformed pickup task → falls through to the delivery-task check');
}

console.log(`\n${pass} passed`);
