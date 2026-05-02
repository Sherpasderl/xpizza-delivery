/**
 * X Pizza Delivery — Cloud Functions
 * version: 1.2.1
 *
 * Endpoints:
 *   - createOrder              (HTTPS)   — Make.com → Firebase write proxy
 *   - notifyDriverOnAssignment (DB trig) — Web Push to driver on assignment
 *   - onOrderCancelled         (DB trig) — Sync cancellations to KDS Sheet
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

exports.createOrder = onRequest(
  {
    region: 'us-central1',
    cors: false,           // server-to-server, no browser
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (req, res) => {
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

    try {
      await db.ref().update(updates);
      console.log(`createOrder: wrote order ${orderId}`);
      return res.status(200).json({ ok: true, order_id: orderId });
    } catch (e) {
      console.error('createOrder: write failed', e);
      return res.status(500).json({ error: 'Database write failed', detail: e.message });
    }
  }
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
