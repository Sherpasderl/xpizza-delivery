/**
 * X Pizza Delivery — Cloud Functions
 * version: 1.8.0
 *
 * Endpoints:
 *   - createOrder                   (HTTPS)   — Make.com → Firebase write proxy + WhatsApp "received"
 *   - chargeOnlineOrder             (HTTPS)   — PixelPay online card: pending-first order + signed sale config (Stage 3b)
 *   - confirmOnlinePayment          (HTTPS)   — PixelPay capture + materialize (auth→capture confirm, Stage 4)
 *   - pixelPayWebhook               (HTTPS)   — PixelPay order_callback nudge → confirm (Stage 4)
 *   - sweepStalePending             (sched)   — confirm/abandon backstop for missed nudges (Stage 4)
 *   - reconcilePayments             (sched)   — daily money-safety invariant audit (Stage 4)
 *   - resolveManualReconciliation   (HTTPS)   — audited dispatcher resolver for manual_reconciliation (Stage 4)
 *   - materializeOnConfirm          (DB trig) — re-materialize a confirmed-but-unmaterialized order (Stage 4)
 *   - cancelPaidOrder               (HTTPS)   — dispatcher void/refund + cancel of a paid online order (Stage 6)
 *   - refundReconciler              (sched)   — retry aged refund_pending voids (Stage 6)
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
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { beforeUserCreated, HttpsError } = require('firebase-functions/v2/identity');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const webpush = require('web-push');
const { google } = require('googleapis');
const express = require('express');
const whatsapp = require('./whatsapp');
const { resolvePixelPayConfig, pixelPayCallbackUrl, pixelPayChargeAmountLempiras } = require('./pixelpay-config');
const pixelpayClient = require('./pixelpay-client');
const ppCrypto = require('./pixelpay');
const { confirmOnlinePayment, confirmAndMaterialize } = require('./pixelpay-confirm');
const { buildMaterializeUpdates } = require('./materialize');
const { extractWebhookNudge, classifySweepCandidate } = require('./pixelpay-webhook');
const { voidOrRefund } = require('./pixelpay-cancel');

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

// Authorize a dispatcher money-action (cancelPaidOrder / resolveManualReconciliation).
// Accepts EITHER:
//   (a) the server-only RECON_SECRET as the bearer token — CLI / server-to-server, OR
//   (b) a Firebase ID token belonging to a registered dispatcher — the dashboard
//       browser path: verify the token, then check /dispatchers/{uid}.
// RECON_SECRET is NEVER shipped to the browser; the browser uses path (b) so no
// money-moving secret ever leaves the server. The dispatcher path is independent of
// RECON_SECRET, so these actions still work from the dashboard even if the secret is
// unset. Returns { ok:true, actor } (actor = verified email, or 'recon_secret') or
// { ok:false, code, msg }. constantTimeEqual is length-safe, so a long JWT presented
// as the token simply fails path (a) and falls through to verification.
async function authorizeDispatcherAction(req) {
  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { ok: false, code: 401, msg: 'missing bearer token' };

  const SECRET = process.env.RECON_SECRET;
  if (SECRET && constantTimeEqual(token, SECRET)) {
    return { ok: true, actor: 'recon_secret' };
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (_) {
    return { ok: false, code: 401, msg: 'invalid credentials' };
  }
  const snap = await getDatabase().ref(`dispatchers/${decoded.uid}`).once('value');
  if (!snap.exists()) return { ok: false, code: 403, msg: 'not authorized (dispatcher only)' };
  return { ok: true, actor: decoded.email || decoded.uid };
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

// Allowed payment methods — mirror the order form's options.
const ALLOWED_PAYMENT_METHODS = ['cash', 'card_delivery', 'online'];

// ---------------------------------------------------------------------------
// Server-side price tables — the SOURCE OF TRUTH for an order's total.
//
// The order TOTAL is recomputed here from these tables, NOT trusted from the
// client. A tampered client (the order-intake secret is, by necessity, public
// in the browser) could otherwise POST total:1 for any order. MUST be kept in
// sync with MENU / EXTRAS in xpizza-orders/index.html (same contract as the
// RESTAURANT coords). Keyed by the exact item/extra `name` the form sends.
// ---------------------------------------------------------------------------
const MENU_PRICES = {
  'Sopressatta Chili Honey': 385, 'Carnivora': 340, 'Crispy Bacon': 337,
  'Sweet Corn & Calabrian Chili': 314, 'Mushroom': 323, 'Spinach': 307,
  'Pancetta Vodka Sauce': 328, 'Margherita': 299, 'Pepperoni': 307,
  'Anchovies': 418, 'Shrimp Scampi': 412, 'Pistaccio Mortadella': 409,
  'Prosciutto': 402, 'Potato & Dill Sausage': 299, 'Cacio e Pepe': 297,
  'Ham': 282, 'Nutella': 251,
  'Carnivora NY': 685, 'Margherita NY': 624, 'Cacio e Pepe NY': 641,
  'Mushroom NY': 702, 'Jamon o Pepperoni NY': 641, 'Crispy Bacon NY': 662
};
const EXTRA_PRICES = {
  'Salsa Roja': 39, 'Salsa Blanca': 39, 'Salsa Calabrian Chili': 49,
  'Mozzarella': 50, 'Whipped Ricotta': 65, 'Salchicha Italiana': 50,
  'Pepperoni': 50, 'Jamón': 39, 'Prosciutto': 94, 'Mortadella': 85,
  'Espinaca': 33, 'Maíz': 45, 'Hongos': 61, 'Basil Pesto': 33
};

// Strip HTML-significant + control chars and cap length. Defense-in-depth vs
// stored XSS: even if a downstream HTML sink forgets to escape, no tag can be
// injected because '<'/'>' never reach storage. We STRIP (not HTML-entity-
// encode) so plain-text consumers (WhatsApp) stay readable.
function sanitizeText(v, maxLen = 500) {
  let s = (v == null ? '' : String(v));
  s = s.replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// Normalize a phone to digits (optional leading +). Returns '' if it doesn't
// look like a phone (8–15 digits) so the caller can reject it.
function sanitizePhone(v) {
  const raw = String(v == null ? '' : v).trim();
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return plus + digits;
}

// Recompute the order total from the server price tables. Returns
// { total, error }. Rejects unknown item/extra names (= tampering) and absurd
// quantities. Extras are a 0/1 toggle in the form, so each entry counts once.
function computeServerTotal(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { total: NaN, error: 'items must be a non-empty array' };
  }
  let total = 0;
  for (const it of items) {
    const name = it && it.name;
    const qty = Number(it && it.qty);
    if (!name || !Object.prototype.hasOwnProperty.call(MENU_PRICES, name)) {
      return { total: NaN, error: `unknown menu item: ${String(name).slice(0, 40)}` };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      return { total: NaN, error: `invalid quantity for ${name}` };
    }
    total += MENU_PRICES[name] * qty;
    const extras = Array.isArray(it.extras) ? it.extras : [];
    for (const ex of extras) {
      const ename = ex && ex.name;
      if (!ename || !Object.prototype.hasOwnProperty.call(EXTRA_PRICES, ename)) {
        return { total: NaN, error: `unknown extra: ${String(ename).slice(0, 40)}` };
      }
      total += EXTRA_PRICES[ename];
    }
  }
  return { total, error: null };
}

// ---------------------------------------------------------------------------
// Canonical money. `total_cents` (integer HNL centavos) is the source of truth
// for charges + comparisons. ISV 15% is tax-INCLUSIVE: the menu price IS what
// the customer pays, so we break the tax OUT of the total with a fixed rounding
// rule that guarantees subtotal_cents + tax_cents === total_cents exactly.
// (Stored on EVERY order — cash too — so the factura/SAR system has the breakdown.)
// ---------------------------------------------------------------------------
function priceBreakdownCents(totalLempiras) {
  const total_cents = Math.round(Number(totalLempiras) * 100);
  const tax_cents = Math.round(total_cents - total_cents / 1.15);
  const subtotal_cents = total_cents - tax_cents;
  return { total_cents, subtotal_cents, tax_cents };
}

function validateOrderPayload(body) {
  const errors = [];
  const required = ['order_id', 'customer_name', 'customer_phone', 'items_text', 'order_type'];
  for (const f of required) {
    if (body[f] == null || body[f] === '') errors.push(`Missing required field: ${f}`);
  }

  // order_id is used directly in RTDB paths — restrict to a safe charset/length.
  if (body.order_id != null && !/^[A-Za-z0-9_-]{1,64}$/.test(String(body.order_id))) {
    errors.push('order_id has invalid format');
  }

  const lat = asNumber(body.lat);
  const lng = asNumber(body.lng);

  // Recompute total server-side — NEVER trust body.total.
  const { total, error: totalError } = computeServerTotal(body.items);
  if (totalError) errors.push(totalError);

  if (body.order_type === 'delivery') {
    if (!isFiniteNumber(lat) || lat < -90 || lat > 90) errors.push('lat must be a valid latitude');
    if (!isFiniteNumber(lng) || lng < -180 || lng > 180) errors.push('lng must be a valid longitude');
  }

  if (body.order_type !== 'delivery' && body.order_type !== 'pickup') {
    errors.push('order_type must be "delivery" or "pickup"');
  }

  // Sanitize every free-text field (defense-in-depth vs stored XSS + length caps).
  const phone = sanitizePhone(body.customer_phone);
  if (body.customer_phone && !phone) errors.push('customer_phone must be 8–15 digits');

  let payment = sanitizeText(body.payment_method, 30);
  if (payment && !ALLOWED_PAYMENT_METHODS.includes(payment)) payment = '';

  const fields = {
    customer_name: sanitizeText(body.customer_name, 80),
    customer_phone: phone,
    items_text: sanitizeText(body.items_text, 1500),
    notes: sanitizeText(body.notes, 500),
    payment_method: payment,
    address_detected: sanitizeText(body.address_detected, 300),
    address_details: sanitizeText(body.address_details, 300),
    pickup_time: sanitizeText(body.pickup_time, 40) || 'standard'
  };

  return { errors, total, lat, lng, fields };
}

// ---------------------------------------------------------------------------
// Rate limiting for the public createOrder endpoint.
//
// The order-intake bearer secret is, by design, public in the browser, so
// createOrder must defend itself as a public endpoint. These fixed-window
// counters live in RTDB so they're shared across all function instances — an
// in-memory limiter would be useless because Cloud Functions scale out to many
// instances, each with its own memory. The /rate_limits subtree is written
// only by this function (Admin SDK) and is default-denied to all clients (no
// rule grants access), so no security-rule change is needed.
//
// Calibrated to a single low-volume restaurant: generous for real customers,
// throttling for spam. NOTE: many Honduran mobile users share a carrier-grade
// NAT IP, so the IP bucket is a coarse flood-guard only — the per-PHONE bucket
// is the primary control. Tune to operational reality.
// ---------------------------------------------------------------------------
const RATE_LIMIT_BUCKETS = {
  ip:    { windowMs: 10 * 60 * 1000, max: 20 },  // coarse flood guard (CGNAT-aware)
  phone: { windowMs: 10 * 60 * 1000, max: 4 },   // primary: new orders per phone / 10 min
  confirm_ip: { windowMs: 10 * 60 * 1000, max: 80 } // confirm/poll guard: each payment does
                                                    // ~1 confirm (+ a few polls on 202), so this
                                                    // caps capture-hammering without blocking legit polling
};

// Hash a rate-limit key (IP / phone) into an RTDB-safe, non-PII key. Avoids
// storing raw IPs/phones under /rate_limits and dodges forbidden key chars
// ('.', ':', '+', etc).
function rateLimitKey(raw) {
  return require('crypto').createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);
}

// Fixed-window rate limit backed by an atomic RTDB transaction (correct across
// concurrent instances). Returns { allowed, retryAfterSec }. FAILS OPEN on any
// DB error — for a small shop a transient RTDB hiccup must never block a real
// customer's order; abuse during such a window is the lesser harm.
async function checkRateLimit(db, bucket, rawKey, cfg) {
  if (!rawKey) return { allowed: true, retryAfterSec: 0 };
  const ref = db.ref(`rate_limits/${bucket}/${rateLimitKey(rawKey)}`);
  const now = Date.now();
  try {
    const res = await ref.transaction((cur) => {
      if (!cur || now - cur.window_start >= cfg.windowMs) {
        return { count: 1, window_start: now };   // new window
      }
      if (cur.count >= cfg.max) {
        return;                                    // over limit → abort (no write)
      }
      return { count: cur.count + 1, window_start: cur.window_start };
    });
    if (res.committed) return { allowed: true, retryAfterSec: 0 };
    const v = res.snapshot.val();
    const retryAfterSec = v
      ? Math.max(1, Math.ceil((v.window_start + cfg.windowMs - now) / 1000))
      : 1;
    return { allowed: false, retryAfterSec };
  } catch (e) {
    console.error(`checkRateLimit: ${bucket} transaction failed (failing open)`, e.message);
    return { allowed: true, retryAfterSec: 0 };
  }
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

  // Best-effort client IP for rate limiting. X-Forwarded-For's left-most entry
  // is client-supplied (spoofable), so IP limiting is a soft control only — the
  // per-phone limit below is the stronger signal. Good enough as a flood guard.
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip || 'unknown';

  // Parse + validate
  const body = req.body || {};
  const { errors, total, lat, lng, fields } = validateOrderPayload(body);
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

  // Rate limiting. Only genuinely-NEW orders reach here — idempotent retries of
  // an existing order_id already returned above, so legit retries don't burn
  // budget. Reject before the expensive multi-path write + WhatsApp send.
  for (const [bucket, key, cfg] of [
    ['ip', clientIp, RATE_LIMIT_BUCKETS.ip],
    ['phone', fields.customer_phone, RATE_LIMIT_BUCKETS.phone]
  ]) {
    const { allowed, retryAfterSec } = await checkRateLimit(db, bucket, key, cfg);
    if (!allowed) {
      console.warn(`createOrder: rate limit (${bucket}) hit for order ${orderId}, retry ${retryAfterSec}s`);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too Many Requests',
        detail: `Rate limit exceeded; retry in ${retryAfterSec}s`
      });
    }
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

  // Build the order record. Common fields apply to both delivery and pickup;
  // delivery-specific fields (lat/lng/address, task IDs) only get included
  // for delivery orders. Pickup orders get pickup_time instead.
  const orderRecord = {
    order_id: orderId,
    customer_name: fields.customer_name,
    customer_phone: fields.customer_phone,
    items_text: fields.items_text,
    total: total,
    ...priceBreakdownCents(total),   // total_cents / subtotal_cents / tax_cents (ISV 15% incl.)
    notes: fields.notes,
    payment_method: fields.payment_method,
    order_type: orderType,
    status: 'new',
    tracking_token: trackingToken,
    created_at: now
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
    // pickup
    // pickup_time is either the literal string 'standard' (= ASAP, ~20 min)
    // or a human-readable label like '6:00 PM–6:20 PM' selected by the
    // customer. Stored as opaque string; KDS displays it as-is.
    orderRecord.pickup_time = fields.pickup_time;
  }

  updates[`orders/${orderId}`] = orderRecord;

  // Driver tasks ONLY for delivery orders. Pickup orders are picked up by
  // the customer at the restaurant — no driver involved, no dispatch.
  if (orderType === 'delivery') {
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
      notes: fields.items_text,
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
      destination_address: fields.address_detected,
      address_details: fields.address_details,
      recipient_name: fields.customer_name,
      recipient_phone: fields.customer_phone,
      payment_method: fields.payment_method,
      total: total,
      notes: fields.items_text,
      created_at: now
    };
  }

  // Tracking index: maps tracking_token → order data. Stores ONLY the
  // fields that are safe to expose publicly. The tracking site reads
  // /order_tracking/{token} (public read rule). Customer name + first
  // initial of address are shown but full address, phone, payment details
  // stay in /orders (auth-only).
  //
  // Status field is kept in sync with /orders/{orderId}/status by
  // sendOrderStatusNotifications. driver_name is filled in when
  // out_for_delivery (delivery orders only).
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
    created_at: now
  };

  try {
    await db.ref().update(updates);
    console.log(`createOrder: wrote ${orderType} order ${orderId}`);
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
      // Pickup vs delivery have different copy. Pickup says "te avisamos
      // cuando esté listo para recoger" instead of "en camino". Delivery
      // template is unchanged.
      let waBody;
      if (orderType === 'pickup') {
        waBody = whatsapp.tplPickupReceived({
          customerName: String(updates[`orders/${orderId}`].customer_name || ''),
          orderId,
          itemsText: String(updates[`orders/${orderId}`].items_text || ''),
          total,
          pickupTime: String(updates[`orders/${orderId}`].pickup_time || 'standard'),
          trackingToken
        });
      } else {
        waBody = whatsapp.tplOrderReceived({
          customerName: String(updates[`orders/${orderId}`].customer_name || ''),
          orderId,
          itemsText: String(updates[`orders/${orderId}`].items_text || ''),
          total,
          trackingToken
        });
      }
      await whatsapp.sendMessage(updates[`orders/${orderId}`].customer_phone, waBody);
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
    cors: true,            // browser-callable — order form posts directly (no Make.com relay)
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 10       // blast-radius cap: the intake secret is public, so bound
                           // how much concurrent order-spam can fan out. Tune up if
                           // real peak traffic ever approaches this.
  },
  createOrderApp
);

// ============================================================
// chargeOnlineOrder — open an online-payment attempt (AUTH+CAPTURE)
// ============================================================
//
// The pending-first entry point for PIXELPAY online card orders. It is the ONLY
// writer that creates an online order, and it writes it as a HIDDEN `pending_payment`
// order with NO tasks/tracking — those are materialized only after the payment is
// server-CAPTURED + confirmed (confirmOnlinePayment). This function NEVER calls
// PixelPay and returns NO signature: the browser SDK runs a 3DS AUTH with the public
// app_key + auth_hash, and the server confirms authoritatively later via doCapture.
//
// Money-safety (see PAYMENT-PLAN.md invariants I1-I8):
//   - A single CAS transaction on orders/{id} installs `active_attempt_id` — the
//     atomic charge lock — so two concurrent submits can't open two attempts.
//   - Each attempt is bound to PixelPay by `pixelpay_order_id = ${order_id}-${attempt_id}`,
//     which the browser auths and the server captures, so a late/old/second auth is
//     distinguishable at capture time and can't be mistaken for the active one.
//   - An economic `payment_fingerprint` (order_id + total_cents + items) is
//     pinned on first write; a later call with the same order_id but a different
//     cart/total is rejected 409 (can't mutate the charged amount).
//   - Recovery: if `active_attempt_id` is set but the attempt record is missing
//     (crash between the order write and the attempt write), we recreate THAT
//     attempt id — never mint a second one (Codex R4 caution #3).
//
// Auth + abuse posture mirrors createOrder: same public bearer secret, same
// IP+phone rate-limit buckets. The pure helpers (attempt acquisition, fingerprint,
// money conversion) live in ./pixelpay-charge so they're unit-testable in isolation.
const { orderFingerprint, centsToLempiras } = require('./pixelpay-charge');
const { acquireHostedAttempt } = require('./pixelpay-hosted-charge');
const { createHostedCharge, formatPixelPayExpiry } = require('./pixelpay-hosted');

const chargeOnlineApp = express();

chargeOnlineApp.all('*', async (req, res) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Same public bearer secret as createOrder (it's by-design public in the
  // browser; the rate limiter + server-recomputed total are the real defense).
  const SECRET = process.env.MAKE_SECRET;
  if (!SECRET) {
    console.error('chargeOnlineOrder: MAKE_SECRET not set — refusing all requests');
    return unauthorized(res, 'server misconfigured');
  }
  const authHeader = req.get('authorization') || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!presented || !constantTimeEqual(presented, SECRET)) {
    console.warn('chargeOnlineOrder: bad/missing bearer token');
    return unauthorized(res, 'invalid bearer token');
  }

  const body = req.body || {};
  const { errors, total, lat, lng, fields } = validateOrderPayload(body);
  if (errors.length > 0) return badRequest(res, errors.join('; '));

  // This endpoint is ONLY for online card payments. cash/card_delivery use createOrder.
  if (fields.payment_method !== 'online') {
    return badRequest(res, 'chargeOnlineOrder is for payment_method "online" only');
  }

  const orderId = String(body.order_id);
  const orderType = body.order_type;

  // Delivery-zone enforcement (same as createOrder — clients are bypassable).
  if (orderType === 'delivery') {
    const distanceKm = haversineKm(lat, lng, RESTAURANT.lat, RESTAURANT.lng);
    if (distanceKm > DELIVERY_RADIUS_KM) {
      return badRequest(res, `Outside delivery zone (${distanceKm.toFixed(1)}km from restaurant, max ${DELIVERY_RADIUS_KM}km)`);
    }
  }

  // Resolve PixelPay config up front — fail fast (500) before any DB write if
  // production creds are missing, so we never open an attempt we can't sign.
  let pp;
  try {
    pp = resolvePixelPayConfig();
  } catch (e) {
    console.error('chargeOnlineOrder: PixelPay config error', e.message);
    return res.status(500).json({ error: 'Payment not configured', detail: e.message });
  }

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const db = getDatabase();

  // Rate limit (same buckets as createOrder). A genuine retry of an in-flight
  // submit re-enters acquireHostedAttempt and reuses the live checkout, so this throttles
  // distinct submit bursts, not 3DS polling.
  for (const [bucket, key, cfg] of [
    ['ip', clientIp, RATE_LIMIT_BUCKETS.ip],
    ['phone', fields.customer_phone, RATE_LIMIT_BUCKETS.phone]
  ]) {
    const { allowed, retryAfterSec } = await checkRateLimit(db, bucket, key, cfg);
    if (!allowed) {
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too Many Requests', detail: `Rate limit exceeded; retry in ${retryAfterSec}s` });
    }
  }

  const { total_cents, subtotal_cents, tax_cents } = priceBreakdownCents(total);
  const fingerprint = orderFingerprint(orderId, total_cents, fields.items_text);

  // The HIDDEN pending order. Mirrors createOrder's orderRecord (so Stage-4
  // confirm can materialize tasks/tracking from it) but status=pending_payment,
  // payment_status=pending, and NO tasks/tracking/WhatsApp yet.
  const now = ServerValue.TIMESTAMP;
  const pendingOrderRecord = {
    order_id: orderId,
    customer_name: fields.customer_name,
    customer_phone: fields.customer_phone,
    items_text: fields.items_text,
    total: total,
    total_cents, subtotal_cents, tax_cents,   // ISV 15% inclusive breakdown
    notes: fields.notes,
    payment_method: 'online',
    payment_status: 'pending',
    order_type: orderType,
    status: 'pending_payment',
    created_at: now
  };
  if (orderType === 'delivery') {
    pendingOrderRecord.lat = lat;
    pendingOrderRecord.lng = lng;
    pendingOrderRecord.address_detected = fields.address_detected;
    pendingOrderRecord.address_details = fields.address_details;
    pendingOrderRecord.maps_link = `https://www.google.com/maps?q=${lat},${lng}`;
  } else {
    pendingOrderRecord.pickup_time = fields.pickup_time;
  }

  // Acquire the hosted-charge lock + attempt (create-claim state machine; HOSTED-PAYMENT-PLAN.md).
  let acq;
  try {
    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, Date.now());
  } catch (e) {
    console.error(`chargeOnlineOrder: hosted acquire failed for ${orderId}`, e.message);
    return res.status(500).json({ error: 'Database error', detail: e.message });
  }

  if (acq.outcome === 'already_paid') {
    return res.status(409).json({ error: 'Already paid', detail: 'This order is already confirmed paid', order_id: orderId });
  }
  if (acq.outcome === 'conflict') {
    return res.status(409).json({ error: 'Order conflict', detail: 'order_id already used for a different cart/total', order_id: orderId });
  }
  if (acq.outcome === 'closed') {
    return res.status(409).json({ error: 'Order closed', detail: `order is ${acq.reason}; please start a new order`, order_id: orderId });
  }
  if (acq.outcome === 'in_progress') {
    // A checkout is being created for this order — don't start a 2nd (one-live-checkout, I10).
    return res.status(202).json({ ok: true, status: 'in_progress', detail: 'a checkout is being created; retry shortly', order_id: orderId });
  }
  // Double-submit while a checkout is still live → return the SAME url (I10).
  if (acq.outcome === 'reuse') {
    console.log(`chargeOnlineOrder: reuse live hosted checkout ${orderId}-${acq.attempt_id}`);
    return res.status(200).json({ ok: true, order_id: orderId, attempt_id: acq.attempt_id, poll_token: acq.poll_token, checkout_url: acq.checkout_url, payment_status: 'pending' });
  }
  if (acq.outcome !== 'claimed') {
    return res.status(503).json({ error: 'Could not start payment', detail: 'please retry', order_id: orderId });
  }

  // We own a FRESH attempt in hosted_state:'creating' (hosted_order_id already persisted by the
  // claim, so a racing paid callback can still bind/recover — I7). Create the hosted checkout with
  // the SERVER-SET amount, then mark the attempt 'created'.
  const attemptId = acq.attempt_id;
  const pixelpayOrderId = acq.hosted_order_id;            // `${orderId}-${attemptId}`
  const pollToken = acq.poll_token;
  const amountStr = centsToLempiras(total_cents);          // real server total (NOT the sandbox 1-14 map) so the callback amount-check holds

  // PixelPay requires first+last name and a valid email.
  const nameParts = String(fields.customer_name).trim().split(/\s+/);
  const firstName = nameParts[0] || 'Cliente';
  const lastName = nameParts.slice(1).join(' ') || firstName;
  const rawEmail = body.customer_email;
  const email = (typeof rawEmail === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail.trim())) ? rawEmail.trim() : 'pedidos@xpizza.hn';

  // Customer-facing return URLs + the AUTHENTICATED server callback (?secret=…).
  const appBase = String(pp.app_url || '').replace(/\/+$/, '');
  const completeUrl = `${appBase}/?pay=complete&order=${encodeURIComponent(orderId)}&t=${encodeURIComponent(pollToken)}`;
  const cancelUrl = `${appBase}/?pay=cancel&order=${encodeURIComponent(orderId)}`;
  const wsecret = process.env.PIXELPAY_WEBHOOK_SECRET || '';
  if (!wsecret) console.warn('chargeOnlineOrder: PIXELPAY_WEBHOOK_SECRET not set — hosted callback will be unauthenticated');
  const callbackUrl = pixelPayCallbackUrl() + (wsecret ? `?secret=${encodeURIComponent(wsecret)}` : '');

  let hosted;
  try {
    hosted = await createHostedCharge({
      pixelpayOrderId, amountLempiras: amountStr,
      firstName, lastName, email,
      completeUrl, cancelUrl, callbackUrl,
      expiresAt: formatPixelPayExpiry(acq.expires_at)
    });
  } catch (e) {
    console.error(`chargeOnlineOrder: hosted create threw for ${pixelpayOrderId}`, e.message);
    await db.ref(`payment_attempts/${attemptId}`).update({ hosted_state: 'failed_create', failed_create_reason: 'network', updated_at: now }).catch(() => {});
    return res.status(502).json({ error: 'Payment gateway error', detail: 'could not create checkout; please retry', order_id: orderId });
  }

  if (!hosted.ok || !hosted.url) {
    console.error(`chargeOnlineOrder: hosted create rejected for ${pixelpayOrderId}`, JSON.stringify(hosted.errors || hosted.raw || {}).slice(0, 400));
    await db.ref(`payment_attempts/${attemptId}`).update({ hosted_state: 'failed_create', failed_create_reason: JSON.stringify(hosted.errors || {}).slice(0, 300), updated_at: now }).catch(() => {});
    return res.status(502).json({ error: 'Payment gateway error', detail: 'checkout not created; please retry', order_id: orderId });
  }

  // Persist the live checkout URL + mark 'created' (payable until expires_at).
  await db.ref(`payment_attempts/${attemptId}`).update({ hosted_state: 'created', hosted_checkout_url: hosted.url, updated_at: now });

  console.log(`chargeOnlineOrder: created hosted checkout ${pixelpayOrderId} (mode=${pp.mode}, ${amountStr} HNL)`);
  return res.status(200).json({
    ok: true,
    order_id: orderId,
    attempt_id: attemptId,
    pixelpay_order_id: pixelpayOrderId,
    poll_token: pollToken,
    checkout_url: hosted.url,
    payment_status: 'pending'
  });
});

chargeOnlineApp.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn(`chargeOnlineOrder: malformed JSON — ${err.message}`);
    return res.status(400).json({ error: 'Bad Request', detail: 'Malformed JSON in request body' });
  }
  // eslint-disable-next-line no-unused-vars
  next(err);
});

exports.chargeOnlineOrder = onRequest(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 10
  },
  chargeOnlineApp
);

// ============================================================
// confirmOnlinePayment — Stage 4 sub-stage 2: capture + materialize
// ============================================================
//
// The browser POSTs its 3DS-auth `payment_uuid` here (best-effort; the webhook is
// the durable trigger). This drives the SERVER-authoritative confirm: capture the
// auth hold for our server-set amount, verify the capture response, then materialize
// the pending_payment order into a live `new` order. Idempotent + recovery-aware
// (see pixelpay-confirm.js / PAYMENT-PLAN §B/§C). Safe to call repeatedly — the
// capturing-claim prevents double-capture and confirmed orders short-circuit.
//
// `now` is Date.now() (a real number) because the capturing-claim staleness math
// needs arithmetic; stored timestamps are function-clock ms (NTP-synced).

// Write a dispatcher alert (best-effort) for money-safety events that need a human.
async function paymentAlert(db, kind, detail) {
  console.warn(`paymentAlert[${kind}]`, JSON.stringify(detail));
  try {
    await db.ref('dispatcher_alerts').push({
      type: `payment_${kind}`,
      detail: detail || null,
      created_at: ServerValue.TIMESTAMP
    });
  } catch (e) {
    console.error('paymentAlert: failed to write alert', e.message);
  }
}

const confirmOnlineApp = express();

confirmOnlineApp.all('*', async (req, res) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const SECRET = process.env.MAKE_SECRET;
  if (!SECRET) {
    console.error('confirmOnlinePayment: MAKE_SECRET not set');
    return unauthorized(res, 'server misconfigured');
  }
  const authHeader = req.get('authorization') || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!presented || !constantTimeEqual(presented, SECRET)) {
    return unauthorized(res, 'invalid bearer token');
  }

  const body = req.body || {};
  const orderId = String(body.order_id || '');
  const paymentUuid = body.payment_uuid == null ? null : String(body.payment_uuid);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return badRequest(res, 'order_id has invalid format');
  if (paymentUuid && !/^[A-Za-z0-9_:-]{1,80}$/.test(paymentUuid)) return badRequest(res, 'payment_uuid has invalid format');

  // Resolve PixelPay config up front (fail fast on misconfig before any capture).
  try {
    resolvePixelPayConfig();
  } catch (e) {
    console.error('confirmOnlinePayment: PixelPay config error', e.message);
    return res.status(500).json({ error: 'Payment not configured', detail: e.message });
  }

  const db = getDatabase();

  // Rate-limit (IP bucket) so the capture path can't be hammered to exhaust the PixelPay
  // API / rack up cost. Sized to allow normal confirm + 202-polling (see RATE_LIMIT_BUCKETS).
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const { allowed, retryAfterSec } = await checkRateLimit(db, 'confirm_ip', clientIp, RATE_LIMIT_BUCKETS.confirm_ip);
  if (!allowed) {
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'Too Many Requests', detail: `Rate limit exceeded; retry in ${retryAfterSec}s` });
  }

  const deps = confirmDeps(db);   // shared deps (incl. config-aware chargeAmountLempiras)

  let result;
  try {
    result = await confirmOnlinePayment(deps, {
      orderId,
      paymentUuid,
      now: Date.now(),
      trackingToken: generateTrackingToken()
    });
  } catch (e) {
    console.error(`confirmOnlinePayment: error for ${orderId}`, e);
    return res.status(500).json({ error: 'Confirm failed', detail: e.message });
  }

  console.log(`confirmOnlinePayment: ${orderId} → ${result.outcome}`);

  // Map the state-machine outcome to an HTTP response. The order form ALSO polls
  // /orders/{id}/payment_status; this response just speeds up the common cases.
  const o = result.outcome;
  if (o === 'confirmed' || o === 'already_confirmed') {
    return res.status(200).json({ ok: true, payment_status: 'confirmed', order_id: orderId, tracking_token: result.tracking_token || null });
  }
  if (o === 'manual_reconciliation') {
    return res.status(200).json({ ok: true, payment_status: 'manual_reconciliation', order_id: orderId });
  }
  if (o === 'capture_failed' || o === 'failed' || o === 'mismatch_voided') {
    return res.status(200).json({ ok: false, payment_status: o === 'mismatch_voided' ? 'failed' : 'failed', order_id: orderId, detail: result.message || result.reason || 'payment not completed' });
  }
  if (o === 'cancelled' || o === 'cancelled_during_confirm') {
    return res.status(200).json({ ok: false, payment_status: 'cancelled', order_id: orderId });
  }
  if (o === 'in_progress' || o === 'capture_error_retryable' || o === 'no_payment_uuid') {
    return res.status(202).json({ ok: false, pending: true, order_id: orderId, detail: 'payment processing; keep polling' });
  }
  if (o === 'no_order') return res.status(404).json({ error: 'Order not found', order_id: orderId });
  if (o === 'not_online' || o === 'no_active_attempt' || o === 'no_attempt_record') {
    return res.status(409).json({ error: 'Order not in a payable state', detail: o, order_id: orderId });
  }
  // Unknown/unexpected → 202 so the client keeps polling RTDB rather than failing hard.
  return res.status(202).json({ ok: false, pending: true, order_id: orderId, detail: o });
});

confirmOnlineApp.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Bad Request', detail: 'Malformed JSON in request body' });
  }
  // eslint-disable-next-line no-unused-vars
  next(err);
});

exports.confirmOnlinePayment = onRequest(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 60,   // capture is a network round-trip to PixelPay; give it room
    memory: '256MiB',
    maxInstances: 10
  },
  confirmOnlineApp
);

// Shared deps + entrypoint for the confirm machine (used by webhook + sweep).
function confirmDeps(db) {
  return {
    db,
    client: pixelpayClient,
    restaurant: RESTAURANT,
    buildMaterializeUpdates,
    // Config-aware capture amount: sandbox → 1-14 test amount; production → real total.
    chargeAmountLempiras: (totalCents) => {
      try { return pixelPayChargeAmountLempiras(resolvePixelPayConfig(), totalCents); }
      catch (_) { return Number((Number(totalCents) / 100).toFixed(2)); }
    },
    voidOrRefund,   // cancel-vs-confirm race guard (I8)
    alert: (kind, detail) => paymentAlert(db, kind, detail)
  };
}
function runConfirm(db, orderId, paymentUuid) {
  return confirmOnlinePayment(confirmDeps(db), { orderId, paymentUuid, now: Date.now(), trackingToken: generateTrackingToken() });
}

// ============================================================
// pixelPayWebhook — Stage 4 sub-stage 3: durable confirm nudge
// ============================================================
//
// PixelPay's order_callback posts here when a transaction settles. The webhook is
// a NUDGE ONLY: we extract the order + (claimed) payment_uuid and run the SERVER-
// authoritative confirm (which re-verifies via doCapture), so a malformed/forged
// payload can never cause a bad confirm. We dedupe by event id in /webhook_events
// and ALWAYS return 200 (never trigger a PixelPay retry storm — the confirm is
// idempotent and the sweep is the backstop). A shared-secret query param is
// checked as defense-in-depth when configured.
exports.pixelPayWebhook = onRequest(
  { region: 'us-central1', cors: false, timeoutSeconds: 60, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).send('Method Not Allowed'); }

    // Defense-in-depth: if PIXELPAY_WEBHOOK_SECRET is set, require it (?secret= or header).
    // Mismatch → 200 + ignore (don't 401, to avoid retry storms; the sweep still recovers).
    const expected = process.env.PIXELPAY_WEBHOOK_SECRET;
    if (expected) {
      const presented = (req.query && req.query.secret) || req.get('x-webhook-secret') || '';
      if (!presented || !constantTimeEqual(String(presented), expected)) {
        console.warn('pixelPayWebhook: bad/missing shared secret, ignoring nudge');
        return res.status(200).json({ ok: true, ignored: 'auth' });
      }
    }

    const nudge = extractWebhookNudge(req.body || {});
    // The webhook body is attacker-influenceable; orderId is used in an RTDB ref path.
    // Require the safe charset before touching the DB (defense-in-depth; the confirm is
    // already nudge-only + re-verified, but never let an unvalidated value reach a ref).
    if (!nudge.orderId || !/^[A-Za-z0-9_-]{1,64}$/.test(nudge.orderId)) {
      console.warn('pixelPayWebhook: missing/invalid order id in payload', JSON.stringify(req.body || {}).slice(0, 500));
      return res.status(200).json({ ok: true, ignored: 'no_order' });
    }
    if (nudge.paymentUuid && !/^[A-Za-z0-9_:-]{1,80}$/.test(nudge.paymentUuid)) {
      return res.status(200).json({ ok: true, ignored: 'bad_uuid' });
    }

    const db = getDatabase();

    // Idempotency: claim /webhook_events/{eventId} (processing→done|failed). A
    // recently-done/processing event is skipped (PixelPay retry). Fails OPEN — if
    // the claim errors we still run the (idempotent) confirm.
    const eventId = rateLimitKey(nudge.eventId || `${nudge.orderId}:${nudge.paymentUuid || ''}`);
    try {
      const claim = await db.ref(`webhook_events/${eventId}`).transaction((cur) => {
        if (cur && cur.state === 'done') return;                                   // already handled
        if (cur && cur.state === 'processing' && Date.now() - (cur.at || 0) < 120000) return; // in flight
        return { state: 'processing', at: Date.now(), order_id: nudge.orderId };
      });
      if (!claim.committed) {
        return res.status(200).json({ ok: true, deduped: true });
      }
    } catch (e) {
      console.error('pixelPayWebhook: event claim failed (proceeding)', e.message);
    }

    let outcome = 'error';
    try {
      const r = await runConfirm(db, nudge.orderId, nudge.paymentUuid);
      outcome = r.outcome;
    } catch (e) {
      console.error(`pixelPayWebhook: confirm error for ${nudge.orderId}`, e.message);
    }
    const finalState = outcome === 'error' ? 'failed' : 'done';
    try { await db.ref(`webhook_events/${eventId}`).update({ state: finalState, outcome, done_at: Date.now() }); } catch (_) {}

    console.log(`pixelPayWebhook: ${nudge.orderId} → ${outcome}`);
    return res.status(200).json({ ok: true, outcome }); // always 200
  }
);

// ============================================================
// sweepStalePending — Stage 4 sub-stage 3: capture/abandon backstop (~5 min)
// ============================================================
//
// Recovers orders the live nudge missed: confirms ones with a recorded payment_uuid
// (or a stuck capturing claim) past the confirm TTL; abandons ones with no usable
// payment_uuid past the abandon TTL (the PixelPay auth has expired — no money moved,
// a *missed order* not a *lost charge*). See PAYMENT-PLAN §G + classifySweepCandidate.
exports.sweepStalePending = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getDatabase();
    const now = Date.now();
    const snap = await db.ref('orders').orderByChild('status').equalTo('pending_payment').once('value');
    const orders = snap.val() || {};
    let confirmed = 0, abandoned = 0, left = 0;

    for (const orderId of Object.keys(orders)) {
      const order = orders[orderId];
      if (order.payment_method !== 'online') continue;
      let attempt = null;
      if (order.active_attempt_id) {
        attempt = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();
      }
      const action = classifySweepCandidate(order, attempt, now);
      if (action === 'confirm') {
        try {
          const r = await runConfirm(db, orderId, attempt && attempt.payment_uuid);
          console.log(`sweep: ${orderId} → ${r.outcome}`);
          confirmed++;
        } catch (e) { console.error(`sweep: confirm failed ${orderId}`, e.message); }
      } else if (action === 'abandon') {
        try {
          await db.ref(`orders/${orderId}`).update({ payment_status: 'failed' });
          if (order.active_attempt_id) await db.ref(`payment_attempts/${order.active_attempt_id}`).update({ status: 'abandoned', abandoned_at: now });
          await paymentAlert(db, 'auth_expired_missed_order', { orderId, total: order.total || null });
          abandoned++;
        } catch (e) { console.error(`sweep: abandon failed ${orderId}`, e.message); }
      } else { left++; }
    }
    console.log(`sweepStalePending: confirmed=${confirmed} abandoned=${abandoned} left=${left}`);
  }
);

// ============================================================
// reconcilePayments — Stage 4 sub-stage 3: daily invariant audit (backstop)
// ============================================================
//
// RTDB-internal money-safety audit → dispatcher alerts. (A full PixelPay-ledger
// cross-check needs a list/ledger API the SDK doesn't expose; this catches the
// states we CAN see: aged manual_reconciliation / refund_pending / capturing,
// confirmed-online-without-a-captured-attempt.) The inline guards in §B are the
// primary controls; this is the safety net.
exports.reconcilePayments = onSchedule(
  { schedule: 'every 24 hours', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getDatabase();
    const now = Date.now();
    const [ordersSnap, attemptsSnap] = await Promise.all([
      db.ref('orders').once('value'),
      db.ref('payment_attempts').once('value')
    ]);
    const orders = ordersSnap.val() || {};
    const attempts = attemptsSnap.val() || {};
    const breaches = [];

    for (const orderId of Object.keys(orders)) {
      const o = orders[orderId];
      if (o.payment_method !== 'online') continue;
      const a = o.active_attempt_id ? attempts[o.active_attempt_id] : null;
      // I2: a confirmed online order must have a captured attempt.
      if (o.payment_status === 'confirmed' && !(a && (a.status === 'captured' || a.capture_verified))) {
        breaches.push({ orderId, kind: 'confirmed_without_captured_attempt' });
      }
      // Aged operator-queue states.
      const age = now - (Number(o.charged_at || o.created_at) || now);
      if (o.payment_status === 'manual_reconciliation' && age > 6 * 3600 * 1000) breaches.push({ orderId, kind: 'aged_manual_reconciliation' });
      if (o.payment_status === 'refund_pending' && age > 6 * 3600 * 1000) breaches.push({ orderId, kind: 'aged_refund_pending' });
    }
    // Stuck capturing claims (crash mid-capture, never recovered).
    for (const id of Object.keys(attempts)) {
      const a = attempts[id];
      if (a.status === 'capturing' && now - (Number(a.capturing_started_at) || now) > 3600 * 1000) {
        breaches.push({ attemptId: id, orderId: a.order_id, kind: 'stuck_capturing' });
      }
    }

    if (breaches.length) {
      console.warn('reconcilePayments: breaches', JSON.stringify(breaches));
      await paymentAlert(db, 'reconcile_breaches', { count: breaches.length, breaches: breaches.slice(0, 50) });
    } else {
      console.log('reconcilePayments: no breaches');
    }
  }
);

// ============================================================
// resolveManualReconciliation — Stage 4 sub-stage 3: audited manual resolver
// ============================================================
//
// Dispatcher-triggered resolution of a `manual_reconciliation` order (paid-but-
// lost-capture-response). NEVER raw DB editing — actions are audited.
//   action 'materialize' → ledger-verified paid: confirm + materialize the order.
//   action 'refund'      → void/refund the payment, close the order failed.
//   action 'keep'        → leave queued (no-op; for re-checking later).
// Auth: RECON_SECRET (server) OR a dispatcher Firebase ID token (the dashboard
// Pedidos view). Records an audit entry keyed by the verified actor.
exports.resolveManualReconciliation = onRequest(
  { region: 'us-central1', cors: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    // DISPATCHER-ONLY money action (can materialize an order or trigger a void/refund).
    // Gated by authorizeDispatcherAction: the server-only RECON_SECRET, or a verified
    // dispatcher's Firebase ID token — NEVER the public order-intake secret (MAKE_SECRET).
    const auth = await authorizeDispatcherAction(req);
    if (!auth.ok) return res.status(auth.code).json({ error: 'Unauthorized', detail: auth.msg });

    const body = req.body || {};
    const orderId = String(body.order_id || '');
    const action = String(body.action || '');
    // Audit actor: a verified dispatcher's email can't be spoofed; only the server
    // RECON_SECRET path may pass a free-text actor label.
    const actor = auth.actor === 'recon_secret' ? sanitizeText(body.actor || 'server', 80) : auth.actor;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return badRequest(res, 'order_id invalid');
    if (!['materialize', 'refund', 'keep'].includes(action)) return badRequest(res, 'action must be materialize|refund|keep');

    const db = getDatabase();
    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'manual_reconciliation') {
      return res.status(409).json({ error: 'Order is not in manual_reconciliation', payment_status: order.payment_status });
    }
    const attemptId = order.active_attempt_id;

    const audit = async (outcome, extra = {}) => {
      await db.ref('payment_audit').push({ order_id: orderId, action, actor, outcome, at: ServerValue.TIMESTAMP, ...extra });
    };

    try {
      if (action === 'keep') {
        await audit('kept_queued');
        return res.status(200).json({ ok: true, outcome: 'kept_queued' });
      }
      if (action === 'materialize') {
        // Dispatcher verified the ledger shows our paid capture → confirm + materialize.
        if (attemptId) await db.ref(`payment_attempts/${attemptId}`).update({ status: 'captured', capture_verified: true, manual_verified: true, amount_cents: order.total_cents });
        await db.ref(`orders/${orderId}`).update({ payment_status: 'pending' }); // let confirmAndMaterialize claim it
        const r = await confirmAndMaterialize(confirmDeps(db), { orderId, attemptId, now: Date.now(), trackingToken: generateTrackingToken() });
        await audit('materialized', { confirm_outcome: r.outcome });
        return res.status(200).json({ ok: true, outcome: r.outcome });
      }
      // action === 'refund'
      const uuid = attemptId ? (await db.ref(`payment_attempts/${attemptId}/payment_uuid`).once('value')).val() : null;
      let voided = false;
      if (uuid) {
        try { const vd = await pixelpayClient.voidTransaction({ payment_uuid: uuid, pixelpayOrderId: `${orderId}-${attemptId}`, voidReason: 'xpizza_manual_refund' }); voided = !!vd.ok; } catch (_) {}
      }
      if (attemptId) await db.ref(`payment_attempts/${attemptId}`).update({ status: voided ? 'refunded' : 'refund_pending', refunded_at: Date.now() });
      await db.ref(`orders/${orderId}`).update({ payment_status: voided ? 'refunded' : 'refund_pending', status: 'cancelled' });
      await audit(voided ? 'refunded' : 'refund_pending', { voided });
      return res.status(200).json({ ok: true, outcome: voided ? 'refunded' : 'refund_pending' });
    } catch (e) {
      console.error(`resolveManualReconciliation: ${orderId} ${action} failed`, e.message);
      return res.status(500).json({ error: 'resolve failed', detail: e.message });
    }
  }
);

// ============================================================
// materializeOnConfirm — recovery trigger (crash between confirm-claim + materialize)
// ============================================================
//
// If a write leaves an order `payment_status:'confirmed'` but with no
// `materialized_at` (the confirm claim landed but materialize didn't), re-run
// materialization idempotently. confirmAndMaterialize is a no-op once materialized,
// so this can't loop. (PAYMENT-PLAN §C.4.)
exports.materializeOnConfirm = onValueWritten(
  { ref: '/orders/{orderId}', region: 'us-central1' },
  async (event) => {
    const after = event.data.after.val();
    if (!after) return;
    if (after.payment_status !== 'confirmed') return;
    if (after.materialized_at) return;               // already materialized → nothing to do
    if (after.status === 'cancelled') return;
    const orderId = event.params.orderId;
    console.warn(`materializeOnConfirm: recovering unmaterialized confirmed order ${orderId}`);
    const db = getDatabase();
    try {
      const r = await confirmAndMaterialize(confirmDeps(db), { orderId, attemptId: after.active_attempt_id, now: Date.now(), trackingToken: generateTrackingToken() });
      console.log(`materializeOnConfirm: ${orderId} → ${r.outcome}`);
    } catch (e) {
      console.error(`materializeOnConfirm: ${orderId} failed`, e.message);
    }
  }
);

// ============================================================
// cancelPaidOrder — Stage 6: dispatcher cancel + void/refund of a paid online order
// ============================================================
//
// DISPATCHER-ONLY — RECON_SECRET (server) or a verified dispatcher Firebase ID token
// (the dashboard Pedidos view), NEVER the public order secret. Voids/refunds the payment
// and cancels the order + tasks.
// Race-guarded against confirmOnlinePayment: it sets `cancelling` on the attempt and
// `status:'cancelled'` on the order — a capture mid-flight converges by VOIDING (I8, see
// pixelpay-confirm.js step 5b), never materializing. Online-only; cash orders use the
// dispatch app's client cancelOrder (the RTDB rules block client cancel of paid online).
exports.cancelPaidOrder = onRequest(
  { region: 'us-central1', cors: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    const auth = await authorizeDispatcherAction(req);
    if (!auth.ok) return res.status(auth.code).json({ error: 'Unauthorized', detail: auth.msg });
    const actor = auth.actor;

    const body = req.body || {};
    const orderId = String(body.order_id || '');
    const reason = sanitizeText(body.reason || 'cancelado por despacho', 200);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return badRequest(res, 'order_id invalid');

    const db = getDatabase();
    const now = Date.now();
    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_method !== 'online') return res.status(409).json({ error: 'Not an online order', detail: 'use the dispatch cancel for cash orders' });
    if (order.status === 'cancelled') return res.status(200).json({ ok: true, outcome: 'already_cancelled', order_id: orderId });

    const attemptId = order.active_attempt_id || null;
    const attemptRef = attemptId ? db.ref(`payment_attempts/${attemptId}`) : null;
    const pixelpayOrderId = attemptId ? `${orderId}-${attemptId}` : null;

    // Claim `cancelling` on the attempt (race converge point with confirm). Pre-read +
    // cur||preAttempt to avoid the Admin-SDK first-call-null abort.
    let attempt = attemptId ? (await attemptRef.once('value')).val() : null;
    if (attemptRef && attempt) {
      const tx = await attemptRef.transaction((cur) => {
        const a = cur || attempt;
        if (!a) return a;
        return { ...a, cancelling: true, cancel_reason: reason, cancel_claimed_at: now };
      });
      attempt = tx.snapshot.val() || attempt;
    }

    // If a capture is mid-flight, the confirm path will void on convergence (step 5b).
    if (attempt && attempt.status === 'capturing') {
      // Mark the order cancelled so confirm voids instead of materializing.
      await db.ref(`orders/${orderId}`).update({ status: 'cancelled', cancelled_at: now, cancel_reason: reason, cancelled_by: actor, payment_status: 'refund_pending' });
      await paymentAlert(db, 'cancel_during_capture', { orderId, attemptId, actor });
      return res.status(202).json({ ok: true, outcome: 'cancel_pending_capture', detail: 'capture in flight; payment will be voided', order_id: orderId });
    }

    // Reverse the payment if there is one to reverse (captured, or an active auth hold).
    const deps = confirmDeps(db);
    let refund = { outcome: 'no_payment', voided: true };
    const uuid = attempt && attempt.payment_uuid;
    const hasMoney = attempt && (attempt.status === 'captured' || attempt.status === 'active' || order.payment_status === 'confirmed');
    if (uuid && hasMoney) {
      refund = await voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId, paymentUuid: uuid, reason, now });
    }

    // Build the cancellation: order + tasks + driver release (mirrors the dispatch cancelOrder).
    const updates = {};
    updates[`orders/${orderId}/status`] = 'cancelled';
    updates[`orders/${orderId}/cancelled_at`] = now;
    updates[`orders/${orderId}/cancel_reason`] = reason;
    updates[`orders/${orderId}/cancelled_by`] = actor;
    updates[`orders/${orderId}/payment_status`] = refund.voided ? 'refunded' : 'refund_pending';
    if (order.order_type === 'delivery') {
      const pickupTaskId = `${orderId}_pickup`;
      const deliveryTaskId = `${orderId}_delivery`;
      const pickup = (await db.ref(`tasks/${pickupTaskId}`).once('value')).val();
      if (pickup) updates[`tasks/${pickupTaskId}/status`] = 'cancelled';
      const delivery = (await db.ref(`tasks/${deliveryTaskId}`).once('value')).val();
      if (delivery) updates[`tasks/${deliveryTaskId}/status`] = 'cancelled';
      // Release the assigned driver if they were working this order.
      const driverId = pickup && pickup.assigned_driver_id;
      if (driverId) {
        const driver = (await db.ref(`drivers/${driverId}`).once('value')).val();
        if (driver && (driver.current_task_id === pickupTaskId || driver.current_task_id === deliveryTaskId)) {
          updates[`drivers/${driverId}/current_task_id`] = null;
          if (['assigned', 'at_restaurant', 'en_route_delivery'].includes(driver.status)) {
            updates[`drivers/${driverId}/status`] = 'available';
          }
        }
      }
    }
    await db.ref().update(updates);

    console.log(`cancelPaidOrder: ${orderId} cancelled by ${actor} (refund=${refund.outcome})`);
    return res.status(200).json({ ok: true, outcome: 'cancelled', refund: refund.outcome, order_id: orderId });
  }
);

// ============================================================
// refundReconciler — Stage 6: retry aged refund_pending (scheduled, hourly)
// ============================================================
//
// A void that failed (network, or the unverified production void signature) leaves the
// attempt `refund_pending`. Retry it; alert on aged ones so a dispatcher can act. The
// daily reconcilePayments also surfaces aged refund_pending as a backstop.
exports.refundReconciler = onSchedule(
  { schedule: 'every 60 minutes', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getDatabase();
    const now = Date.now();
    const attempts = (await db.ref('payment_attempts').once('value')).val() || {};
    const deps = confirmDeps(db);
    let retried = 0, stillPending = 0;
    for (const attemptId of Object.keys(attempts)) {
      const a = attempts[attemptId];
      if (!a || a.status !== 'refund_pending') continue;
      const pixelpayOrderId = `${a.order_id}-${attemptId}`;
      const r = await voidOrRefund(deps, { orderId: a.order_id, attemptId, pixelpayOrderId, paymentUuid: a.payment_uuid, reason: 'xpizza_refund_retry', now });
      retried++;
      if (!r.voided) {
        stillPending++;
        const age = now - (Number(a.refunded_at || a.cancel_claimed_at || a.captured_at) || now);
        if (age > 24 * 3600 * 1000) await paymentAlert(db, 'aged_refund_pending', { orderId: a.order_id, attemptId });
      }
    }
    console.log(`refundReconciler: retried=${retried} stillPending=${stillPending}`);
  }
);

// ============================================================
// blockPublicSignup — reject self-registration (allowlist staff only)
// ============================================================
//
// Firebase's email/password provider allows public self-registration: anyone
// with the (public) web API key can call accounts:signUp and create an account.
// Under the `auth != null` RTDB read rules, that account could then read all
// customer PII + driver locations. This blocking function closes the door —
// only the known staff emails below may have an account created; every other
// signup is rejected with permission-denied.
//
// PREREQUISITES (one-time):
//   1. Enable Identity Platform on the project (Firebase Console -> Authentication;
//      free tier). Blocking functions require it — without it, deploy will error.
//   2. Deploy via `npm run deploy`. A v2 beforeUserCreated handler auto-registers
//      itself as the Auth beforeCreate trigger on deploy (no manual wiring).
//
// Existing accounts are NOT affected (this runs only on NEW account creation),
// and sign-in of current staff is unaffected. To add a staff member: add their
// lowercased email to STAFF_EMAILS, redeploy, THEN create the account. The list
// is an in-memory Set (no DB/network I/O) so the check can't fail at runtime and
// can't be tampered with via the database.

const STAFF_EMAILS = new Set([
  'xavierlacayo@gmail.com',
  'xlacayo@me.com',
  'sherpasderl@gmail.com',
  'staffsherpa@gmail.com',
  'hermeztalavera@gmail.com',
  'garayg067@gmail.com',
  'elmeredsantos04@gmail.com',
  'norisf56@gmail.com'
]);

exports.blockPublicSignup = beforeUserCreated({ region: 'us-central1' }, (event) => {
  const email = ((event.data && event.data.email) || '').trim().toLowerCase();
  if (!email || !STAFF_EMAILS.has(email)) {
    console.warn(`blockPublicSignup: rejected account creation for "${email || '(no email)'}"`);
    throw new HttpsError('permission-denied', 'Account creation is restricted to X Pizza staff.');
  }
  console.log(`blockPublicSignup: allowed staff account creation for ${email}`);
  // returning nothing → creation proceeds
});

// ============================================================
// healthz — Liveness + dependency check for uptime monitoring
// ============================================================
//
// Pinged every 5 minutes by an external uptime monitor (UptimeRobot etc).
// Returns 200 + JSON when the function is alive AND can reach Firebase.
// Returns 503 when Firebase is unreachable. Anything other than 200 means
// "platform is degraded" — alert.
//
// Public endpoint, no auth. Firebase connection check is cheap (a single
// read of the special /.info/connected path that Firebase maintains for
// exactly this purpose).
//
// Worth noting what this does NOT check: WhatsApp/UltraMsg, individual
// function correctness, slow-but-not-failing responses. The Sentry-style
// error alerts catch the function-error case; this just catches the
// "everything is on fire" case.
exports.healthz = onRequest(
  {
    region: 'us-central1',
    cors: true,            // safe for browsers to hit (e.g., status page)
    timeoutSeconds: 10,    // fail fast — slow check is a fail
    memory: '256MiB'       // 128MiB OOMs at boot — firebase-admin needs more
  },
  async (req, res) => {
    const startedAt = Date.now();
    try {
      const db = getDatabase();
      // .info/connected is a Firebase-maintained boolean. Reading it
      // exercises the database connection without depending on any
      // application data shape.
      const snap = await db.ref('.info/connected').once('value');
      const dbReachable = snap.val() === true;
      const elapsedMs = Date.now() - startedAt;

      if (!dbReachable) {
        return res.status(503).json({
          ok: false,
          checks: { firebase: 'unreachable' },
          elapsed_ms: elapsedMs
        });
      }

      return res.status(200).json({
        ok: true,
        checks: { firebase: 'ok' },
        elapsed_ms: elapsedMs,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.error('healthz: check failed', e.message);
      return res.status(503).json({
        ok: false,
        error: e.message,
        elapsed_ms: Date.now() - startedAt
      });
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
// - STACKING_RULES (max 2 orders/driver; a 2nd order may be stacked only while
//   the driver is still in the PRE-DEPARTURE window for their 1st order — i.e.
//   before they leave the restaurant with the food):
//     * 0 active orders:                                          eligible (cap 2)
//     * 1 active order AND status in STACKABLE_STATUSES
//       (available | assigned ["en recogida"] | at_restaurant):   stack 2nd (cap 2)
//     * 1 active order AND status en_route_delivery/returning/…:   full (cap 1)
//     * 2+ active orders:                                          full
//   orderCount counts DISTINCT active order_ids, NOT task pairs — once a driver
//   picks up, the pickup task is 'completed' and only the delivery task remains
//   active, so a task-halving count would wrongly read a mid-delivery driver as 0.

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

// Driver statuses in which a 2nd order may be STACKED onto a driver who already
// has 1 active order — the pre-departure window (heading to / waiting at the
// restaurant). Once en_route_delivery the driver has left with the food and is
// full. Kept identical to the dispatch console's manual-assign guard.
const STACKABLE_STATUSES = new Set(['available', 'assigned', 'at_restaurant']);

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

  // Count DISTINCT active orders per driver. An order is a pickup task + a
  // delivery task, but the pickup task flips to 'completed' the moment the driver
  // picks up — so counting tasks (and halving) under-counts a mid-delivery driver
  // as 0 orders and would let en_route drivers slip past the stacking gate.
  // Counting distinct active order_ids is correct.
  const activeOrdersByDriver = {};
  for (const taskId of Object.keys(tasks)) {
    const t = tasks[taskId];
    if (!t || !t.assigned_driver_id) continue;
    if (t.status === 'completed' || t.status === 'cancelled') continue;
    if (!activeOrdersByDriver[t.assigned_driver_id]) activeOrdersByDriver[t.assigned_driver_id] = new Set();
    if (t.order_id) activeOrdersByDriver[t.assigned_driver_id].add(t.order_id);
  }

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

    const orderCount = activeOrdersByDriver[driverId] ? activeOrdersByDriver[driverId].size : 0;

    // Stacking eligibility (see STACKING_RULES above):
    //   - 0 orders: eligible (takes the 1st)
    //   - 1 order AND status in STACKABLE_STATUSES (available | assigned |
    //     at_restaurant): stack the 2nd — driver is still in the pre-departure
    //     window (heading to / waiting at the restaurant), so the 2nd pizza
    //     rides along.
    //   - 1 order, any other status (en_route_delivery, returning, on_break):
    //     full — the driver already left with the food.
    //   - 2+ orders: full.
    let cap;
    if (orderCount === 0) {
      cap = 2;
    } else if (orderCount === 1 && STACKABLE_STATUSES.has(d.status)) {
      cap = 2;
    } else {
      cap = orderCount;  // at cap → filtered out below
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

    // Fire when the order BECOMES live (status → 'new'): cash orders at create
    // (before == null), and online orders when a verified payment materializes them
    // (before.status was 'pending_payment'). Ignore the pending_payment write itself
    // and all later updates. Unifies the cash + online dispatch entry point (§D).
    if (!after) return;
    const becameNew = after.status === 'new' && (before === null || before.status !== 'new');
    if (!becameNew) return;

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
