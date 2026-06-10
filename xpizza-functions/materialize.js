/**
 * X Pizza — shared order materialization (Stage 4, sub-stage 2).
 *
 * `buildMaterializeUpdates` produces the multi-path RTDB update that turns a record
 * into a LIVE order: `order.status:'new'` + driver tasks (delivery only) + the public
 * `order_tracking` record. It is the single source of the live-order shape, shared by
 * the cash path (createOrder, at intake) and the online path (confirmOnlinePayment,
 * after a verified capture). The task/tracking schema MUST stay byte-compatible with
 * createOrder — the driver app + KDS + tracking site read these exact field names.
 *
 * Pure (no db / no I/O): returns a `{ "path": value }` map for one atomic `.update()`.
 * `now` is injected (ServerValue.TIMESTAMP in prod, a number in tests).
 */

// Build the live-order updates. For online confirms `order` is the existing
// pending_payment record (already holds customer/items/total/address); we PATCH the
// order's status/payment fields (not overwrite the node) and ADD tasks + tracking.
function buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentReference = null, paymentMethod = null }) {
  if (!orderId || !order) throw new Error('buildMaterializeUpdates: orderId and order are required');
  const orderType = order.order_type;
  const method = paymentMethod || order.payment_method || null;
  const updates = {};

  // Patch the order node into the live state (field-level paths — the rest of the
  // record was written at pending time and stays intact).
  updates[`orders/${orderId}/status`] = 'new';
  updates[`orders/${orderId}/tracking_token`] = trackingToken;
  updates[`orders/${orderId}/materialized_at`] = now;
  if (method === 'online') {
    updates[`orders/${orderId}/payment_status`] = 'confirmed';
    updates[`orders/${orderId}/charged_at`] = now;
    if (paymentReference != null) updates[`orders/${orderId}/payment_reference`] = paymentReference;
  }

  // Driver tasks ONLY for delivery (pickup = customer collects, no dispatch).
  if (orderType === 'delivery') {
    const pickupTaskId = `${orderId}_pickup`;
    const deliveryTaskId = `${orderId}_delivery`;
    updates[`tasks/${pickupTaskId}`] = {
      order_id: orderId,
      type: 'pickup',
      status: 'pending',
      assigned_driver_id: null,
      linked_task_id: deliveryTaskId,
      depends_on_task_id: null,
      destination_lat: restaurant.lat,
      destination_lng: restaurant.lng,
      destination_address: restaurant.name,
      recipient_name: restaurant.name,
      recipient_phone: restaurant.phone,
      notes: order.items_text,
      created_at: now
    };
    updates[`tasks/${deliveryTaskId}`] = {
      order_id: orderId,
      type: 'delivery',
      status: 'pending',
      assigned_driver_id: null,
      linked_task_id: pickupTaskId,
      depends_on_task_id: pickupTaskId,
      destination_lat: order.lat,
      destination_lng: order.lng,
      destination_address: order.address_detected,
      address_details: order.address_details,
      recipient_name: order.customer_name,
      recipient_phone: order.customer_phone,
      payment_method: method,
      total: order.total,
      notes: order.items_text,
      created_at: now
    };
  }

  // Public tracking record (safe-to-expose subset only).
  const addressShort = orderType === 'delivery'
    ? String(order.address_detected || '').split(',')[0].trim()
    : 'Recoger en X. Pizza';
  updates[`order_tracking/${trackingToken}`] = {
    order_id: orderId,
    order_type: orderType,
    customer_name: order.customer_name,
    items_text: order.items_text,
    total: order.total,
    address_short: addressShort,
    status: 'new',
    created_at: now
  };

  return updates;
}

module.exports = { buildMaterializeUpdates };
