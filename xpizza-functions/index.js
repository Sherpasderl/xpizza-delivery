/**
 * X Pizza Delivery — Cloud Functions
 * version: 1.7.3
 *
 * Endpoints:
 *   - createOrder                   (HTTPS)   — Make.com → Firebase write proxy + WhatsApp "received"
 *   - notifyDriverOnAssignment      (DB trig) — Web Push to driver on assignment
 *   - notifyDriverOnCancellation    (DB trig) — Web Push to assigned driver when order is cancelled
 *   - onOrderCancelled              (DB trig) — Sync cancellations to KDS Sheet
 *   - sendOrderStatusNotifications  (DB trig) — Customer WhatsApp on status transitions
 *   - onIncomingWhatsApp            (HTTPS)   — UltraMsg webhook for inbound customer messages + auto-reply
 *   - autoAssignOnOrderCreate       (DB trig) — Auto-pick driver after grace period (with continuous-at-restaurant stacking)
 *   - monitorAssignmentTimeout      (DB trig) — Reassign on 60s no-accept timeout
 *
 * Why this exists:
 *   Make.com needs a way to create orders in the dispatcher. The naive approach
 *   (give Make a Firebase service account or database secret) means Make holds a
 *   credential with full DB access. That's a big blast radius if leaked.
 *
 *   Instead, this Cloud Function holds the actual Firebase admin credentials
 *   (automatic, since it runs inside the project), and Make only knows a shared
 *   secret. The secret only lets Make hit THIS endpoint — it can't read drivers,
 *   can't see other orders, can't touch dispatcher records.
 *
 * Security model:
 *   - Function is publicly invocable (no Cloud Function IAM auth)
 *   - But every request must include `Authorization: Bearer <MAKE_SECRET>` header
 *   - The secret is set via env var (functions/.env) and deployed with the function
 *   - The Admin SDK has full DB access by virtue of running inside the project,
 *     bypassing security rules. That's correct — the function IS the trusted writer.
 *
 * Idempotency:
 *   - If the same order_id arrives twice (e.g. Make retry after a network blip),
 *     the function returns 200 with idempotent: true and does NOT overwrite.
 *   - This protects against duplicate orders or clobbering an order that's already
 *     been picked up by a driver.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const webpush = require('web-push');
const { google } = require('googleapis');
const express = require('express');
const whatsapp = require('./whatsapp');

initializeApp({
  databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com'
});

// VAPID config for Web Push (set via .env, deployed as runtime env vars)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@xpizza.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Google Sheets config — for syncing order cancellations back to the kitchen
// display sheet. The function uses Application Default Credentials via the
// Cloud Function service account; that service account must be granted
// editor access to the spreadsheet (share the sheet with the SA email).
const KDS_SHEET_ID = process.env.KDS_SHEET_ID;
const KDS_SHEET_NAME = process.env.KDS_SHEET_NAME || 'Pedidos';

// Restaurant pickup details — keep in sync with xpizza-delivery.js RESTAURANT
const RESTAURANT = {
  lat: 15.507489753573818,
  lng: -88.0398486953722,
  name: 'X Pizza',
  phone: '+50497952893'
};

// Maximum distance (kilometers) the restaurant will deliver to. Orders with
// a delivery lat/lng farther than this are rejected by validateOrderPayload.
// The order form has the same check client-side for UX, but we enforce here
// because clients can be bypassed (browser dev tools, direct API calls).
// Tune this with operational reality — too tight rejects real customers,
// too loose stretches drivers.
const DELIVERY_RADIUS_KM = 7;

// Generate a random URL-safe tracking token. 12 chars from a 64-char alphabet
// gives 64^12 = ~4.7e21 possible tokens — guessing one is impossible. The
// token is part of the public tracking URL, so don't include chars that
// require URL-encoding.
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';  // no 0/O/1/l/I to avoid confusion if printed
function generateTrackingToken(length = 12) {
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

// ---- Helpers ----

function unauthorized(res, msg) {
  return res.status(401).json({ error: 'Unauthorized', detail: msg });
}

function badRequest(res, msg) {
  return res.status(400).json({ error: 'Bad Request', detail: msg });
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function asNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function validateOrderPayload(body) {
  const errors = [];
  const required = ['order_id', 'customer_name', 'customer_phone', 'items_text', 'order_type'];
  for (const f of required) {
    if (body[f] == null || body[f] === '') errors.push(`Missing required field: ${f}`);
  }

  // Numeric coercion (Make.com sometimes sends numbers as strings)
  const total = asNumber(body.total);
  const lat = asNumber(body.lat);
  const lng = asNumber(body.lng);

  if (!isFiniteNumber(total) || total <= 0) errors.push('total must be a positive number');

  if (body.order_type === 'delivery') {
    if (!isFiniteNumber(lat) || lat < -90 || lat > 90) errors.push('lat must be a valid latitude');
    if (!isFiniteNumber(lng) || lng < -180 || lng > 180) errors.push('lng must be a valid longitude');
  }

  if (body.order_type !== 'delivery' && body.order_type !== 'pickup') {
    errors.push('order_type must be "delivery" or "pickup"');
  }

  return { errors, total, lat, lng };
}

// ---- The endpoint ----
//
// createOrder is wrapped in an Express app (rather than being a bare
// (req, res) handler) so that an error-handling middleware can catch
// body-parser failures. Without this, Firebase Functions v2's auto-applied
// JSON body parser, when it encounters malformed JSON, lets the SyntaxError
// fall through to the default error handler which returns HTTP 500. That's
// wrong: malformed JSON is a CLIENT error (the caller sent garbage), so it
// should return 400.
//
// The error middleware below intercepts that specific case and returns a
// proper 400. Other unexpected errors fall through unchanged.
//
// The handler logic itself is identical to what existed before — it's just
// now mounted on `createOrderApp.all('*', ...)` instead of being passed
// directly to onRequest.

const createOrderApp = express();

createOrderApp.all('*', async (req, res) => {
  // Method check
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Auth check — shared secret from Authorization: Bearer <secret>
  const SECRET = process.env.MAKE_SECRET;
  if (!SECRET) {
    console.error('MAKE_SECRET env var is not set — refusing all requests');
    return unauthorized(res, 'server misconfigured');
  }
  const authHeader = req.get('authorization') || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!presented || presented !== SECRET) {
    console.warn('createOrder: bad/missing bearer token');
    return unauthorized(res, 'invalid bearer token');
  }

  // Parse + validate
  const body = req.body || {};
  const { errors, total, lat, lng } = validateOrderPayload(body);
  if (errors.length > 0) {
    return badRequest(res, errors.join('; '));
  }

  const orderId = String(body.order_id);
  const orderType = body.order_type;

  // Delivery zone check — reject orders whose lat/lng is farther than
  // DELIVERY_RADIUS_KM from the restaurant. The order form does this
  // client-side too, but we enforce here because clients can be bypassed
  // (browser dev tools, direct API calls, third-party integrations like
  // Make.com). Pickup orders skip this check (they're picked up at the
  // restaurant by definition).
  if (orderType === 'delivery') {
    const distanceKm = haversineKm(lat, lng, RESTAURANT.lat, RESTAURANT.lng);
    if (distanceKm > DELIVERY_RADIUS_KM) {
      console.warn(`createOrder: order ${orderId} rejected — ${distanceKm.toFixed(2)}km > ${DELIVERY_RADIUS_KM}km radius`);
      return badRequest(res, `Outside delivery zone (${distanceKm.toFixed(1)}km from restaurant, max ${DELIVERY_RADIUS_KM}km)`);
    }
  }

  // Pickup orders: not handled by dispatcher (they're walk-in / counter)
  if (orderType !== 'delivery') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'order_type is not delivery', order_id: orderId });
  }

  const db = getDatabase();

  // Idempotency check
  try {
    const existing = await db.ref(`orders/${orderId}`).once('value');
    if (existing.exists()) {
      console.log(`createOrder: order ${orderId} already exists, returning idempotent`);
      return res.status(200).json({ ok: true, idempotent: true, order_id: orderId });
    }
  } catch (e) {
    console.error('createOrder: existence check failed', e);
    return res.status(500).json({ error: 'Database read failed', detail: e.message });
  }

  // Multi-path atomic write — one round-trip creates order + both tasks.
  // Schema mirrors createOrderTasks() in xpizza-delivery.js — these field
  // names are load-bearing (driver app reads recipient_name, destination_lat,
  // and the SDK's pickupComplete() reads pickupTask.linked_task_id).
  const now = ServerValue.TIMESTAMP;
  const updates = {};

  const pickupTaskId = `${orderId}_pickup`;
  const deliveryTaskId = `${orderId}_delivery`;
  const trackingToken = generateTrackingToken();

  updates[`orders/${orderId}`] = {
    order_id: orderId,
    customer_name: String(body.customer_name),
    customer_phone: String(body.customer_phone),
    items_text: String(body.items_text || ''),
    total: total,
    lat: lat,
    lng: lng,
    address_detected: String(body.address_detected || ''),
    address_details: String(body.address_details || ''),
    notes: String(body.notes || ''),
    maps_link: String(body.maps_link || ''),
    payment_method: String(body.payment_method || ''),
    order_type: orderType,
    status: 'new',
    pickup_task_id: pickupTaskId,
    delivery_task_id: deliveryTaskId,
    tracking_token: trackingToken,
    created_at: now
  };

  updates[`tasks/${pickupTaskId}`] = {
    order_id: orderId,
    type: 'pickup',
    status: 'pending',
    assigned_driver_id: null,
    linked_task_id: deliveryTaskId,
    depends_on_task_id: null,
    destination_lat: RESTAURANT.lat,
    destination_lng: RESTAURANT.lng,
    destination_address: RESTAURANT.name,
    recipient_name: RESTAURANT.name,
    recipient_phone: RESTAURANT.phone,
    notes: String(body.items_text || ''),
    created_at: now
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
    destination_address: String(body.address_detected || ''),
    address_details: String(body.address_details || ''),
    recipient_name: String(body.customer_name),
    recipient_phone: String(body.customer_phone),
    payment_method: String(body.payment_method || ''),
    total: total,
    notes: String(body.items_text || ''),
    created_at: now
  };

  // Tracking index: maps tracking_token → order data. Stores ONLY the
  // fields that are safe to expose publicly. The tracking site reads
  // /order_tracking/{token} (public read rule). Customer name + first
  // initial of address are shown but full address, phone, payment details
  // stay in /orders (auth-only).
  //
  // Status field is kept in sync with /orders/{orderId}/status by
  // sendOrderStatusNotifications. driver_name is filled in when
  // out_for_delivery.
  const addressShort = String(body.address_detected || '').split(',')[0].trim();
  updates[`order_tracking/${trackingToken}`] = {
    order_id: orderId,
    customer_name: String(body.customer_name),
    items_text: String(body.items_text || ''),
    total: total,
    address_short: addressShort,
    status: 'new',
    created_at: now
  };

  try {
    await db.ref().update(updates);
    console.log(`createOrder: wrote order ${orderId}`);
  } catch (e) {
    console.error('createOrder: write failed', e);
    return res.status(500).json({ error: 'Database write failed', detail: e.message });
  }

  // Send WhatsApp "order received". We AWAIT this — Cloud Functions
  // doesn't guarantee execution of non-awaited promises (the runtime can
  // freeze the instance once the response is sent). Adds ~500-1000ms to
  // createOrder response time, but the order is already in the database
  // by this point so customer-facing timing is unaffected.
  //
  // Wrapped in try/catch so a WhatsApp failure NEVER causes the order
  // creation to fail — order is already written above.
  if (await whatsapp.isEnabled(db)) {
    try {
      const body = whatsapp.tplOrderReceived({
        customerName: String(updates[`orders/${orderId}`].customer_name || ''),
        orderId,
        itemsText: String(updates[`orders/${orderId}`].items_text || ''),
        total,
        trackingToken
      });
      await whatsapp.sendMessage(updates[`orders/${orderId}`].customer_phone, body);
    } catch (e) {
      console.error('createOrder: whatsapp send failed (order still created)', e.message);
    }
  }

  return res.status(200).json({ ok: true, order_id: orderId, tracking_token: trackingToken });
});

// Error middleware: catches SyntaxError / 'entity.parse.failed' from the
// auto-applied JSON body parser and returns 400 instead of letting it fall
// through to the default 500. Express invokes error middleware (4-arg
// signature) when ANY upstream middleware calls next(err).
//
// If the error isn't a parse failure, fall through to the default handler.
createOrderApp.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn(`createOrder: malformed JSON in request body — ${err.message}`);
    return res.status(400).json({ error: 'Bad Request', detail: 'Malformed JSON in request body' });
  }
  // eslint-disable-next-line no-unused-vars
  next(err);
});

exports.createOrder = onRequest(
  {
    region: 'us-central1',
    cors: false,           // server-to-server, no browser
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  createOrderApp
);

// ============================================================
// notifyDriverOnAssignment — Web Push trigger
// ============================================================
//
// Fires whenever a task record is written. Filters down to the meaningful
// case: a PICKUP task that just got assigned_driver_id set (transitioning
// from null/empty → some driver UID). One push per order.
//
// We trigger on pickup tasks specifically (not delivery) to avoid sending
// two pushes per order — assignOrderToDriver writes both at once.
//
// If the driver has no push_subscription on file, this is a silent no-op
// (notifications were never enabled for them — that's fine, they'll see the
// in-app card when they look at their phone).
//
// If the push send fails with 404/410, we proactively clear the dead
// subscription so we don't keep retrying it.

exports.notifyDriverOnAssignment = onValueWritten(
  {
    ref: '/tasks/{taskId}',
    region: 'us-central1'
  },
  async (event) => {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      console.error('notifyDriver: VAPID keys not configured, skipping');
      return;
    }

    const before = event.data.before.val();
    const after = event.data.after.val();

    // Task was deleted — nothing to do
    if (!after) return;

    // Only fire on pickup tasks (one push per order)
    if (after.type !== 'pickup') return;

    // Detect new assignment: assigned_driver_id changed null → driver UID
    const oldDriverId = before?.assigned_driver_id || null;
    const newDriverId = after.assigned_driver_id || null;
    if (!newDriverId) return;
    if (oldDriverId === newDriverId) return; // no change

    const db = getDatabase();

    // Look up the driver's push subscription
    const driverSnap = await db.ref(`drivers/${newDriverId}`).once('value');
    const driver = driverSnap.val();
    if (!driver?.push_subscription) {
      console.log(`notifyDriver: driver ${newDriverId} has no push subscription, skipping`);
      return;
    }

    // Look up the order for the notification body
    const orderSnap = await db.ref(`orders/${after.order_id}`).once('value');
    const order = orderSnap.val();

    const title = '¡Nuevo pedido!';
    const body = order
      ? `${order.customer_name || 'Cliente'} · L${order.total ?? '—'}`
      : `Pedido #${after.order_id}`;

    const payload = JSON.stringify({
      title,
      body,
      tag: `order-${after.order_id}`,
      data: { order_id: after.order_id }
    });

    try {
      await webpush.sendNotification(driver.push_subscription, payload, {
        urgency: 'high',          // tell the push service this is time-critical
        TTL: 600                  // expire after 10 min if undelivered
      });
      console.log(`notifyDriver: push sent to ${newDriverId} for order ${after.order_id}`);
    } catch (err) {
      const status = err.statusCode;
      console.error(`notifyDriver: push failed for ${newDriverId}, status=${status}`, err.body);

      // 404 Not Found / 410 Gone → the subscription is dead; remove it so we
      // stop retrying. Driver will need to re-enable notifications.
      if (status === 404 || status === 410) {
        await db.ref(`drivers/${newDriverId}/push_subscription`).remove();
        await db.ref(`drivers/${newDriverId}/push_subscription_updated_at`).remove();
        console.log(`notifyDriver: cleared dead subscription for ${newDriverId}`);
      }
    }
  }
);

// ============================================================
// onOrderCancelled — sync cancellation to the KDS Google Sheet
// ============================================================
//
// When a dispatcher cancels an order, /orders/{id}/status flips to
// "cancelled". The kitchen display reads from a Google Sheet (legacy
// pipeline) and has no idea the order was killed unless we tell it.
//
// This function watches /orders/{id}/status. When it transitions
// to "cancelled", it finds the matching row in the KDS sheet by
// order_id (column B, "Orden") and updates its Estado column
// (column I) from "Nuevo" to "Cancelado".
//
// The KDS frontend detects "Cancelado" and renders a struck-through
// red card + plays an alert sound the first time each cancellation
// appears.
//
// Auth: function uses Application Default Credentials (the Cloud
// Function's service account). That SA email must be granted Editor
// access to the spreadsheet — share the sheet with the SA email
// shown in Firebase Console → Project Settings → Service accounts.
//
// Idempotency: if the row's Estado is already "Cancelado", we skip
// the write. Cheap protection against duplicate triggers.

exports.onOrderCancelled = onValueWritten(
  {
    ref: '/orders/{orderId}/status',
    region: 'us-central1'
  },
  async (event) => {
    if (!KDS_SHEET_ID) {
      console.warn('onOrderCancelled: KDS_SHEET_ID not configured, skipping');
      return;
    }

    const before = event.data.before.val();
    const after = event.data.after.val();

    // Only fire on transitions INTO cancelled
    if (after !== 'cancelled') return;
    if (before === 'cancelled') return;

    const orderId = event.params.orderId;
    console.log(`onOrderCancelled: order ${orderId} → cancelled, syncing to KDS sheet`);

    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      const sheets = google.sheets({ version: 'v4', auth });

      // Read all rows in columns A:I to find the matching order_id
      // (Column B = Orden / order_id; Column I = Estado)
      const range = `${KDS_SHEET_NAME}!A2:I1000`;
      const readRes = await sheets.spreadsheets.values.get({
        spreadsheetId: KDS_SHEET_ID,
        range
      });
      const rows = readRes.data.values || [];

      // Walk rows newest-last; orderId is in column B (index 1)
      // We update ALL matching rows (defensive — should only be one)
      const updates = [];
      rows.forEach((row, idx) => {
        const rowOrderId = row[1];
        const rowEstado = row[8];
        if (rowOrderId === orderId && rowEstado !== 'Cancelado') {
          // Sheet rows are 1-indexed and we started at row 2, so
          // sheet row number = idx + 2
          const sheetRowNum = idx + 2;
          updates.push({
            range: `${KDS_SHEET_NAME}!I${sheetRowNum}`,
            values: [['Cancelado']]
          });
        }
      });

      if (updates.length === 0) {
        console.log(`onOrderCancelled: order ${orderId} not found in KDS sheet (or already Cancelado)`);
        return;
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: KDS_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates
        }
      });

      console.log(`onOrderCancelled: updated ${updates.length} row(s) for order ${orderId}`);
    } catch (err) {
      console.error(`onOrderCancelled: failed for order ${orderId}`, err.message);
      // Don't throw — we don't want to retry on auth/permissions errors
      // forever. Log and let the dispatcher's UI feedback handle the user.
    }
  }
);

// ============================================================
// notifyDriverOnCancellation — Web Push to the assigned driver when an order is cancelled
// ============================================================
//
// When an order is cancelled, the previously-assigned driver may have already
// received a "new order" push (or be working it). Without an active alert
// they'd open the app to a missing card with no explanation. This function
// sends a follow-up push so the driver is informed immediately.
//
// Uses the SAME push `tag` as the original assignment notification
// (`order-${orderId}`). On Android this REPLACES the original banner —
// effectively a clean retraction. On iOS, banners stack (the platform
// doesn't dedupe by tag), but both lead to the same correct in-app state
// via the existing cancellation guards in acceptTask/pickupComplete/
// completeTask, so a stale tap is safe.
//
// No-op cases (silent skips):
//   - Cancellation happened before assignment (assigned_driver_id is null)
//   - Driver has no push_subscription on file
//   - Dead subscription (404/410): clears the stale subscription record
//
// Trigger model: watches /orders/{orderId}/status (single fire per order),
// then reads the pickup task to find the assigned driver. Mirrors
// onOrderCancelled's trigger pattern. We don't trigger on /tasks/{id}/status
// because that would fire twice per order (pickup + delivery both flip).

exports.notifyDriverOnCancellation = onValueWritten(
  {
    ref: '/orders/{orderId}/status',
    region: 'us-central1'
  },
  async (event) => {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      console.error('notifyDriverOnCancellation: VAPID keys not configured, skipping');
      return;
    }

    const before = event.data.before.val();
    const after = event.data.after.val();

    // Only fire on transitions INTO cancelled
    if (after !== 'cancelled') return;
    if (before === 'cancelled') return;

    const orderId = event.params.orderId;
    const db = getDatabase();

    // Find the assigned driver via the pickup task. cancelOrder() flips the
    // task status to 'cancelled' but does NOT clear assigned_driver_id, so
    // it survives intact for us to read.
    const pickupTaskId = `${orderId}_pickup`;
    const pickupSnap = await db.ref(`tasks/${pickupTaskId}`).once('value');
    const pickup = pickupSnap.val();
    const driverId = pickup?.assigned_driver_id || null;

    if (!driverId) {
      console.log(`notifyDriverOnCancellation: order ${orderId} cancelled before assignment, no push needed`);
      return;
    }

    // Look up the driver's push subscription
    const driverSnap = await db.ref(`drivers/${driverId}`).once('value');
    const driver = driverSnap.val();
    if (!driver?.push_subscription) {
      console.log(`notifyDriverOnCancellation: driver ${driverId} has no push subscription, skipping`);
      return;
    }

    // Look up the cancel reason (optional — included in body if present, truncated)
    let reason = null;
    try {
      const reasonSnap = await db.ref(`orders/${orderId}/cancel_reason`).once('value');
      reason = reasonSnap.val();
    } catch (e) {
      // Non-fatal — proceed without reason
    }

    const title = '❌ Pedido cancelado';
    let body = `Pedido #${orderId}`;
    if (reason && typeof reason === 'string' && reason.trim().length > 0) {
      // Truncate at 50 chars to fit lock-screen banner without breaking layout
      const trimmed = reason.length > 50 ? reason.slice(0, 47) + '...' : reason;
      body = `${body}: ${trimmed}`;
    }

    const payload = JSON.stringify({
      title,
      body,
      tag: `order-${orderId}`,  // same tag as assignment push → replaces banner on Android
      data: { order_id: orderId, cancelled: true }
    });

    try {
      await webpush.sendNotification(driver.push_subscription, payload, {
        urgency: 'high',
        TTL: 600
      });
      console.log(`notifyDriverOnCancellation: push sent to ${driverId} for cancelled order ${orderId}`);
    } catch (err) {
      const status = err.statusCode;
      console.error(`notifyDriverOnCancellation: push failed for ${driverId}, status=${status}`, err.body);

      // 404/410 → dead subscription, clear it so we stop retrying.
      if (status === 404 || status === 410) {
        await db.ref(`drivers/${driverId}/push_subscription`).remove();
        await db.ref(`drivers/${driverId}/push_subscription_updated_at`).remove();
        console.log(`notifyDriverOnCancellation: cleared dead subscription for ${driverId}`);
      }
    }
  }
);

// ============================================================
// sendOrderStatusNotifications — Customer WhatsApp on status changes
// ============================================================
//
// Watches /orders/{orderId}/status and sends a WhatsApp to the customer for
// each meaningful status transition. Three messages handled here:
//   - out_for_delivery → "driver is on the way"
//   - delivered        → "enjoy your pizza, reply if any issue"
//   - cancelled        → "your order was cancelled"
//
// The fourth message ("order received") is sent directly by createOrder
// because it needs the tracking_token immediately at order creation.
//
// Idempotency:
//   - Each transition only sends once (we check before vs after).
//   - If WhatsApp send fails, we don't retry — the customer just doesn't
//     get the message. Better than risking duplicates.
//
// Fail-safe:
//   - Wrapped in try/catch; any failure is logged but never throws.
//   - Reads /config/whatsapp_enabled kill switch first.

exports.sendOrderStatusNotifications = onValueWritten(
  {
    ref: '/orders/{orderId}/status',
    region: 'us-central1'
  },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    const orderId = event.params.orderId;

    // No-op cases
    if (!after) return;                    // status cleared
    if (before === after) return;          // no actual change

    const db = getDatabase();

    // Always mirror the new status into the tracking record (regardless of
    // whatsapp_enabled flag — the tracking site needs the live status, and
    // this includes status transitions the kitchen makes like 'preparing'/'ready'
    // that don't trigger any WhatsApp send but still update the customer's
    // tracking page in real time).
    let order = null;
    let trackingToken = null;
    try {
      const orderSnap = await db.ref(`orders/${orderId}`).once('value');
      order = orderSnap.val();
      if (order) {
        trackingToken = order.tracking_token;
      }
    } catch (e) {
      console.warn(`sendOrderStatusNotifications: couldn't read order ${orderId}`, e.message);
    }

    if (trackingToken) {
      const trackingUpdates = { [`order_tracking/${trackingToken}/status`]: after };
      if (after === 'out_for_delivery') {
        trackingUpdates[`order_tracking/${trackingToken}/picked_up_at`] = ServerValue.TIMESTAMP;
      } else if (after === 'delivered') {
        trackingUpdates[`order_tracking/${trackingToken}/delivered_at`] = ServerValue.TIMESTAMP;
      } else if (after === 'cancelled') {
        trackingUpdates[`order_tracking/${trackingToken}/cancelled_at`] = ServerValue.TIMESTAMP;
      }
      try {
        await db.ref().update(trackingUpdates);
      } catch (e) {
        console.warn(`sendOrderStatusNotifications: tracking mirror update failed`, e.message);
      }
    }

    // WhatsApp send only fires for these specific transitions. preparing/ready
    // and other intermediate states update the tracking page but don't
    // notify the customer (would be too noisy).
    if (!['out_for_delivery', 'delivered', 'cancelled'].includes(after)) return;

    if (!(await whatsapp.isEnabled(db))) {
      console.log(`sendOrderStatusNotifications: ${orderId} → ${after}, but whatsapp_enabled=false, skipping send`);
      return;
    }

    try {
      // (order is already loaded above)
      if (!order) {
        console.warn(`sendOrderStatusNotifications: order ${orderId} not found`);
        return;
      }
      if (!order.customer_phone) {
        console.warn(`sendOrderStatusNotifications: order ${orderId} has no customer_phone`);
        return;
      }
      if (!trackingToken) {
        console.warn(`sendOrderStatusNotifications: order ${orderId} has no tracking_token (legacy order?)`);
        // Continue anyway — only delivered/cancelled don't need the token.
      }

      let body = null;

      if (after === 'out_for_delivery') {
        // Look up driver name for the message. Read the delivery task to get
        // assigned_driver_id, then read the driver's display_name (preferred)
        // or fall back to a hardcoded mapping for known drivers.
        //
        // Why a hardcoded map: the `name` field in /drivers is a username
        // like "hermeztalavera" (no clean way to split first/last). For
        // customer-facing messages we want a friendly first name. The map
        // below is the source of truth; new drivers should be added here.
        const DRIVER_DISPLAY_NAMES = {
          'HUQ4nOdvNvQcbxoqyYinp8wAC7f2': 'Xavier',
          'xaHcwaRND1V63w8tpXi5VZ7n9P72': 'Hermez'
        };

        let driverName = null;
        try {
          const deliveryTaskId = order.delivery_task_id || `${orderId}_delivery`;
          const deliverySnap = await db.ref(`tasks/${deliveryTaskId}`).once('value');
          const delivery = deliverySnap.val();
          const driverId = delivery && delivery.assigned_driver_id;
          if (driverId) {
            // Priority 1: hardcoded map (canonical first names)
            if (DRIVER_DISPLAY_NAMES[driverId]) {
              driverName = DRIVER_DISPLAY_NAMES[driverId];
            } else {
              // Priority 2: display_name field on driver record (if dispatcher set it)
              const dnSnap = await db.ref(`drivers/${driverId}/display_name`).once('value');
              const dn = dnSnap.val();
              if (dn && typeof dn === 'string') {
                driverName = dn;
              } else {
                // Fallback: use the raw name field, capitalized
                const nameSnap = await db.ref(`drivers/${driverId}/name`).once('value');
                const raw = nameSnap.val();
                if (raw && typeof raw === 'string') {
                  driverName = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
                }
              }
            }
          }
        } catch (e) {
          console.warn(`sendOrderStatusNotifications: couldn't read driver name`, e.message);
        }
        // Mirror driver_name into the tracking record (for the public site)
        if (driverName && trackingToken) {
          try {
            await db.ref(`order_tracking/${trackingToken}/driver_name`).set(driverName);
          } catch (e) {
            console.warn(`sendOrderStatusNotifications: driver_name mirror failed`, e.message);
          }
        }
        body = whatsapp.tplOutForDelivery({
          driverName,
          etaMinutes: null,  // ETA computed by tracking site, not in message
          trackingToken
        });

      } else if (after === 'delivered') {
        body = whatsapp.tplDelivered({
          customerName: order.customer_name
        });

      } else if (after === 'cancelled') {
        body = whatsapp.tplCancelled({
          orderId
        });
      }

      if (!body) return;

      console.log(`sendOrderStatusNotifications: ${orderId} → ${after}, sending WhatsApp to ${order.customer_phone}`);
      await whatsapp.sendMessage(order.customer_phone, body);

    } catch (e) {
      console.error(`sendOrderStatusNotifications: failed for ${orderId} → ${after}`, e.message);
      // Swallow — never throw out of the trigger
    }
  }
);

// ============================================================
// onIncomingWhatsApp — UltraMsg webhook for inbound customer messages
// ============================================================
//
// Receives webhook POSTs from UltraMsg whenever someone messages the X. Pizza
// WhatsApp number. Classifies the message intent and sends an auto-reply.
//
// UltraMsg webhook payload:
//   {
//     event_type: "message_received",
//     instanceId: "170156",
//     data: {
//       from: "[email protected]",  ← sender, "@c.us" suffix
//       body: "hola quiero ordenar",
//       fromMe: false,            ← if true, this is OUR own outgoing — skip
//       type: "chat",             ← only handle text chats; skip media for now
//       time: 1644957719
//     }
//   }
//
// Auth: We don't authenticate this endpoint. UltraMsg doesn't sign webhook
// requests. The webhook URL itself is the secret — keep it out of git history
// and don't share it. Worst case: someone POSTs garbage and we send a polite
// auto-reply to whatever they put in `from` (rate-limited by UltraMsg's
// receive-side limits).
//
// Idempotency: UltraMsg may retry on non-2xx responses. We always return 200
// even on internal errors so we don't get retry storms — log instead.
//
// Side effects:
//   - Sends WhatsApp auto-reply via UltraMsg
//   - Logs unhandled messages to /incoming_messages for dispatcher visibility

const inbound = require('./whatsapp_inbound');

exports.onIncomingWhatsApp = onRequest(
  {
    region: 'us-central1',
    cors: false,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      return res.status(405).send('Method Not Allowed');
    }

    // Shared-secret check.
    //
    // The endpoint URL is effectively public (it's in deploy logs, etc), so
    // we can't rely on URL secrecy. We require a shared secret that's also
    // configured on the UltraMsg side.
    //
    // UltraMsg's webhook UI doesn't support custom headers, so the secret
    // travels as a query-string parameter: ?secret=<...>. Same security
    // properties as a header in HTTPS — the entire URL (including query
    // string) is encrypted in transit.
    //
    // If WHATSAPP_WEBHOOK_SECRET is not set in the env, we refuse all requests
    // (fail-closed). This forces operator awareness — the Cloud Function won't
    // silently accept all traffic.
    //
    // Constant-time comparison prevents timing attacks where an attacker
    // could probe for partial matches by measuring response time.
    const expectedSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
    if (!expectedSecret) {
      console.error('onIncomingWhatsApp: WHATSAPP_WEBHOOK_SECRET env var not set, refusing all requests');
      return res.status(500).send('Server not configured');
    }
    // Accept the secret in any of these locations, in priority order:
    //   1. ?secret=... query param (UltraMsg-friendly path)
    //   2. X-Webhook-Secret header (manual testing)
    //   3. Authorization: Bearer ... (manual testing)
    const presentedSecret =
      (req.query && req.query.secret) ||
      req.get('x-webhook-secret') ||
      req.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
      '';
    if (!constantTimeEqual(String(presentedSecret), expectedSecret)) {
      console.warn('onIncomingWhatsApp: rejected request with bad/missing secret');
      return res.status(401).send('Unauthorized');
    }

    const event = req.body || {};
    const data = event.data || {};

    // Filter out non-customer events
    if (event.event_type !== 'message_received') {
      return res.status(200).send('ignored: event_type');
    }
    if (data.fromMe === true) {
      return res.status(200).send('ignored: fromMe');
    }
    if (data.type && data.type !== 'chat') {
      // Skip media (images, audio, etc.) — we'd need different handling.
      // Still log it so dispatcher can see something arrived.
      console.log(`onIncomingWhatsApp: ignored non-chat type=${data.type} from=${data.from}`);
      try {
        const db = getDatabase();
        await db.ref('incoming_messages').push({
          from: data.from || 'unknown',
          type: data.type,
          body: data.body || null,
          time: data.time || Math.floor(Date.now() / 1000),
          handled: false,
          reason: 'non-chat type'
        });
      } catch (e) { /* best-effort */ }
      return res.status(200).send('ignored: non-chat');
    }

    // Strip "@c.us" suffix from sender. UltraMsg uses [phone]@c.us format.
    const fromPhoneRaw = String(data.from || '').replace(/@c\.us$/, '');
    const body = String(data.body || '');

    if (!fromPhoneRaw) {
      console.warn('onIncomingWhatsApp: missing `from` field, skipping');
      return res.status(200).send('ignored: no from');
    }

    if (!(await whatsapp.isEnabled(getDatabase()))) {
      console.log('onIncomingWhatsApp: whatsapp_enabled=false, no auto-reply');
      return res.status(200).send('ignored: disabled');
    }

    const intent = inbound.classify(body);
    const hours = inbound.getHoursStatus();
    console.log(`onIncomingWhatsApp: from=${fromPhoneRaw} intent=${intent} body="${body.substring(0, 80)}"`);

    let replyBody = null;

    try {
      if (intent === 'STATUS_CHECK') {
        // Look up active orders for this phone number. We match by suffix
        // because order.customer_phone may be stored with or without the "+"
        // and country code, while UltraMsg gives us the raw digits.
        const db = getDatabase();
        const ordersSnap = await db.ref('orders').once('value');
        const orders = ordersSnap.val() || {};
        const activeOrders = Object.values(orders).filter(o => {
          if (!o || !o.customer_phone) return false;
          const orderPhoneDigits = String(o.customer_phone).replace(/[^\d]/g, '');
          // Match by suffix (handles +504, 504, or just 8-digit local)
          if (!orderPhoneDigits.endsWith(fromPhoneRaw.slice(-8))
              && !fromPhoneRaw.endsWith(orderPhoneDigits.slice(-8))) {
            return false;
          }
          // Active = not delivered, not cancelled
          return o.status !== 'delivered' && o.status !== 'cancelled';
        });

        if (activeOrders.length > 0) {
          // Most recent active order
          activeOrders.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
          const order = activeOrders[0];
          if (order.tracking_token) {
            replyBody = inbound.tplStatusCheckFound({
              trackingToken: order.tracking_token,
              customerName: (order.customer_name || '').split(' ')[0]
            });
          } else {
            // No tracking token (legacy order) — fall back to generic reply
            replyBody = inbound.tplStatusCheckNotFound();
          }
        } else {
          replyBody = inbound.tplStatusCheckNotFound();
        }

      } else if (intent === 'GENERAL_INQUIRY') {
        replyBody = inbound.tplGeneralInquiry(hours);

      } else if (intent === 'SHORT_ACK') {
        replyBody = inbound.tplShortAck();

      } else {
        // UNHANDLED — log to /incoming_messages for dispatcher review
        replyBody = inbound.tplUnhandled(hours);
        try {
          const db = getDatabase();
          await db.ref('incoming_messages').push({
            from: fromPhoneRaw,
            body: body,
            time: data.time || Math.floor(Date.now() / 1000),
            handled: false,
            intent: 'UNHANDLED',
            received_at: ServerValue.TIMESTAMP
          });
        } catch (e) {
          console.warn('onIncomingWhatsApp: failed to log unhandled msg', e.message);
        }
      }

      if (replyBody) {
        await whatsapp.sendMessage(fromPhoneRaw, replyBody);
      }

    } catch (e) {
      console.error(`onIncomingWhatsApp: failed for from=${fromPhoneRaw}`, e.message);
      // Always 200 — UltraMsg retries on non-2xx
    }

    return res.status(200).send('ok');
  }
);

