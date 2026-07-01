/**
 * X Pizza Delivery — Shared SDK
 * version: 1.10.0
 *
 * Used by the driver PWA, dispatcher view, and kitchen display.
 * Wraps Firebase Realtime Database with the operations needed
 * to run an in-house last-mile delivery operation.
 *
 * Usage:
 *   import { initDelivery, signIn, startShift, ... } from './xpizza-delivery.js';
 *   initDelivery(firebaseConfig);
 *   await signIn(email, password);
 *   await startShift(uid);
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getDatabase,
  ref,
  onValue,
  set,
  update,
  get,
  remove,
  serverTimestamp,
  off
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';

// ============================================================
// CONSTANTS
// ============================================================

export const RESTAURANT = {
  lat: 15.507489753573818,
  lng: -88.0398486953722,
  geofence_radius_m: 50,
  name: 'X Pizza',
  phone: '+50497952893'
};

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

// Payment axis (online orders) — orthogonal to order.status; never cross-tested.
export const PAYMENT_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  REFUND_PENDING: 'refund_pending'
};

// Charge-attempt axis (/payment_attempts/{id}).
export const PAYMENT_ATTEMPT_STATUS = {
  ACTIVE: 'active',
  APPROVED: 'approved',
  DECLINED: 'declined',
  ABANDONED: 'abandoned',
  CONVERTED: 'converted',
  VOIDED: 'voided',
  REFUNDED: 'refunded'
};

// Order statuses that are NOT operationally live (hidden from every /orders
// reader — KDS, dispatch, driver, dashboard — so an unpaid online order never
// appears as a real order). Live = anything not in this set.
export const NON_LIVE_ORDER_STATUSES = new Set([ORDER_STATUS.PENDING_PAYMENT]);

export function filterLiveOrders(orders) {
  const out = {};
  for (const id of Object.keys(orders || {})) {
    const o = orders[id];
    if (o && NON_LIVE_ORDER_STATUSES.has(o.status)) continue;
    out[id] = o;
  }
  return out;
}

const STALE_PING_THRESHOLD_S = 90;

/**
 * Acceptance timeout: how long a driver has to swipe-to-accept after the
 * task is assigned before the system reassigns. Exported because the driver
 * UI needs the same value for its visible countdown. Must match the value
 * in the Cloud Function's monitorAssignmentTimeout (ACCEPT_TIMEOUT_MS).
 */
export const ACCEPT_TIMEOUT_MS = 60 * 1000;

// ============================================================
// MODULE STATE
// ============================================================

let app, auth, db;

export function initDelivery(firebaseConfig) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
  return { app, auth, db };
}

export function getDb() { return db; }
export function getAuthInstance() { return auth; }

// ============================================================
// AUTH
// ============================================================

export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signOutUser() {
  return signOut(auth);
}

export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function isDispatcher(uid) {
  // Match the rules' .exists() check — be permissive about value type
  // (Firebase console may store as string "true" or boolean true depending on input)
  const snapshot = await get(ref(db, `dispatchers/${uid}`));
  if (!snapshot.exists()) return false;
  const v = snapshot.val();
  return v !== false && v !== null && v !== 0 && v !== '';
}

export async function isKitchen(uid) {
  // Same shape as isDispatcher — kitchen staff role membership lives at
  // /kitchen/{uid}, gated by Firebase rules. Used by the KDS to check
  // whether the signed-in user has permission to view + update orders.
  const snapshot = await get(ref(db, `kitchen/${uid}`));
  if (!snapshot.exists()) return false;
  const v = snapshot.val();
  return v !== false && v !== null && v !== 0 && v !== '';
}

// ============================================================
// DRIVER OPERATIONS
// ============================================================

export async function ensureDriverProfile(uid, name, phone) {
  // Create profile if missing; idempotent
  const driverRef = ref(db, `drivers/${uid}`);
  const snapshot = await get(driverRef);
  if (!snapshot.exists()) {
    await set(driverRef, {
      name,
      phone: phone || null,
      active: false,
      status: DRIVER_STATUS.OFF_SHIFT,
      lat: null,
      lng: null,
      last_ping: null,
      current_task_id: null,
      shift_started_at: null
    });
  }
}

export async function startShift(driverId) {
  await update(ref(db, `drivers/${driverId}`), {
    active: true,
    status: DRIVER_STATUS.AVAILABLE,
    shift_started_at: serverTimestamp(),
    last_ping: serverTimestamp(),
    current_task_id: null
  });
}

export async function endShift(driverId) {
  await update(ref(db, `drivers/${driverId}`), {
    active: false,
    status: DRIVER_STATUS.OFF_SHIFT,
    shift_ended_at: serverTimestamp()
  });
}

/**
 * Update driver location and run geofence transition logic.
 * Call this from `navigator.geolocation.watchPosition` callback.
 */
