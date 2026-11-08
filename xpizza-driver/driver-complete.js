/**
 * Pure delivery/task/driver enums + the completeTask update builder. No DOM, no Firebase, no remote imports
 * — so the money-grade delivery writer (buildCompleteTaskUpdates) can be driven directly by node tests and by
 * the emulator rules test (which cannot load xpizza-delivery.js — that module imports the Firebase web SDK
 * over https). xpizza-delivery.js imports these as its single source of truth and re-exports the enums.
 */

export const DRIVER_STATUS = {
  OFF_SHIFT: 'off_shift',
  AVAILABLE: 'available',
  ASSIGNED: 'assigned',
  AT_RESTAURANT: 'at_restaurant',
  EN_ROUTE_DELIVERY: 'en_route_delivery',
  RETURNING: 'returning',
  ON_BREAK: 'on_break'
};

export const TASK_STATUS = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
};

export const TASK_TYPE = {
  PICKUP: 'pickup',
  DELIVERY: 'delivery'
};

export const ORDER_STATUS = {
  PENDING_PAYMENT: 'pending_payment',   // online order awaiting payment — NOT operationally live
  NEW: 'new',
  PREPARING: 'preparing',
  READY: 'ready',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled'
};

/**
 * PURE builder for completeTask's atomic multi-path update — the single delivery writer. `now` is the value
 * for the time fields (serverTimestamp() in production; a number in tests). For DELIVERY tasks it marks the
 * order delivered AND stamps the money-grade `delivered_by_driver_uid` (see RTDB rules), then promotes the
 * next stacked delivery or returns the driver to the restaurant. Throws on a missing/cancelled task (swiping
 * "¡Entregado!" on a cancelled delivery must not resurrect it as DELIVERED).
 */