// ============================================================
// Auto-assignment configuration
// ============================================================
//
// Tunables for auto-assign behavior. Defaults match the design discussion:
//
// - GRACE_PERIOD_MS: how long to wait before auto-assign fires, giving the
//   dispatcher a chance to manually intervene first. Set to 30s.
//
// - STALE_PING_MS: drivers whose last_ping is older than this are considered
//   off the radar and skipped, even if their status says "available". Matches
//   the SDK's STALE_PING_THRESHOLD_S (90 sec) — keep them in sync.
//
// - RESTAURANT_LAT/LNG: hardcoded for now. Could read from /config later if
//   we ever support multiple stores.
//
// - STACKING_RULES:
//     * Driver with 0 active tasks: cap of 2 (can take this + 1 more later)
//     * Driver with 1 active task AND state in [available, at_restaurant]: cap 2
//     * Driver with 1 active task AND state == en_route_delivery: cap 1 (full)
//     * Driver with 2+ active tasks: skip (full)

const GRACE_PERIOD_MS = 30 * 1000;
const STALE_PING_MS = 90 * 1000;
const RESTAURANT_LAT = 15.507489753573818;
const RESTAURANT_LNG = -88.0398486953722;

// Acceptance timeout: how long a driver has to swipe-to-accept after assignment
// before the system reassigns to someone else. Same value used by driver UI
// for the visible countdown. Keep them in sync.
const ACCEPT_TIMEOUT_MS = 60 * 1000;