export async function updateDriverLocation(driverId, location) {
  const { lat, lng, accuracy, heading, speed } = location;
  await update(ref(db, `drivers/${driverId}`), {
    lat,
    lng,
    accuracy: accuracy ?? null,
    heading: heading ?? null,
    speed: speed ?? null,
    last_ping: serverTimestamp()
  });
  await checkGeofenceTransition(driverId, lat, lng);
}

async function checkGeofenceTransition(driverId, lat, lng) {
  const snapshot = await get(ref(db, `drivers/${driverId}`));
  const driver = snapshot.val();
  if (!driver) return;

  // Per-restaurant hub (S1): resolve the geofence target from the driver's server-written snapshot,
  // FAIL-CLOSED on an unresolvable or stale-versioned hub — mirrors ingestDriverLocation so the client
  // never fights the syncDriverHub trigger. x_pizza is unchanged (its hub == RESTAURANT to full precision).
  const ALLOWED_HUBS = { x_pizza: { lat: RESTAURANT.lat, lng: RESTAURANT.lng }, la_musa: { lat: 15.50414, lng: -88.03848 } };
  const HUB_EPS = 1e-6;
  const hubLat = driver.current_hub_lat ?? RESTAURANT.lat;
  const hubLng = driver.current_hub_lng ?? RESTAURANT.lng;
  const rid = driver.current_restaurant_id;
  const hubMatch = (h) => h && typeof hubLat === 'number' && typeof hubLng === 'number'
    && Math.abs(hubLat - h.lat) < HUB_EPS && Math.abs(hubLng - h.lng) < HUB_EPS;
  const hubResolvable = rid == null
    ? ((driver.current_hub_lat == null && driver.current_hub_lng == null) || hubMatch(ALLOWED_HUBS.x_pizza))
    : hubMatch(ALLOWED_HUBS[rid]);
  const versionCurrent = driver.current_hub_task_id == null
    || driver.current_hub_task_id === driver.current_task_id;
  if (!hubResolvable || !versionCurrent) return;   // fail-closed: skip rather than geofence a wrong/stale hub

  const distance = haversineDistance(lat, lng, hubLat, hubLng);
  const inGeofence = distance < RESTAURANT.geofence_radius_m;

  // Returning -> arrived at restaurant
  if (inGeofence && driver.status === DRIVER_STATUS.RETURNING) {
    await update(ref(db, `drivers/${driverId}`), {
      status: DRIVER_STATUS.AT_RESTAURANT,
      arrived_at_restaurant_at: serverTimestamp()
    });
    return;
  }

  // Assigned with task -> arrived at restaurant for pickup
  // (Driver still needs to manually tap "Picked Up" to advance to en_route_delivery,
  //  but dispatcher gets visual confirmation the driver has arrived for pickup.)
  if (inGeofence &&
      driver.status === DRIVER_STATUS.ASSIGNED &&
      driver.current_task_id) {
    await update(ref(db, `drivers/${driverId}`), {
      status: DRIVER_STATUS.AT_RESTAURANT,
      arrived_at_restaurant_at: serverTimestamp()
    });
    return;
  }

  // At restaurant with task -> en route (driver left geofence with active task,
  // implies they picked up and are heading to customer)
  if (!inGeofence &&
      driver.status === DRIVER_STATUS.AT_RESTAURANT &&
      driver.current_task_id) {
    await update(ref(db, `drivers/${driverId}`), {
      status: DRIVER_STATUS.EN_ROUTE_DELIVERY
    });
    return;
  }

  // At restaurant with no task -> available
  if (inGeofence && driver.status === DRIVER_STATUS.AT_RESTAURANT && !driver.current_task_id) {
    await update(ref(db, `drivers/${driverId}`), {
      status: DRIVER_STATUS.AVAILABLE
    });
  }
}

export async function setDriverStatus(driverId, status) {
  await update(ref(db, `drivers/${driverId}`), { status });
}

/**
 * Set the lifecycle status on an order. Used by:
 *   - Kitchen display: 'preparing' / 'ready' / (rarely) 'new'
 *   - Dispatcher: any value when manually overriding
 *   - SDK internals: 'out_for_delivery' / 'delivered' / 'cancelled'
 *
 * Firebase rules gate which roles can write which transitions. Kitchen
 * staff are allowed to write status, dispatchers are allowed any write,
 * drivers can write status only via their assigned tasks.
 */
export async function setOrderStatus(orderId, status) {
  await update(ref(db, `orders/${orderId}`), { status });
}

/**
 * Save a Web Push subscription against a driver record. Called from the driver
 * app after successfully subscribing via the service worker. The Cloud Function
 * `notifyDriverOnAssignment` reads this when a task gets assigned to send a push.
 *
 * Pass the `subscription.toJSON()` result, NOT the raw PushSubscription object
 * (which has methods that don't serialize cleanly to JSON).
 */
