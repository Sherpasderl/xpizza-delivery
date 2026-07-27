'use strict';

const { normalizeReorderItems } = require('./reorder-normalize');   // P3 — menu-allowlisted reorder recipe

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
      restaurant_id: restaurantId,   // S1 E2: lets syncDriverHub snapshot the per-restaurant pickup hub
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
    restaurant_id: restaurantId,   // D2: only order_tracking is public-readable — lets the tracker brand per restaurant
    customer_name: fields.customer_name,
    items_text: fields.items_text,
    total: total,
    address_short: addressShort,
    status: 'new',
    created_at: now,
  };

  return updates;
}

/**
 * Scheduled Orders — the HELD order record (no live side-effects). Reuses buildCreateOrderUpdates as the
 * single source of the order-record fields, then HOLDS it: status:'scheduled', + scheduled_for/release_at,
 * and STRIPS everything live — tracking_token, the task-id pointers, and the tasks + order_tracking nodes.
 * At release, buildMaterializeUpdates re-adds status:'new' + a fresh token + tasks + tracking. Returns a
 * single-path map { "orders/{id}": heldRecord } — nothing under tasks/ or order_tracking/.
 */
function buildScheduledOrderRecord(args) {
  const { orderId, scheduledFor, releaseAt } = args;
  const full = buildCreateOrderUpdates(args);          // reuse the record fields (no drift)
  const record = { ...full[`orders/${orderId}`] };
  record.status = 'scheduled';
  record.scheduled_for = scheduledFor;
  record.release_at = releaseAt;
  delete record.tracking_token;                        // no public token until release (R1-#13)
  delete record.pickup_task_id;                        // task pointers/tasks created at release only
  delete record.delivery_task_id;
  return { [`orders/${orderId}`]: record };
}

/**
 * Attribution (H2 — User Profiles P0). Stamp a VERIFIED customer_uid onto the order record and a
 * server-only /user_orders history index. NO-OP for guests (customer_uid falsy) so the guest path stays
 * byte-identical. The uid comes ONLY from the caller (createOrder derives it from a verified
 * X-Firebase-ID-Token, never from the request body) — this helper cannot forge it. `orders/{id}` is a
 * whole-object key in `updates`, so mutating .customer_uid never overlaps a sibling path. Mutates +
 * returns `updates`. `/user_orders` is server-written and .read-denied until P3.
 */
function attachCustomerAttribution(updates, orderId, customer_uid, meta) {
  if (!customer_uid) return updates;
  const orderRec = updates[`orders/${orderId}`];
  orderRec.customer_uid = customer_uid;
  updates[`user_orders/${customer_uid}/${orderId}`] = {
    ts: meta.now,
    total: meta.total,
    order_type: meta.orderType,
    items_text: meta.items_text,
    restaurant: meta.restaurantId,                              // P3 — client filters to its own brand
    status: orderRec.status || meta.status || null,            // P3 — order's initial status (new / scheduled), kept fresh by the status trigger
    items: normalizeReorderItems(meta.items, meta.restaurantId), // P3 — menu-allowlisted reorder recipe (never raw client strings)
  };
  return updates;
}

/**
 * H10 durability decision (pure + testable). Given a verified decoded ID token and whether that uid is
 * tombstoned (a keyed /deleted_uids read done by the caller), return the uid to attribute — or null to fall
 * back to the guest path. A non-customer token, a missing uid, OR a tombstoned (deleted) account → null.
 * The RTDB tombstone read + the try/catch fail-safe stay in the createOrder handler; this is only the
 * decision, so "tombstoned → guest" and "active → attributed" are unit-testable without an emulator.
 */
function attributionUid(dec, isTombstoned) {
  if (!dec || dec.customer !== true || !dec.uid) return null;
  return isTombstoned ? null : dec.uid;
}

module.exports = { buildCreateOrderUpdates, buildScheduledOrderRecord, attachCustomerAttribution, attributionUid };