// Cooldown after a driver times out: they're filtered from auto-assign
// for this duration. Manual dispatcher assignment still works.
const TIMEOUT_COOLDOWN_MS = 3 * 60 * 1000;

// Max attempts to auto-reassign after timeouts. After this many strikes,
// dispatcher takes over. attempts=1 means initial assignment, attempts=2
// is the second-chance reassignment. Both timing out triggers the alert.
const MAX_ATTEMPTS_BEFORE_TAKEOVER = 2;

// Haversine distance in km between two lat/lng coords
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Compare two strings in constant time to prevent timing attacks against
// secret comparisons. Uses Node's crypto.timingSafeEqual after equalizing
// lengths. If lengths differ, returns false but still scans `b` to keep
// timing predictable.
function constantTimeEqual(a, b) {
  const crypto = require('crypto');
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a comparison against ourselves so timing is consistent
    crypto.timingSafeEqual(bBuf, bBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Status priority for picking. Lower number = preferred.
 * Used as a sort key BETWEEN orderCount and distanceKm:
 *   - at_restaurant: definitely at base, ready to grab pickup
 *   - available: idle, no current task (typically also at base, but
 *     could be remote if shift was started off-site before geofence trip)
 *   - returning: heading back, will arrive soon — should win over
 *     anyone still en route to a customer
 *   - assigned: has task, hasn't accepted yet (rare in pick context;
 *     mostly relevant when stacking onto same driver)
 *   - en_route_delivery: out delivering — last resort for stacking
 *   - on_break / unknown: deprioritize via the ?? 99 fallback
 */
const STATUS_PRIORITY = {
  at_restaurant: 0,
  available: 1,
  returning: 2,
  assigned: 3,
  en_route_delivery: 4
};

/**
 * Pick the best eligible driver based on:
 *   - On shift (last_ping within STALE_PING_MS, has lat/lng)
 *   - Not currently in timeout cooldown
 *   - Not in `excludeDriverIds` (used to skip the just-timed-out driver)
 *   - Has capacity per stacking rules
 *
 * Sort: fewest orders first, then status priority (at_restaurant beats
 * returning beats en_route_delivery), then distance to restaurant ascending.
 * Returns { driverId, name, distanceKm, orderCount, statusPriority } or null
 * if none eligible.
 *
 * Shared by autoAssignOnOrderCreate and monitorAssignmentTimeout to avoid
 * drift between initial-assign and reassign behavior.
 */
async function pickEligibleDriver(db, excludeDriverIds = []) {
  const [driversSnap, tasksSnap] = await Promise.all([
    db.ref('drivers').once('value'),
    db.ref('tasks').once('value')
  ]);
  const drivers = driversSnap.val() || {};
  const tasks = tasksSnap.val() || {};
  const now = Date.now();
  const excluded = new Set(excludeDriverIds);

  // Count active tasks per driver
  const activeTasksByDriver = {};
  for (const taskId of Object.keys(tasks)) {
    const t = tasks[taskId];
    if (!t.assigned_driver_id) continue;
    if (t.status === 'completed' || t.status === 'cancelled') continue;
    activeTasksByDriver[t.assigned_driver_id] = (activeTasksByDriver[t.assigned_driver_id] || 0) + 1;
  }
  // Note: order = pickup task + delivery task, so 1 active order = 2 active tasks.

  const eligible = [];
  for (const driverId of Object.keys(drivers)) {
    if (excluded.has(driverId)) continue;
    const d = drivers[driverId];
    if (!d) continue;

    // Eligibility: driver must be ON DUTY and REACHABLE via push.
    //
    // We don't filter on last_ping freshness anymore. Drivers in real
    // operation have their phone idle in pocket/on table — the PWA stops
    // pinging when the screen is off, but the push notification still wakes
    // them up. Filtering on stale GPS ping was excluding genuinely-on-duty
    // drivers. The acceptance-timeout system (60s + cascade) catches the
    // edge case where a driver's phone is actually dead.
    //
    // Required:
    //   - status not 'off_shift' (driver explicitly clocked in)
    //   - push_subscription on file (we can actually deliver them the order)
    //   - cooldown not active (last assignment didn't time out)
    //
    // Lat/lng absence is OK — used only for distance sort. If GPS is missing
    // we fall back to the restaurant location for sort distance, treating
    // the driver as if they're at the restaurant. They probably are if their
    // phone hasn't pinged.
    if (d.status === 'off_shift') continue;
    if (!d.push_subscription) continue;
    if (d.timeout_until && d.timeout_until > now) continue;

    const taskCount = activeTasksByDriver[driverId] || 0;
    const orderCount = Math.floor(taskCount / 2);

    // Stacking eligibility:
    //   - 0 orders: always eligible (cap 2, won't stack but reserves capacity)
    //   - 1 order: only stack if driver is PHYSICALLY AT the restaurant
    //              (state in [at_restaurant, available]). This means the
    //              second pizza can ride along with the first one — they
    //              haven't left yet. If the driver has already left
    //              (en_route_delivery, returning) or hasn't arrived yet
    //              (assigned), don't stack — the second pizza would either
    //              wait at the restaurant alone (bad) or force the driver
    //              to come back (worse).
    //   - 2+ orders: never stack
    let cap;
    if (orderCount === 0) {
      cap = 2;
    } else if (orderCount === 1
               && (d.status === 'at_restaurant' || d.status === 'available')) {
      cap = 2;
    } else {
      cap = orderCount;  // already at cap, will be filtered out below
    }
    if (orderCount >= cap) continue;

    // If GPS data missing/stale, treat driver as if at the restaurant
    // (distance = 0). Better than excluding them outright when their phone
    // just hasn't pinged in a while.
    let distanceKm;
    if (typeof d.lat === 'number' && typeof d.lng === 'number') {
      distanceKm = haversineKm(d.lat, d.lng, RESTAURANT_LAT, RESTAURANT_LNG);
    } else {
      distanceKm = 0;
    }
    const statusPriority = STATUS_PRIORITY[d.status] ?? 99;
    eligible.push({ driverId, orderCount, statusPriority, distanceKm, name: d.name || driverId });
  }

  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.orderCount !== b.orderCount) return a.orderCount - b.orderCount;
    if (a.statusPriority !== b.statusPriority) return a.statusPriority - b.statusPriority;
    return a.distanceKm - b.distanceKm;
  });
  return eligible[0];
}

