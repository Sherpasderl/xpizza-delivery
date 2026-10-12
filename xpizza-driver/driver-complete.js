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

    // Look for the next queued delivery for this driver — a delivery task
    // that's already 'accepted' (stacked) but not completed/cancelled.
    let nextDeliveryId = null;
    let earliestCreated = Infinity;
    for (const [tid, t] of Object.entries(allTasks || {})) {
      if (tid === taskId) continue;
      if (!t || t.assigned_driver_id !== driverId) continue;
      if (t.type !== TASK_TYPE.DELIVERY) continue;
      if (t.status !== TASK_STATUS.ACCEPTED && t.status !== TASK_STATUS.IN_PROGRESS) continue;
      const created = t.created_at || 0;
      if (created < earliestCreated) {
        earliestCreated = created;
        nextDeliveryId = tid;
      }
    }

    if (nextDeliveryId) {
      // Stacked: promote next delivery to current, keep en_route_delivery state
      updates[`drivers/${driverId}/current_task_id`] = nextDeliveryId;
      // status stays en_route_delivery — driver still has pizza to deliver
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