export async function savePushSubscription(driverId, subscriptionJSON) {
  await update(ref(db, `drivers/${driverId}`), {
    push_subscription: subscriptionJSON,
    push_subscription_updated_at: serverTimestamp()
  });
}

/**
 * Clear a driver's push subscription. Called when the driver explicitly
 * disables notifications, OR when the server discovers the subscription is
 * dead (410 Gone).
 */
export async function clearPushSubscription(driverId) {
  await update(ref(db, `drivers/${driverId}`), {
    push_subscription: null,
    push_subscription_updated_at: serverTimestamp()
  });
}

/**
 * Manual override: driver tells the system they've arrived at the restaurant.
 * Used as a fallback when GPS jitter or location issues prevent geofence detection.
 * Mirrors the geofence-driven transition: returning -> at_restaurant -> available (if no task).
 *
 * IMPORTANT: This only updates STATE (status, arrival timestamp). It does NOT touch
 * lat/lng or last_ping — those are managed by the real GPS stream. Lying about
 * location would create false dispatcher views; if the driver claims to be at the
 * restaurant but GPS shows otherwise, that's useful information for the dispatcher
 * (signals GPS issue or driver inaccuracy), not something we should hide.
 */
export async function arriveAtRestaurant(driverId) {
  const snapshot = await get(ref(db, `drivers/${driverId}`));
  const driver = snapshot.val();
  if (!driver) return;

  const updates = {
    arrived_at_restaurant_at: serverTimestamp()
  };

  if (driver.status === DRIVER_STATUS.RETURNING ||
      driver.status === DRIVER_STATUS.ASSIGNED) {
    updates.status = driver.current_task_id ? DRIVER_STATUS.AT_RESTAURANT : DRIVER_STATUS.AVAILABLE;
  }

  await update(ref(db, `drivers/${driverId}`), updates);
}

export async function acceptTask(driverId, taskId) {
  // Defensive check: refuse to accept a task that's been cancelled (or
  // moved past 'assigned' to anything else like another driver accepting
  // it via reassignment). The driver UI's task list filter usually hides
  // cancelled cards before the driver can tap, but there's a race window
  // (mid-swipe at moment of cancellation, offline-then-reconnect with
  // stale UI, etc.) where a tap could re-resurrect a cancelled task.
  const snap = await get(ref(db, `tasks/${taskId}`));
  const task = snap.val();
  if (!task) throw new Error('Este pedido ya no existe');
  if (task.status === TASK_STATUS.CANCELLED) {
    throw new Error('Este pedido fue cancelado');
  }
  if (task.status !== TASK_STATUS.ASSIGNED) {
    // Already accepted, completed, or in some other state — no-op
    throw new Error('Este pedido ya no está disponible');
  }

  const updates = {};
  updates[`tasks/${taskId}/status`] = TASK_STATUS.ACCEPTED;
  updates[`tasks/${taskId}/accepted_at`] = serverTimestamp();
  updates[`drivers/${driverId}/current_task_id`] = taskId;
  updates[`drivers/${driverId}/status`] = DRIVER_STATUS.ASSIGNED;
  await update(ref(db), updates);
}

export async function markTaskInProgress(driverId, taskId) {
  const updates = {};
  updates[`tasks/${taskId}/status`] = TASK_STATUS.IN_PROGRESS;
  updates[`drivers/${driverId}/status`] = DRIVER_STATUS.EN_ROUTE_DELIVERY;
  await update(ref(db), updates);
}

/**
 * Complete a task. For DELIVERY tasks: marks order delivered, transitions
 * driver state. With stacking support: if the driver has another delivery
 * task in 'accepted' state queued behind this one, they keep delivering
 * (current_task_id stays pointing at the next delivery, status stays
 * en_route_delivery). Only when ALL deliveries are done does the driver
 * transition to 'returning'.
 */
