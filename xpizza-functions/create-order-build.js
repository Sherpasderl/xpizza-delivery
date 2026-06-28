'use strict';

/**
 * Pure builder for createOrder's atomic write (cash / non-online intake). Mirrors
 * buildMaterializeUpdates: returns the `{ "path": value }` map for one `.update()` — the live
 * order record + driver tasks (delivery only) + the public order_tracking record.
 *
 * Extracted from createOrder so the cash path (X. Pizza's primary flow) is golden-testable for
 * byte-identical output. The order/task/tracking field names are load-bearing (driver app, KDS,
 * tracking site, factura trigger). Pure: no db / no I/O; `now` injected.
 *
 * Inputs that involve server pricing (priceBreakdown, facturaPriced, cashTenderedCents) are
 * computed by the caller and passed in, to keep this module dependency-free.
 */
function buildCreateOrderUpdates({
  orderId, orderType, now, trackingToken, total, lat, lng, fields, hubSnap,
  restaurantId, priceBreakdown, facturaPriced, cashTenderedCents,
}) {
  const pickupTaskId = `${orderId}_pickup`;
  const deliveryTaskId = `${orderId}_delivery`;
  const updates = {};

  const orderRecord = {
    order_id: orderId,
    customer_name: fields.customer_name,
    customer_phone: fields.customer_phone,
    items_text: fields.items_text,
    total: total,
    ...priceBreakdown, // total_cents / subtotal_cents / tax_cents (ISV 15% incl.)
    notes: fields.notes,
    payment_method: fields.payment_method,
    order_type: orderType,
    status: 'new',
    tracking_token: trackingToken,
    created_at: now,
    // --- factura (SAR) fields; the allocateFacturaOnSale trigger consumes these ---
    restaurant_id: restaurantId,
    // Immutable hub snapshot (ADR-0002) — allowlisted fields only.
    hub_lat: hubSnap.hub_lat,
    hub_lng: hubSnap.hub_lng,
    restaurant_name: hubSnap.restaurant_name,
    restaurant_phone: hubSnap.restaurant_phone,
    factura_status: 'not_due',
    cash_tendered_cents: cashTenderedCents,
    ...(facturaPriced.items ? { items: facturaPriced.items } : {}),
    ...(fields.razon_social ? { razon_social: fields.razon_social } : {}),
    ...(fields.rtn_cliente ? { rtn_cliente: fields.rtn_cliente } : {}),
  };

  if (orderType === 'delivery') {
    orderRecord.lat = lat;
    orderRecord.lng = lng;
    orderRecord.address_detected = fields.address_detected;
    orderRecord.address_details = fields.address_details;
    orderRecord.maps_link = `https://www.google.com/maps?q=${lat},${lng}`;
    orderRecord.pickup_task_id = pickupTaskId;
    orderRecord.delivery_task_id = deliveryTaskId;
  } else {
    orderRecord.pickup_time = fields.pickup_time;
  }

  updates[`orders/${orderId}`] = orderRecord;

  if (orderType === 'delivery') {
    updates[`tasks/${pickupTaskId}`] = {
      order_id: orderId,
      type: 'pickup',
      status: 'pending',
      assigned_driver_id: null,
      linked_task_id: deliveryTaskId,
      depends_on_task_id: null,
      destination_lat: hubSnap.hub_lat,
      destination_lng: hubSnap.hub_lng,
      destination_address: hubSnap.restaurant_name,
      recipient_name: hubSnap.restaurant_name,
      recipient_phone: hubSnap.restaurant_phone,
      notes: fields.items_text,
      created_at: now,
    };
    updates[`tasks/${deliveryTaskId}`] = {
      order_id: orderId,
      type: 'delivery',
      status: 'pending',
      assigned_driver_id: null,
      linked_task_id: pickupTaskId,
      depends_on_task_id: pickupTaskId,
      destination_lat: lat,
      destination_lng: lng,
      destination_address: fields.address_detected,
      address_details: fields.address_details,
      recipient_name: fields.customer_name,
      recipient_phone: fields.customer_phone,
      payment_method: fields.payment_method,
      total: total,
      notes: fields.items_text,
      created_at: now,
    };
  }

  const addressShort = orderType === 'delivery'
    ? fields.address_detected.split(',')[0].trim()
    : 'Recoger en X. Pizza';
  updates[`order_tracking/${trackingToken}`] = {
    order_id: orderId,
    order_type: orderType,
    customer_name: fields.customer_name,
    items_text: fields.items_text,
    total: total,
    address_short: addressShort,
    status: 'new',
    created_at: now,
  };

  return updates;
}

module.exports = { buildCreateOrderUpdates };