/**
 * Build the atomic update for assigning an order's pickup+delivery tasks
 * to a driver. Sets assignment_deadline (used by timeout monitor + driver UI
 * countdown) and bumps assignment_attempts.
 *
 * @param isStacked  true when this driver already has an accepted/in-progress
 *                   order. Stacked orders skip the swipe-to-accept flow:
 *                   tasks start in 'accepted' status (not 'assigned'), so the
 *                   timeout monitor treats them as already-handled and the
 *                   driver UI renders them as queue cards (no countdown chip).
 *                   The driver implicitly accepted them by accepting the
 *                   active order; we don't want to demand a separate swipe
 *                   while they're delivering / driving.
 */
function buildAssignmentUpdates(orderId, driverId, attempts, isAutoAssigned, isStacked = false) {
  const now = Date.now();
  const deadline = now + ACCEPT_TIMEOUT_MS;
  const status = isStacked ? 'accepted' : 'assigned';
  const updates = {};
  for (const taskType of ['pickup', 'delivery']) {
    const taskId = `${orderId}_${taskType}`;
    updates[`tasks/${taskId}/assigned_driver_id`] = driverId;
    updates[`tasks/${taskId}/status`] = status;
    updates[`tasks/${taskId}/assigned_at`] = ServerValue.TIMESTAMP;
    if (isStacked) {
      // Skip deadline/attempts since acceptance is implicit and timeout
      // monitor doesn't fire (it only acts when status is 'assigned').
      updates[`tasks/${taskId}/accepted_at`] = ServerValue.TIMESTAMP;
    } else {
      updates[`tasks/${taskId}/assignment_deadline`] = deadline;
      updates[`tasks/${taskId}/assignment_attempts`] = attempts;
    }
    if (isAutoAssigned) {
      updates[`tasks/${taskId}/auto_assigned`] = true;
    }
  }
  return updates;
}