export function buildCompleteTaskUpdates({ driverId, taskId, task, allTasks, now }) {
  if (!task) throw new Error('Esta tarea ya no existe');
  if (task.status === TASK_STATUS.CANCELLED) throw new Error('Este pedido fue cancelado');

  const updates = {};
  updates[`tasks/${taskId}/status`] = TASK_STATUS.COMPLETED;
  updates[`tasks/${taskId}/completed_at`] = now;

  if (task.type === TASK_TYPE.DELIVERY) {
    if (task.order_id) {
      updates[`orders/${task.order_id}/status`] = ORDER_STATUS.DELIVERED;
      updates[`orders/${task.order_id}/delivered_at`] = now;
      // MONEY-GRADE delivery attribution, captured synchronously in the delivered-transition batch.
      // Since 97fe1dd the server deletes both task legs the instant the order goes delivered, so the
      // cuadre/idle/history can no longer attribute cash from the (now-gone) completed task. This stamp
      // is the durable source those read sites use. driverId === auth.uid === assigned_driver_id (the
      // task's assigned driver completing their own task), which the RTDB rules enforce: assigned driver,
      // self, write-once, only on the delivered transition. The async server delivered_by_uid remains a
      // bounded legacy fallback for orders delivered before the cutover.
      updates[`orders/${task.order_id}/delivered_by_driver_uid`] = driverId;
    }

    // Look for the next queued delivery for this driver — a delivery task already 'accepted' (stacked), not
    // completed/cancelled. SEQUENCING (stacked-order consumption): when the remaining stacked deliveries form a
    // COHERENT server-sequenced stack — all carry stop_seq ∈ {1,2} with the SAME stack_id and DISTINCT ranks —
    // take the LOWEST remaining stop_seq (the server's decided order). Otherwise (absent / partial / mismatched)
    // fall back to the earliest created_at — byte-identical to the legacy behaviour. The server (sequencing/
    // plan-stack) is the ONLY writer of stop_seq/stack_id (on tasks/{oid}_delivery); flag-OFF writes none, so the
    // OFF / non-stacked path stays on created_at.
    const remaining = [];
    for (const [tid, t] of Object.entries(allTasks || {})) {
      if (tid === taskId) continue;
      if (!t || t.assigned_driver_id !== driverId) continue;
      if (t.type !== TASK_TYPE.DELIVERY) continue;
      if (t.status !== TASK_STATUS.ACCEPTED && t.status !== TASK_STATUS.IN_PROGRESS) continue;
      remaining.push({ tid, t });
    }
    const seqMembers = remaining.filter(({ t }) => t.stack_id && (t.stop_seq === 1 || t.stop_seq === 2));
    const coherentSeq = remaining.length > 0 && seqMembers.length === remaining.length
      && new Set(remaining.map(({ t }) => t.stack_id)).size === 1
      && new Set(remaining.map(({ t }) => t.stop_seq)).size === remaining.length;   // distinct ranks
    let nextDeliveryId = null;
    if (coherentSeq) {
      nextDeliveryId = remaining.reduce((lo, m) => (lo === null || m.t.stop_seq < lo.t.stop_seq ? m : lo), null).tid;
    } else {
      let earliestCreated = Infinity;
      for (const { tid, t } of remaining) {
        const created = t.created_at || 0;
        if (created < earliestCreated) { earliestCreated = created; nextDeliveryId = tid; }
      }
    }

    if (nextDeliveryId) {
      // Stacked: promote the next stop to current, keep en_route_delivery state. The pointer must name that stop's
      // WORKING task — its PICKUP while that order's pickup is not yet completed, else its DELIVERY. A stacked order
      // that joined post-pickup (reassigned to a driver already out for delivery) has its delivery accepted but its
      // pickup still uncompleted; the driver has to pick it up before delivering, so the pointer names that PICKUP.
      // Pointing at the delivery while the pickup is pending made current_task_id disagree with the stop's working
      // task, which the pointer gate reads as "pointer set but unresolved" and locked the «Recogí el pedido» slide
      // (bug #962, 2026-11-07). A delivery task with no linked pickup, or a pickup already completed, keeps today's
      // behaviour (→ the delivery), so non-stacked / already-picked-up flows are byte-identical.
      const nextDelivery = allTasks[nextDeliveryId];
      const nextPickupId = nextDelivery && nextDelivery.linked_task_id;
      const nextPickup = nextPickupId ? allTasks[nextPickupId] : null;
      // Substitute the pickup pointer ONLY for a VALID ACTIONABLE pair, so we never arm the pickup slide on a
      // malformed/foreign pickup — a pickup whose own link is missing makes pickupComplete write tasks/undefined/…
      // (Codex r1 P2). Required: a pickup task, the SAME order, the SAME driver, an actionable status
      // (accepted|in_progress), and a RECIPROCAL link back to this delivery. Anything else keeps the baseline
      // (→ the delivery), preserving today's behaviour (incl. its unresolved-pointer limitation for malformed data).
      const validActionablePickup = !!(nextPickup
        && nextPickup.type === TASK_TYPE.PICKUP
        && typeof nextDelivery.order_id === 'string' && nextDelivery.order_id !== ''
        && nextPickup.order_id === nextDelivery.order_id
        && nextPickup.assigned_driver_id === driverId
        && (nextPickup.status === TASK_STATUS.ACCEPTED || nextPickup.status === TASK_STATUS.IN_PROGRESS)
        && nextPickup.linked_task_id === nextDeliveryId);
      const nextWorkingId = validActionablePickup ? nextPickupId : nextDeliveryId;
      updates[`drivers/${driverId}/current_task_id`] = nextWorkingId;
      // status stays en_route_delivery — driver still has a stop to work
    } else {
      // No stacked deliveries — driver returns to restaurant
      updates[`drivers/${driverId}/current_task_id`] = null;
      updates[`drivers/${driverId}/status`] = DRIVER_STATUS.RETURNING;
    }
  }
  // Note: pickup completion is normally handled by pickupComplete() which
  // also accepts the linked delivery task. Direct completeTask on a pickup
  // is unusual but supported — just clears the pickup status without touching driver.
  return updates;
}
