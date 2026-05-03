/**
 * X Pizza Delivery — Cloud Functions
 * version: 1.5.1
 *
 * Endpoints:
 *   - createOrder              (HTTPS)   — Make.com → Firebase write proxy
 *   - notifyDriverOnAssignment (DB trig) — Web Push to driver on assignment
 *   - onOrderCancelled         (DB trig) — Sync cancellations to KDS Sheet
 *   - autoAssignOnOrderCreate  (DB trig) — Auto-pick driver after grace period (with continuous-at-restaurant stacking)
 *   - monitorAssignmentTimeout (DB trig) — Reassign on 60s no-accept timeout
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

/**
 * Pick the best eligible driver based on:
 *   - On shift (last_ping within STALE_PING_MS, has lat/lng)
 *   - Not currently in timeout cooldown
 *   - Not in `excludeDriverIds` (used to skip the just-timed-out driver)
 *   - Has capacity per stacking rules
 *
 * Sort: 0-task drivers first, then by distance to restaurant ascending.
 * Returns { driverId, name, distanceKm, orderCount } or null if none eligible.
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
    if (d.status === 'off_shift') continue;
    if (!d.last_ping || (now - d.last_ping) > STALE_PING_MS) continue;
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') continue;
    // Respect cooldown from prior timeout
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

    const distanceKm = haversineKm(d.lat, d.lng, RESTAURANT_LAT, RESTAURANT_LNG);
    eligible.push({ driverId, orderCount, distanceKm, name: d.name || driverId });
  }

  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.orderCount !== b.orderCount) return a.orderCount - b.orderCount;
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
