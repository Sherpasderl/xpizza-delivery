'use strict';
// RELEASE RACE (PLAN-release-race r2.1, owner edge-case rule) — the dispatcher alert the sweep strand healer raises when it has
// CONFIRMED (≥ HALF_CLAIM_STALE_MS persisted) and COMMITTED a heal of an inconsistent pickup / delivery pair: whatever left the
// legs split — a release racing a reassignment, a partial release, an abandoned claim → finalize — the dispatcher learns that a
// driver may have been told an order that is now back in SIN ASIGNAR.
//   • ONE node per order, dispatcher_alerts/assignment_conflict_{orderId}, CREATE-ONLY (a transaction that never overwrites);
//   • carries order_id, so the Torre's alertNavTarget opens the order;
//   • BOUNDED and best-effort: a rejected or never-settling write is logged and the sweep moves on (Promise.race with a timeout).
const ALERT_TIMEOUT_MS = 3000;

async function alertAssignmentConflict(db, { orderId, deliveryDriverId, pickupDriverId, now }, { timeoutMs = ALERT_TIMEOUT_MS, log = console } = {}) {
  let timer;
  const write = Promise.resolve()
    .then(() => db.ref(`dispatcher_alerts/assignment_conflict_${orderId}`).transaction((cur) => (cur == null ? {
      type: 'assignment_conflict', order_id: orderId,
      delivery_driver_id: deliveryDriverId ?? null, pickup_driver_id: pickupDriverId ?? null, created_at: now,
    } : undefined), undefined, false))
    .then(() => 'written', (e) => { log.error(`assignment_conflict alert failed for ${orderId}`, e && e.message); return 'failed'; });
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    const r = await Promise.race([write, timeout]);
    if (r === 'timeout') log.error(`assignment_conflict alert for ${orderId} did not settle within ${timeoutMs} ms — sweep continues`);
    return r;
  } finally { clearTimeout(timer); }
}

module.exports = { alertAssignmentConflict, ALERT_TIMEOUT_MS };
