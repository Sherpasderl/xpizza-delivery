'use strict';
// "Quitar repartidor" — unassignOrder for PRE-PICKUP orders only (PLAN-unassign-prepickup r1.2, APPROVED).
// The bar is PARITY with the live assignment-timeout release: after the pre-checks this calls the SAME release the timeout path
// calls (releaseToSinAsignar, injected as deps.release — unchanged), plus (U1-b) the cancel core's atomic driver release and a
// create-only audit. Deps: { db, release(db, orderId, driverId) → bool, now(), log(msg) }.
// Returns either { status: 200, body: {ok:true} | {ok:false, reason} } or { status: 4xx/5xx, body: {error, …} }.

// RTDB key safety (codex P2-9): non-empty, ≤ 128 chars, none of . # $ [ ] / and no control characters
const KEY_RE = /^[^.#$[\]/\u0000-\u001f\u007f]{1,128}$/;
const validKey = (v) => typeof v === 'string' && KEY_RE.test(v);

const TERMINAL = new Set(['delivered', 'completed', 'cancelled']);
const RELEASABLE_PICKUP = new Set(['assigned', 'accepted', 'in_progress']);
// cancel-order-core.js cleanupTasksAndDriver's allowlist: only these driver statuses become 'available'
const AVAILABLE_FROM = new Set(['assigned', 'at_restaurant', 'en_route_delivery']);

// U1-b: ONE transaction on drivers/{uid}, mirroring the cancel core exactly. Null node → null (never creates). A pointer that
// names anything but this order's pickup/delivery task → abort (a competing pointer is never touched). Otherwise clear the
// pointer and set 'available' only from the allowlist; every other field and status is preserved.
function driverReleaseUpdater(orderId) {
  const ours = new Set([`${orderId}_pickup`, `${orderId}_delivery`]);
  return (cur) => {
    if (cur === null || cur === undefined) return null;
    if (!ours.has(cur.current_task_id)) return undefined;
    const next = { ...cur, current_task_id: null };
    if (AVAILABLE_FROM.has(cur.status)) next.status = 'available';
    return next;
  };
}

// codex P2-3: CREATE-ONLY audit — a delayed retry never overwrites the original event.
const auditCreateOnly = (record) => (cur) => (cur === null || cur === undefined ? record : undefined);

async function repairPointer(deps, orderId, driverId) {
  try {
    await deps.db.ref(`drivers/${driverId}`).transaction(driverReleaseUpdater(orderId));
    return true;
  } catch (e) {
    deps.log(`unassignOrder: pointer repair failed ${orderId} ${driverId}: ${(e && e.message) || e}`);
    return false;
  }
}

async function runUnassign(deps, { orderId, expectedFromDriver, opId, actor, uid, byKind }) {
  const { db } = deps;
  if (!validKey(orderId) || !validKey(expectedFromDriver) || !validKey(opId)) return { status: 400, body: { error: 'bad_request' } };
  const val = async (p) => (await db.ref(p).once('value')).val();
  const order = await val(`orders/${orderId}`);
  const pickup = await val(`tasks/${orderId}_pickup`);
  const delivery = await val(`tasks/${orderId}_delivery`);
  if (!order || !pickup || !delivery) return { status: 404, body: { error: 'not_found' } };
  if (TERMINAL.has(order.status)) return { status: 409, body: { error: 'terminal' } };

  // r1.2 already-released branch: both legs unowned + pickup pending → not_assigned AND repair the expected driver's pointer
  if (!pickup.assigned_driver_id && !delivery.assigned_driver_id && pickup.status === 'pending') {
    await repairPointer(deps, orderId, expectedFromDriver);
    return { status: 200, body: { ok: false, reason: 'not_assigned' } };
  }
  if (pickup.status === 'completed' || order.status === 'out_for_delivery') return { status: 200, body: { ok: false, reason: 'picked_up' } };
  if (!RELEASABLE_PICKUP.has(pickup.status)) return { status: 409, body: { error: 'state', status: pickup.status || null } };
  if (delivery.assigned_driver_id !== expectedFromDriver) {
    if (delivery.assigned_driver_id) return { status: 200, body: { ok: false, reason: 'reassigned' } };
    await repairPointer(deps, orderId, expectedFromDriver);
    return { status: 200, body: { ok: false, reason: 'not_assigned' } };
  }
  if (pickup.assigned_driver_id !== expectedFromDriver) return { status: 200, body: { ok: false, reason: 'reassigned' } };   // a split shape is never released here

  // the IDENTICAL release the timeout path performs (marker clear → expected-owner CAS → both-legs pending)
  const released = await deps.release(db, orderId, expectedFromDriver);
  if (!released) {
    const owner = await val(`tasks/${orderId}_delivery/assigned_driver_id`);
    if (owner && owner !== expectedFromDriver) return { status: 200, body: { ok: false, reason: 'reassigned' } };
    if (!owner) { await repairPointer(deps, orderId, expectedFromDriver); return { status: 200, body: { ok: false, reason: 'not_assigned' } }; }
    return { status: 503, body: { error: 'retryable' } };   // the CAS did not commit — never reported as success or a no-op
  }
  await repairPointer(deps, orderId, expectedFromDriver);   // U1-b
  try {
    await db.ref(`order_events/${orderId}/unassign_${opId}`).transaction(auditCreateOnly({
      action: 'unassign', by: actor, by_uid: uid || null, by_kind: byKind, from_driver: expectedFromDriver, at: deps.now(),
    }));
  } catch (e) { deps.log(`unassignOrder: audit write failed ${orderId} ${opId}: ${(e && e.message) || e}`); }
  return { status: 200, body: { ok: true } };
}

module.exports = { runUnassign, driverReleaseUpdater, auditCreateOnly, validKey, KEY_RE, AVAILABLE_FROM, RELEASABLE_PICKUP };