export async function completeTask(driverId, taskId) {
  const taskSnap = await get(ref(db, `tasks/${taskId}`));
  const task = taskSnap.val();
  if (!task) throw new Error('Esta tarea ya no existe');
  // Refuse if cancelled — without this guard, swiping "¡Entregado!" on a
  // cancelled delivery would resurrect the cancellation by setting the
  // order to DELIVERED. Same bug class as acceptTask + pickupComplete.
  if (task.status === TASK_STATUS.CANCELLED) {
    throw new Error('Este pedido fue cancelado');
  }

  const updates = {};
  updates[`tasks/${taskId}/status`] = TASK_STATUS.COMPLETED;
  updates[`tasks/${taskId}/completed_at`] = serverTimestamp();

  if (task && task.type === TASK_TYPE.DELIVERY) {
    if (task.order_id) {
      updates[`orders/${task.order_id}/status`] = ORDER_STATUS.DELIVERED;
      updates[`orders/${task.order_id}/delivered_at`] = serverTimestamp();
    }

    // Look for the next queued delivery for this driver — a delivery task
    // that's already 'accepted' (stacked) but not completed/cancelled.
    const allTasksSnap = await get(ref(db, 'tasks'));
    const allTasks = allTasksSnap.val() || {};
    let nextDeliveryId = null;
    let earliestCreated = Infinity;
    for (const [tid, t] of Object.entries(allTasks)) {
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

  await update(ref(db), updates);
}

// ============================================================
// DISPATCHER OPERATIONS
// ============================================================

export function subscribeToDrivers(callback) {
  const driversRef = ref(db, 'drivers');
  return onValue(driversRef, (snap) => callback(snap.val() || {}));
}

export function subscribeToTasks(callback) {
  const tasksRef = ref(db, 'tasks');
  return onValue(tasksRef, (snap) => callback(snap.val() || {}));
}

export function subscribeToOrders(callback) {
  const ordersRef = ref(db, 'orders');
  // Filter out non-live (e.g. unpaid pending_payment) orders centrally so no
  // reader ever shows an unpaid online order as a real order.
  return onValue(ordersRef, (snap) => callback(filterLiveOrders(snap.val() || {})));
}

/**
 * Dispatcher alerts: things the dispatcher needs to be notified about
 * (e.g., auto-assign couldn't find a driver). Each alert is a record
 * under /dispatcher_alerts/{alertId} that the dispatcher renders as a
 * banner + sound. Dispatcher calls dismissDispatcherAlert(alertId) to
 * clear it.
 */
export function subscribeToDispatcherAlerts(callback) {
  const alertsRef = ref(db, 'dispatcher_alerts');
  return onValue(alertsRef, (snap) => callback(snap.val() || {}));
}

export async function dismissDispatcherAlert(alertId) {
  await remove(ref(db, `dispatcher_alerts/${alertId}`));
}

/**
 * Customer WhatsApp messages received but not auto-handled by the classifier.
 * Logged by the onIncomingWhatsApp Cloud Function under /incoming_messages.
 * The dispatcher subscribes here to surface unhandled customer messages
 * (e.g., free-form questions, complaints) and can mark them handled once
 * they've replied (typically via WhatsApp Web).
 *
 * Each record looks like:
 *   {
 *     from: '50494738243',          // phone, no @c.us suffix
 *     body: 'do you have calzones?',// raw message body
 *     time: 1777914372,             // unix epoch seconds (from UltraMsg)
 *     received_at: 1777914372263,   // ms epoch (server timestamp)
 *     handled: false,               // flipped to true when dispatcher acknowledges
 *     intent: 'UNHANDLED' | 'non-chat',
 *     handled_at: ...,              // ms epoch, set when marked handled
 *     handled_by: 'uid'             // dispatcher UID who handled it
 *   }
 */
export function subscribeToIncomingMessages(callback) {
  const msgsRef = ref(db, 'incoming_messages');
  return onValue(msgsRef, (snap) => callback(snap.val() || {}));
}

export async function markMessageHandled(msgId, dispatcherUid) {
  await update(ref(db, `incoming_messages/${msgId}`), {
    handled: true,
    handled_at: Date.now(),
    handled_by: dispatcherUid || 'unknown'
  });
}

export async function markMessageUnhandled(msgId) {
  await update(ref(db, `incoming_messages/${msgId}`), {
    handled: false,
    handled_at: null,
    handled_by: null
  });
}

/**
 * Auto-assignment global toggle. When false, the autoAssignOnOrderCreate
 * Cloud Function still fires but bails immediately, leaving orders in
 * SIN ASIGNAR for manual handling. Defaults to TRUE if unset.
 */
export async function getAutoAssignEnabled() {
  const snap = await get(ref(db, 'config/auto_assign_enabled'));
  const val = snap.val();
  return val !== false;  // default ON
}

export async function setAutoAssignEnabled(enabled) {
  await set(ref(db, 'config/auto_assign_enabled'), !!enabled);
}

export function subscribeToAutoAssignEnabled(callback) {
  return onValue(ref(db, 'config/auto_assign_enabled'), (snap) => {
    const val = snap.val();
    callback(val !== false);  // default ON
  });
}

export async function assignTask(taskId, driverId) {
  const updates = {};
  updates[`tasks/${taskId}/assigned_driver_id`] = driverId;
  updates[`tasks/${taskId}/status`] = TASK_STATUS.ASSIGNED;
  updates[`tasks/${taskId}/assigned_at`] = serverTimestamp();
  updates[`tasks/${taskId}/assignment_deadline`] = Date.now() + ACCEPT_TIMEOUT_MS;
  updates[`tasks/${taskId}/assignment_attempts`] = 1;
  await update(ref(db), updates);
}

/**
 * Assign both pickup + delivery tasks of an order to a driver in one atomic write.
 *
 * If the driver already has an active accepted/in-progress order, this is a STACK:
 * the new task is marked 'accepted' immediately (skipping the swipe-to-accept
 * step), since the driver implicitly accepted by accepting the prior order.
 * Otherwise it's a normal assignment with the 60s acceptance window.
 *
 * Manual assignments via dispatcher follow the same rules as auto-assignments.
 *
 * @param allTasks Optional snapshot of all tasks. If provided, used to detect
 *                 stacking. If omitted, this function does a fresh read to check.
 */
export async function assignOrderToDriver(orderId, driverId, allTasks = null) {
  // S2 same-hub stacking: force-accept (direct 'accepted', no swipe/timeout) ONLY when the driver
  // already has an accepted/in-progress order at the SAME restaurant hub as this new order. A cross-hub
  // manual assign stays 'assigned' (swipe-to-accept) — never force-accepted. Hub resolver mirrors
  // driver-ingest/stacking-helpers (X_PIZZA_HUB == seed to full precision; 1e-6 epsilon): legacy no-hub
  // x_pizza → X. Pizza fallback (unchanged); known non-x_pizza with a bad hub → null (fail-closed).
  if (!allTasks) {
    const tasksSnap = await get(ref(db, 'tasks'));
    allTasks = tasksSnap.val() || {};
  }
  const HUB_EPS = 1e-6;
  const ALLOWED_HUBS = { x_pizza: { lat: 15.507489753573818, lng: -88.0398486953722 }, la_musa: { lat: 15.50414, lng: -88.03848 } };
  const coordsMatch = (h, lat, lng) => typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat - h.lat) < HUB_EPS && Math.abs(lng - h.lng) < HUB_EPS;
  const resolvePickupHub = (pk) => {
    if (!pk) return null;
    const rid = pk.restaurant_id, lat = pk.destination_lat, lng = pk.destination_lng;
    const numeric = typeof lat === 'number' && typeof lng === 'number';
    if (rid == null || rid === 'x_pizza') return numeric ? (coordsMatch(ALLOWED_HUBS.x_pizza, lat, lng) ? { lat, lng } : null) : { lat: ALLOWED_HUBS.x_pizza.lat, lng: ALLOWED_HUBS.x_pizza.lng };
    const canon = ALLOWED_HUBS[rid];
    return (canon && numeric && coordsMatch(canon, lat, lng)) ? { lat, lng } : null;
  };
  const newHub = resolvePickupHub(allTasks[`${orderId}_pickup`]);
  let isStacked = false;
  for (const t of Object.values(allTasks)) {
    if (!t || t.assigned_driver_id !== driverId) continue;
    if (t.status !== TASK_STATUS.ACCEPTED && t.status !== TASK_STATUS.IN_PROGRESS) continue;
    const h = resolvePickupHub(allTasks[`${t.order_id}_pickup`]);
    if (newHub && h && Math.abs(newHub.lat - h.lat) < HUB_EPS && Math.abs(newHub.lng - h.lng) < HUB_EPS) { isStacked = true; break; }
  }

  const pickupTaskId = `${orderId}_pickup`;
  const deliveryTaskId = `${orderId}_delivery`;
  const updates = {};

  if (isStacked) {
    // Stacked: mark accepted directly, no countdown / timeout
    for (const tid of [pickupTaskId, deliveryTaskId]) {
      updates[`tasks/${tid}/assigned_driver_id`] = driverId;
      updates[`tasks/${tid}/status`] = TASK_STATUS.ACCEPTED;
      updates[`tasks/${tid}/assigned_at`] = serverTimestamp();
      updates[`tasks/${tid}/accepted_at`] = serverTimestamp();
    }
  } else {
    // Normal: assigned status, deadline, attempts counter
    const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
    for (const tid of [pickupTaskId, deliveryTaskId]) {
      updates[`tasks/${tid}/assigned_driver_id`] = driverId;
      updates[`tasks/${tid}/status`] = TASK_STATUS.ASSIGNED;
      updates[`tasks/${tid}/assigned_at`] = serverTimestamp();
      updates[`tasks/${tid}/assignment_deadline`] = deadline;
      updates[`tasks/${tid}/assignment_attempts`] = 1;
    }
  }
  await update(ref(db), updates);
}

/**
 * Reassign an order to a different driver. Cleans up the old driver's
 * current_task_id if it pointed to this order, and resets task statuses
 * so the new driver has to accept fresh. Resets the timeout deadline + attempts
 * counter — manual reassign by dispatcher is treated as a fresh attempt.
 */
export async function reassignOrder(orderId, newDriverId) {
  const pickupTaskId = `${orderId}_pickup`;
  const deliveryTaskId = `${orderId}_delivery`;
  const pickupSnap = await get(ref(db, `tasks/${pickupTaskId}`));
  const pickup = pickupSnap.val();
  if (!pickup) throw new Error(`Order ${orderId} not found`);

  const oldDriverId = pickup.assigned_driver_id;
  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;

  const updates = {};
  // Reset both tasks to assigned, clear acceptance timestamps
  updates[`tasks/${pickupTaskId}/assigned_driver_id`] = newDriverId;
  updates[`tasks/${pickupTaskId}/status`] = TASK_STATUS.ASSIGNED;
  updates[`tasks/${pickupTaskId}/assigned_at`] = serverTimestamp();
  updates[`tasks/${pickupTaskId}/accepted_at`] = null;
  updates[`tasks/${pickupTaskId}/assignment_deadline`] = deadline;
  updates[`tasks/${pickupTaskId}/assignment_attempts`] = 1;
  updates[`tasks/${deliveryTaskId}/assigned_driver_id`] = newDriverId;
  updates[`tasks/${deliveryTaskId}/status`] = TASK_STATUS.ASSIGNED;
  updates[`tasks/${deliveryTaskId}/assigned_at`] = serverTimestamp();
  updates[`tasks/${deliveryTaskId}/accepted_at`] = null;
  updates[`tasks/${deliveryTaskId}/assignment_deadline`] = deadline;
  updates[`tasks/${deliveryTaskId}/assignment_attempts`] = 1;

  // If old driver was working this order, clear their current_task_id
  if (oldDriverId && oldDriverId !== newDriverId) {
    const oldDriverSnap = await get(ref(db, `drivers/${oldDriverId}`));
    const oldDriver = oldDriverSnap.val();
    if (oldDriver) {
      const wasWorkingThis = oldDriver.current_task_id === pickupTaskId ||
                             oldDriver.current_task_id === deliveryTaskId;
      if (wasWorkingThis) {
        updates[`drivers/${oldDriverId}/current_task_id`] = null;
        // Demote status if they were assigned/at_restaurant for this order
        if (oldDriver.status === DRIVER_STATUS.ASSIGNED ||
            oldDriver.status === DRIVER_STATUS.AT_RESTAURANT ||
            oldDriver.status === DRIVER_STATUS.EN_ROUTE_DELIVERY) {
          updates[`drivers/${oldDriverId}/status`] = DRIVER_STATUS.AVAILABLE;
        }
      }
    }
  }

  await update(ref(db), updates);
}

/**
 * Cancel an order. Marks order + both tasks as cancelled. Clears the
 * assigned driver's current_task_id if they were working this order.
 */
export async function cancelOrder(orderId, reason = '') {
  const pickupTaskId = `${orderId}_pickup`;
  const deliveryTaskId = `${orderId}_delivery`;
  const pickupSnap = await get(ref(db, `tasks/${pickupTaskId}`));
  const pickup = pickupSnap.val();

  const updates = {};
  updates[`orders/${orderId}/status`] = ORDER_STATUS.CANCELLED;
  updates[`orders/${orderId}/cancelled_at`] = serverTimestamp();
  if (reason) updates[`orders/${orderId}/cancel_reason`] = reason;
  updates[`tasks/${pickupTaskId}/status`] = TASK_STATUS.CANCELLED;
  updates[`tasks/${deliveryTaskId}/status`] = TASK_STATUS.CANCELLED;

  // Clear the assigned driver's current_task_id if they were working this
  if (pickup && pickup.assigned_driver_id) {
    const driverSnap = await get(ref(db, `drivers/${pickup.assigned_driver_id}`));
    const driver = driverSnap.val();
    if (driver) {
      const wasWorkingThis = driver.current_task_id === pickupTaskId ||
                             driver.current_task_id === deliveryTaskId;
      if (wasWorkingThis) {
        updates[`drivers/${pickup.assigned_driver_id}/current_task_id`] = null;
        if (driver.status === DRIVER_STATUS.ASSIGNED ||
            driver.status === DRIVER_STATUS.AT_RESTAURANT ||
            driver.status === DRIVER_STATUS.EN_ROUTE_DELIVERY) {
          updates[`drivers/${pickup.assigned_driver_id}/status`] = DRIVER_STATUS.AVAILABLE;
        }
      }
    }
  }

  await update(ref(db), updates);
}

/**
 * Driver taps "Recogí pedido" (picked up the bag at the restaurant).
 * Atomically: completes the pickup task, accepts the delivery task,
 * sets driver's current_task to the delivery task, marks order out_for_delivery.
 */
/**
 * Complete a pickup task. The driver swiped "I have the pizza" at the
 * restaurant. This:
 *   - Marks the pickup task COMPLETED
 *   - Promotes the linked delivery task to ACCEPTED (driver heads to customer)
 *   - Updates the order to OUT_FOR_DELIVERY, sets picked_up_at
 *   - Sets driver's current_task_id to the delivery
 *
 * If the driver has STACKED orders (additional accepted orders for them),
 * those pickups are ALSO completed in the same atomic write — driver
 * physically picked up all pizzas in one trip to the kitchen, so all stacked
 * pickups should transition together. The system tracks delivery-by-delivery
 * separately; the driver's getDriverOrders sort handles "what to deliver next."
 */
export async function pickupComplete(driverId, pickupTaskId) {
  const pickupSnap = await get(ref(db, `tasks/${pickupTaskId}`));
  const pickupTask = pickupSnap.val();
  if (!pickupTask) throw new Error(`Pickup task ${pickupTaskId} not found`);
  if (pickupTask.type !== TASK_TYPE.PICKUP) {
    throw new Error(`Task ${pickupTaskId} is not a pickup task`);
  }
  // Refuse if cancelled — driver should never mark a cancelled order as
  // picked up. Without this guard, swiping "Recogí pedido" on a cancelled
  // order would set the order to OUT_FOR_DELIVERY, undoing the cancellation.
  if (pickupTask.status === TASK_STATUS.CANCELLED) {
    throw new Error('Este pedido fue cancelado');
  }

  // Look for stacked pickups: other pending pickup tasks assigned to this
  // same driver. They get auto-completed in the same atomic write.
  const allTasksSnap = await get(ref(db, 'tasks'));
  const allTasks = allTasksSnap.val() || {};
  const stackedPickupIds = [];
  for (const [tid, t] of Object.entries(allTasks)) {
    if (tid === pickupTaskId) continue;
    if (!t || t.assigned_driver_id !== driverId) continue;
    if (t.type !== TASK_TYPE.PICKUP) continue;
    // Only auto-complete pickups that are accepted but not yet completed
    if (t.status === TASK_STATUS.ACCEPTED || t.status === TASK_STATUS.IN_PROGRESS) {
      stackedPickupIds.push(tid);
    }
  }

  const deliveryTaskId = pickupTask.linked_task_id;
  const updates = {};

  // Complete the active pickup
  updates[`tasks/${pickupTaskId}/status`] = TASK_STATUS.COMPLETED;
  updates[`tasks/${pickupTaskId}/completed_at`] = serverTimestamp();
  updates[`tasks/${deliveryTaskId}/status`] = TASK_STATUS.ACCEPTED;
  updates[`tasks/${deliveryTaskId}/accepted_at`] = serverTimestamp();
  updates[`drivers/${driverId}/current_task_id`] = deliveryTaskId;
  // The pickup swipe is what moves the driver to en_route — closes the order-
  // stacking window at the moment they leave with the pizza, independent of the
  // (background-fragile) geofence. See ADR 0004. The geofence exit transition
  // remains a redundant backstop for PWA/foreground.
  updates[`drivers/${driverId}/status`] = DRIVER_STATUS.EN_ROUTE_DELIVERY;

  if (pickupTask.order_id) {
    updates[`orders/${pickupTask.order_id}/status`] = ORDER_STATUS.OUT_FOR_DELIVERY;
    updates[`orders/${pickupTask.order_id}/picked_up_at`] = serverTimestamp();
  }

  // Auto-complete stacked pickups + promote their delivery tasks
  for (const stackedPickupId of stackedPickupIds) {
    const stackedPickup = allTasks[stackedPickupId];
    const stackedDeliveryId = stackedPickup.linked_task_id;
    updates[`tasks/${stackedPickupId}/status`] = TASK_STATUS.COMPLETED;
    updates[`tasks/${stackedPickupId}/completed_at`] = serverTimestamp();
    if (stackedDeliveryId) {
      updates[`tasks/${stackedDeliveryId}/status`] = TASK_STATUS.ACCEPTED;
      // Don't overwrite accepted_at if already set (it was set when stacked)
    }
    if (stackedPickup.order_id) {
      updates[`orders/${stackedPickup.order_id}/status`] = ORDER_STATUS.OUT_FOR_DELIVERY;
      updates[`orders/${stackedPickup.order_id}/picked_up_at`] = serverTimestamp();
    }
  }

  await update(ref(db), updates);
}

/**
 * Group a driver's tasks by order_id and compute the current phase for each.
 * Returns an array of { orderId, phase, pickupTask, deliveryTask, order } sorted
 * by which the driver should work on next.
 *
 * Phases:
 *   'awaiting_acceptance' — both tasks assigned, none accepted yet
 *   'pickup'              — pickup accepted/in_progress, delivery still waiting
 *   'delivery'            — pickup completed, delivery accepted/in_progress
 *   'completed'           — delivery completed (filtered out by default)
 */
export function getDriverOrders(driverId, allTasks, allOrders, includeCompleted = false) {
  const grouped = {};
  Object.entries(allTasks).forEach(([taskId, t]) => {
    if (t.assigned_driver_id !== driverId) return;
    if (!grouped[t.order_id]) grouped[t.order_id] = {};
    if (t.type === TASK_TYPE.PICKUP) grouped[t.order_id].pickup = { ...t, id: taskId };
    if (t.type === TASK_TYPE.DELIVERY) grouped[t.order_id].delivery = { ...t, id: taskId };
  });

  const result = [];
  for (const [orderId, pair] of Object.entries(grouped)) {
    const { pickup, delivery } = pair;
    if (!pickup || !delivery) continue; // skip malformed pairs

    // Skip cancelled orders — driver should never see them
    if (pickup.status === TASK_STATUS.CANCELLED || delivery.status === TASK_STATUS.CANCELLED) continue;

    let phase;
    if (delivery.status === TASK_STATUS.COMPLETED) phase = 'completed';
    else if (pickup.status === TASK_STATUS.COMPLETED) phase = 'delivery';
    else if (pickup.status === TASK_STATUS.ACCEPTED || pickup.status === TASK_STATUS.IN_PROGRESS) phase = 'pickup';
    else phase = 'awaiting_acceptance';

    if (phase === 'completed' && !includeCompleted) continue;

    result.push({
      orderId,
      phase,
      pickupTask: pickup,
      deliveryTask: delivery,
      order: allOrders[orderId] || null
    });
  }

  // Sort: in-progress orders first, then by created_at
  const phaseRank = { delivery: 0, pickup: 1, awaiting_acceptance: 2, completed: 3 };
  result.sort((a, b) => {
    const r = phaseRank[a.phase] - phaseRank[b.phase];
    if (r !== 0) return r;
    return (a.deliveryTask.created_at || 0) - (b.deliveryTask.created_at || 0);
  });

  return result;
}

/**
 * Atomically create an order with linked pickup + delivery tasks.
 * Mirrors the Onfleet two-task model.
 */
export async function createOrderWithTasks(order) {
  const orderId = order.order_id;
  const pickupTaskId = `${orderId}_pickup`;
  const deliveryTaskId = `${orderId}_delivery`;

  const updates = {};

  updates[`orders/${orderId}`] = {
    ...order,
    status: ORDER_STATUS.NEW,
    pickup_task_id: pickupTaskId,
    delivery_task_id: deliveryTaskId,
    created_at: serverTimestamp()
  };

  updates[`tasks/${pickupTaskId}`] = {
    order_id: orderId,
    restaurant_id: 'x_pizza',   // S1: dead/inert writer (x_pizza-hardcoded) — stamp for consistency (Codex-flagged surface)
    type: TASK_TYPE.PICKUP,
    status: TASK_STATUS.PENDING,
    assigned_driver_id: null,
    linked_task_id: deliveryTaskId,
    depends_on_task_id: null,
    destination_lat: RESTAURANT.lat,
    destination_lng: RESTAURANT.lng,
    destination_address: RESTAURANT.name,
    recipient_name: RESTAURANT.name,
    recipient_phone: RESTAURANT.phone,
    notes: order.items_text || '',
    created_at: serverTimestamp()
  };

  updates[`tasks/${deliveryTaskId}`] = {
    order_id: orderId,
    type: TASK_TYPE.DELIVERY,
    status: TASK_STATUS.PENDING,
    assigned_driver_id: null,
    linked_task_id: pickupTaskId,
    depends_on_task_id: pickupTaskId,
    destination_lat: order.lat,
    destination_lng: order.lng,
    destination_address: order.address_detected || '',
    address_details: order.address_details || '',
    recipient_name: order.customer_name,
    recipient_phone: order.customer_phone,
    payment_method: order.payment_method,
    total: order.total,
    notes: order.items_text || '',
    created_at: serverTimestamp()
  };

  await update(ref(db), updates);
  return { orderId, pickupTaskId, deliveryTaskId };
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * Distance between two lat/lng points in meters.
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function isStalePing(lastPingTimestamp, thresholdSeconds = STALE_PING_THRESHOLD_S) {
  if (!lastPingTimestamp) return true;
  return (Date.now() - lastPingTimestamp) / 1000 > thresholdSeconds;
}

export function formatStaleness(lastPingTimestamp) {
  if (!lastPingTimestamp) return 'never';
  const ageSec = Math.floor((Date.now() - lastPingTimestamp) / 1000);
  if (ageSec < 5) return 'live';
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  return `${Math.floor(ageMin / 60)}h ago`;
}

export function formatStatus(status) {
  return {
    off_shift: 'Off shift',
    available: 'Available',
    assigned: 'Assigned',
    at_restaurant: 'At restaurant',
    en_route_delivery: 'En route',
    returning: 'Returning',
    on_break: 'On break'
  }[status] || status;
}