// ============================================================
// autoAssignOnOrderCreate — auto-assign delivery orders to closest driver
// ============================================================
//
// Fires when /orders/{orderId} is written. Waits 30 seconds (grace period
// for manual dispatcher intervention), then re-checks. If still unassigned
// AND auto-assign is globally enabled, picks the best eligible driver and
// assigns both pickup + delivery tasks atomically.
//
// If no eligible drivers exist, writes a /dispatcher_alerts/{id} record so
// the dispatcher's UI shows a banner + plays an alert sound.

exports.autoAssignOnOrderCreate = onValueWritten(
  {
    ref: '/orders/{orderId}',
    region: 'us-central1',
    timeoutSeconds: 90  // 30s sleep + ample headroom for the assignment query
  },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();

    // Only fire on CREATE (before == null), not on subsequent updates
    if (before !== null) return;
    if (!after) return;

    const orderId = event.params.orderId;

    // Skip non-delivery orders
    if (after.order_type && after.order_type !== 'delivery') {
      console.log(`autoAssign: skipping ${orderId} (order_type=${after.order_type})`);
      return;
    }

    console.log(`autoAssign: scheduling for order ${orderId}, waiting ${GRACE_PERIOD_MS}ms`);

    const db = getDatabase();
    await sleep(GRACE_PERIOD_MS);

    // Check global toggle
    const enabledSnap = await db.ref('config/auto_assign_enabled').once('value');
    if (enabledSnap.val() === false) {
      console.log(`autoAssign: skipping ${orderId} (globally disabled)`);
      return;
    }

    // Re-fetch the pickup task — manual assignment during grace?
    const pickupSnap = await db.ref(`tasks/${orderId}_pickup`).once('value');
    const pickup = pickupSnap.val();
    if (!pickup) {
      console.log(`autoAssign: pickup task not found for ${orderId}, skipping`);
      return;
    }
    if (pickup.assigned_driver_id) {
      console.log(`autoAssign: ${orderId} already assigned to ${pickup.assigned_driver_id} during grace`);
      return;
    }
    // Re-check the order itself — was it cancelled or otherwise progressed
    // during the 30s grace window? Without this, a dispatcher who cancels
    // a freshly-placed order in the first 30s would have it auto-assigned
    // anyway (cancelOrder updates status but doesn't touch
    // assigned_driver_id, so the check above passes). The task-status
    // check covers the same scenario from the task side.
    const orderSnap = await db.ref(`orders/${orderId}`).once('value');
    const orderNow = orderSnap.val();
    if (!orderNow) {
      console.log(`autoAssign: order ${orderId} disappeared during grace, skipping`);
      return;
    }
    if (orderNow.status !== 'new') {
      console.log(`autoAssign: ${orderId} status is now '${orderNow.status}' (not 'new'), skipping`);
      return;
    }
    if (pickup.status === 'cancelled') {
      console.log(`autoAssign: ${orderId} pickup task is cancelled, skipping`);
      return;
    }

    const chosen = await pickEligibleDriver(db);
    if (!chosen) {
      console.warn(`autoAssign: no eligible drivers for ${orderId}, alerting dispatcher`);
      await db.ref('dispatcher_alerts').push({
        type: 'no_drivers_available',
        order_id: orderId,
        customer_name: after.recipient_name || 'Cliente',
        total: after.total || null,
        created_at: ServerValue.TIMESTAMP
      });
      return;
    }

    console.log(`autoAssign: assigning ${orderId} → ${chosen.name} (${chosen.distanceKm.toFixed(2)}km, ${chosen.orderCount} active)`);

    // If chosen driver already has an active order, this is a STACK.
    // Stacked orders skip the swipe-to-accept flow (driver implicitly
    // accepted by accepting the active order). Tasks start in 'accepted'
    // state, no countdown chip on driver UI, no timeout monitor concerns.
    const isStacked = chosen.orderCount > 0;
    if (isStacked) {
      console.log(`autoAssign: ${orderId} is STACKED on ${chosen.name} (already has ${chosen.orderCount} active)`);
    }

    // attempts=1 = initial assignment. monitorAssignmentTimeout uses this
    // for its 2-strikes rule (only relevant for non-stacked).
    const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);
    try {
      await db.ref().update(updates);
      console.log(`autoAssign: success for ${orderId} → ${chosen.driverId}`);
    } catch (e) {
      console.error(`autoAssign: write failed for ${orderId}`, e);
    }
  }
);

