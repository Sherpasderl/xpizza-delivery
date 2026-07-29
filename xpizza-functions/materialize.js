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

  // Snapshot-or-fallback (single chokepoint → every materialize entrypoint: confirmOnlinePayment,
  // hosted webhook, recovery trigger, manual reconciliation). Use the order's immutable charge-time
  // hub snapshot when present (3b+ orders); fall back to the passed-in RESTAURANT constant only for
  // in-flight pre-3b pending orders that predate the snapshot.
  const rest = {
    lat: Number.isFinite(order.hub_lat) ? order.hub_lat : restaurant.lat,
    lng: Number.isFinite(order.hub_lng) ? order.hub_lng : restaurant.lng,
    name: order.restaurant_name || restaurant.name,
    phone: order.restaurant_phone || restaurant.phone,
  };

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

  // H2 attribution (Task 0): carry a logged-in customer's uid onto the now-live card order + the
  // /user_orders history index, identically to a cash order. FIELD-LEVEL paths ONLY — this builder patches
  // orders/{id}/* fields, so we must NOT call attachCustomerAttribution (it assumes a whole-object
  // orders/{id} node → would throw here and strand a PAID order). Shared builder → confirmOnlinePayment,
  // pixelPayWebhook, sweep-recovery, and scheduled-release all attribute for free.
  if (order.customer_uid && method === 'online') {   // online only — cash was already attributed at intake by createOrder (a scheduled-cash release must NOT rewrite its history entry)
    updates[`orders/${orderId}/customer_uid`] = order.customer_uid;
    updates[`user_orders/${order.customer_uid}/${orderId}`] = {
      ts: now, total: order.total, order_type: order.order_type, items_text: order.items_text,
      restaurant: order.restaurant_id || 'x_pizza',                   // P3 — client filters to its own brand
      status: 'new',                                                  // P3 — materialized status (this write only runs at confirm); kept fresh by the status trigger
      items: Array.isArray(order.reorder_items) ? order.reorder_items : [],   // P3 — recipe plumbed onto the pending order at chargeOnlineOrder; copied here at confirm (NEVER order.items/factura lines)
    };
  }

  // Driver tasks ONLY for delivery (pickup = customer collects, no dispatch).
  if (orderType === 'delivery') {
    const pickupTaskId = `${orderId}_pickup`;
    const deliveryTaskId = `${orderId}_delivery`;
    // Mirror createOrder: write the task-id pointers onto the order node. The dashboard
    // dereferences order.delivery_task_id with no fallback, so paid online delivery orders
    // would otherwise show no driver in analytics.
    updates[`orders/${orderId}/pickup_task_id`] = pickupTaskId;
    updates[`orders/${orderId}/delivery_task_id`] = deliveryTaskId;
    updates[`tasks/${pickupTaskId}`] = {
      order_id: orderId,
      restaurant_id: order.restaurant_id || 'x_pizza',   // S1 E2: syncDriverHub snapshot source (legacy-normalized, mirrors order_tracking)
      type: 'pickup',
      status: 'pending',
      assigned_driver_id: null,
      linked_task_id: deliveryTaskId,
      depends_on_task_id: null,
      destination_lat: rest.lat,
      destination_lng: rest.lng,
      destination_address: rest.name,
      recipient_name: rest.name,
      recipient_phone: rest.phone,
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
      ...(order.free_order ? { free_order: true } : {}),   // A1: a scheduled free order's task is built HERE (not at create) — carry the flag so the driver suppresses collection
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
    restaurant_id: order.restaurant_id || 'x_pizza',   // D2: per-restaurant tracker branding (legacy-normalized)
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