// ============================================================
// monitorAssignmentTimeout — 60s acceptance timer + reassignment
// ============================================================
//
// Fires whenever a pickup task's assigned_driver_id changes (manual or auto).
// Sleeps for ACCEPT_TIMEOUT_MS, then checks if the driver accepted. If still
// in 'assigned' state, treats as a no-response timeout:
//   1. Marks the driver with a 3-min cooldown (timeout_until field)
//   2. If task already had MAX_ATTEMPTS_BEFORE_TAKEOVER strikes:
//      → unassign + alert dispatcher (human takeover needed)
//   3. Otherwise, picks a new driver (excluding the timed-out one) and
//      reassigns. attempts counter increments. Another timeout monitor
//      fires for that new assignment automatically.
//
// Designed to be safe on duplicate fires: if the task is already accepted/
// completed/cancelled when the timer wakes, it's a no-op.

exports.monitorAssignmentTimeout = onValueWritten(
  {
    // Only watches the assigned_driver_id of pickup tasks. Delivery tasks
    // get their assignment as part of the same atomic update, so we don't
    // need a separate timer for them — the driver acts on pickup first.
    ref: '/tasks/{taskId}/assigned_driver_id',
    region: 'us-central1',
    timeoutSeconds: 90
  },
  async (event) => {
    const taskId = event.params.taskId;
    if (!taskId.endsWith('_pickup')) return;  // only pickup tasks

    const before = event.data.before.val();
    const after = event.data.after.val();

    // Only act when assignment is SET (or CHANGED to a new driver).
    // Clearing (after == null) means dispatcher unassigned — no timer needed.
    if (!after) return;

    // If unchanged, ignore (defensive against duplicate writes)
    if (before === after) return;

    const driverId = after;
    const orderId = taskId.replace(/_pickup$/, '');

    // For stacked orders, the task is created with status 'accepted' directly
    // (not 'assigned'), so the timeout monitor isn't needed. Quick check up
    // front saves a 60-second sleep for nothing.
    const db0 = getDatabase();
    const initialTaskSnap = await db0.ref(`tasks/${taskId}`).once('value');
    const initialTask = initialTaskSnap.val();
    if (initialTask && initialTask.status === 'accepted') {
      console.log(`timeout-monitor: ${taskId} is stacked/already-accepted, skipping`);
      return;
    }

    console.log(`timeout-monitor: starting ${ACCEPT_TIMEOUT_MS}ms timer for ${taskId} → ${driverId}`);

    const db = getDatabase();
    await sleep(ACCEPT_TIMEOUT_MS);

    // Re-fetch the task — has anything changed during the wait?
    const taskSnap = await db.ref(`tasks/${taskId}`).once('value');
    const task = taskSnap.val();
    if (!task) {
      console.log(`timeout-monitor: task ${taskId} disappeared, no-op`);
      return;
    }

    // If still assigned to the same driver AND status is still 'assigned',
    // they didn't accept in time. Otherwise (driver changed, status changed),
    // either accepted, manually reassigned, or cancelled — no-op.
    if (task.assigned_driver_id !== driverId) {
      console.log(`timeout-monitor: ${taskId} reassigned during wait (was ${driverId}, now ${task.assigned_driver_id}), no-op`);
      return;
    }
    // Check the parent ORDER status too. cancelOrder() sets task.status to
    // 'cancelled' so the next check usually catches it, but if the task
    // status is somehow stale (race, partial write), the order check is a
    // hard backstop — never reassign a cancelled order to a new driver.
    const orderForTimeoutSnap = await db.ref(`orders/${orderId}`).once('value');
    const orderForTimeout = orderForTimeoutSnap.val();
    if (!orderForTimeout) {
      console.log(`timeout-monitor: order ${orderId} disappeared, no-op`);
      return;
    }
    if (orderForTimeout.status === 'cancelled') {
      console.log(`timeout-monitor: order ${orderId} is cancelled, no-op`);
      return;
    }
    if (task.status !== 'assigned') {
      console.log(`timeout-monitor: ${taskId} no longer 'assigned' (now ${task.status}), no-op`);
      return;
    }

    console.warn(`timeout-monitor: ${driverId} did not accept ${taskId} within ${ACCEPT_TIMEOUT_MS}ms, reassigning`);

    // Apply the cooldown to this driver. 3-minute global penalty box.
    const cooldownUntil = Date.now() + TIMEOUT_COOLDOWN_MS;
    await db.ref(`drivers/${driverId}/timeout_until`).set(cooldownUntil);

    // Decide: try one more driver, or escalate to dispatcher?
    const attempts = task.assignment_attempts || 1;

    if (attempts >= MAX_ATTEMPTS_BEFORE_TAKEOVER) {
      // Two strikes — human takeover. Unassign and alert.
      console.warn(`timeout-monitor: ${taskId} has ${attempts} attempts, escalating to dispatcher`);
      const orderSnap = await db.ref(`orders/${orderId}`).once('value');
      const order = orderSnap.val() || {};
      const updates = {};
      // Unassign both pickup and delivery so it shows up in SIN ASIGNAR
      for (const taskType of ['pickup', 'delivery']) {
        const tid = `${orderId}_${taskType}`;
        updates[`tasks/${tid}/assigned_driver_id`] = null;
        updates[`tasks/${tid}/status`] = 'pending';
        updates[`tasks/${tid}/assignment_deadline`] = null;
      }
      await db.ref().update(updates);
      await db.ref('dispatcher_alerts').push({
        type: 'no_response_takeover',
        order_id: orderId,
        customer_name: order.recipient_name || 'Cliente',
        total: order.total || null,
        attempts,
        created_at: ServerValue.TIMESTAMP
      });
      return;
    }

    // First-strike timeout → try one more driver, excluding the timed-out one
    const nextDriver = await pickEligibleDriver(db, [driverId]);
    if (!nextDriver) {
      console.warn(`timeout-monitor: no eligible drivers after ${driverId} timeout on ${orderId}, escalating`);
      const orderSnap = await db.ref(`orders/${orderId}`).once('value');
      const order = orderSnap.val() || {};
      const updates = {};
      for (const taskType of ['pickup', 'delivery']) {
        const tid = `${orderId}_${taskType}`;
        updates[`tasks/${tid}/assigned_driver_id`] = null;
        updates[`tasks/${tid}/status`] = 'pending';
        updates[`tasks/${tid}/assignment_deadline`] = null;
      }
      await db.ref().update(updates);
      await db.ref('dispatcher_alerts').push({
        type: 'no_drivers_available',
        order_id: orderId,
        customer_name: order.recipient_name || 'Cliente',
        total: order.total || null,
        created_at: ServerValue.TIMESTAMP
      });
      return;
    }

    console.log(`timeout-monitor: reassigning ${orderId} from ${driverId} → ${nextDriver.name} (attempt ${attempts + 1})`);
    const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);
    try {
      await db.ref().update(reassignUpdates);
      // The new assigned_driver_id write will trigger another monitorAssignmentTimeout
      // for the new driver. The notifyDriverOnAssignment trigger will push to them.
    } catch (e) {
      console.error(`timeout-monitor: reassignment write failed for ${orderId}`, e);
    }
  }
);
