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
 *   - allocateDisplayNumberOnSale   (DB trig) — per-restaurant daily #N label on live/Sale (display-only, fail-open)
 *   - cancelPaidOrder               (HTTPS)   — dispatcher void/refund + cancel of a paid online order (Stage 6)
 *   - refundReconciler              (sched)   — retry aged refund_pending voids (Stage 6)
 *   - notifyDriverOnAssignment      (DB trig) — Web Push to driver on assignment
 *   - notifyDriverOnCancellation    (DB trig) — Web Push to assigned driver when order is cancelled
 *   - onOrderCancelled              (DB trig) — Sync cancellations to KDS Sheet
 *   - sendOrderStatusNotifications  (DB trig) — Customer WhatsApp on status transitions
 *   - notifyPickupReady             (DB trig) — Customer WhatsApp when a pickup order → ready (at most once)
 *   - onIncomingWhatsApp            (HTTPS)   — UltraMsg webhook for inbound customer messages + auto-reply
 *   - autoAssignOnOrderCreate       (DB trig) — Auto-pick driver after grace period (with continuous-at-restaurant stacking)
 *   - monitorAssignmentTimeout      (DB trig) — Reassign on 60s no-accept timeout
 *   - driverFreshnessMonitor        (sched)   — alarm dispatch when an on-shift driver's pings go dark (C1)
 *   - readyTimeGraduationMonitor    (sched)   — hourly predictor graduation verdicts → ready_time_graduation (1b-i)
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

const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onValueWritten, onValueCreated } = require('firebase-functions/v2/database');
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
const { getIdentity: getRestaurantIdentity, hubSnapshot } = require('./restaurant-config');
const { buildCreateOrderUpdates, buildScheduledOrderRecord, attachCustomerAttribution, attributionUid } = require('./create-order-build');
const { claimPrefillCore } = require('./claim-prefill');   // Track A — profile-claim soft-fill (pure core; wrapper below)
const { creditEarnForOrder, creditWelcome } = require('./rewards-earn');   // Rewards Phase A — earn engine (Admin-SDK writes only)
const { shouldEarnOnStatus } = require('./rewards-core');                  //   pure terminal-state gate for the earn trigger
const { resolveRedemptionForOrder, prepareRedemption, quoteRedemptionCore } = require('./rewards-redeem-intake');   // Phase B1 intake (cash/online) + B2 read-only quote
const { reserveRedemption, releaseRedemption, attachAttempt, settleRedemptionAtConfirm, sweepStaleReservations, sweepConsumeRecovery } = require('./rewards-reserve');  //   reservation lifecycle + confirm-settle + sweeps
const { REDEMPTION_CONFIG_VERSION } = require('./rewards-redeem-config');  //   config version for the reservation binding
const { shouldSendOrderReceived } = require('./order-received');   // order-received WhatsApp (online orders) decision core
const { normalizeReorderItems } = require('./reorder-normalize');   // P3 — menu-allowlisted reorder recipe (online: plumbed onto the pending order here)
const { decideStatusMirror } = require('./status-mirror');          // P3 — status-sync trigger core (update-only-if-exists)
const SCHED = require('./scheduled-orders');                              // Scheduled Orders — pure hours/slot/release core
const { releaseOne: releaseScheduledCore, recoverStaleReleasing } = require('./scheduled-release-core');
const { extractWebhookNudge, classifySweepCandidate } = require('./pixelpay-webhook');
const { voidOrRefund } = require('./pixelpay-cancel');
const { handleHostedCallback } = require('./pixelpay-hosted-webhook');
const { getMessaging } = require('firebase-admin/messaging');
// Factura (SAR fiscal document) — logic source of truth is xpizza-factura/src; the four
// logic modules under ./factura are byte-identical deploy copies (see factura/README.md +
// factura/sync.test.js). Allocation/void fire from DB triggers (allocateFacturaOnSale /
// voidFacturaOnCancel) defined below. FACTURA_PLAN.md + ADR-0003/0004.
const { pricedLineItems } = require('./factura/pricing');
const { facturaSaleEligible, facturaVoidEligible, usesPlatformFactura } = require('./factura/eligibility');
const { allocateFacturaNumber, voidFactura } = require('./factura/factura-helpers');
const { decideDisplayNumber, displayNumberEligible } = require('./order-display-number');   // per-restaurant daily #N (display-only)
const { hnDateISO } = require('./factura/build-record');   // YYYY-MM-DD in America/Tegucigalpa (the factura day boundary)
const FACTURA_RESTAURANT_ID = 'x_pizza'; // single restaurant until the config-plane migration
const FACTURA_LAUNCH_CUTOFF_MS = Date.parse('2026-06-26T00:00:00Z'); // never retro-issue pre-launch orders
const {
  computePushReachable,
  selectTransports,
  isTerminalFcmError,
  isTerminalWebPushError,
  buildFcmMessage,
  validateTokenOwner,
  PUSH_TTL_SECONDS
} = require('./driver-push');
const {
  geofenceTransition,
  isHubResolvable,
  syncDriverHubUpdate,
  driverHasSameHubAccepted,
  selectIngestPoints,
  hashToken,
  validateIngestToken,
  coerceTs
} = require('./driver-ingest');
const { sweepDecision, activeOrderCount, assignmentStrandState, HEAL_TERMINAL_STATUSES } = require('./sweep-pending');
const { claimDelivery, healStrandedOrder, releaseDeliveryFromDriver } = require('./claim-delivery');
const { countKitchenLoadAhead, countDriverSupply, buildLifecycleEvent, timelineStampKey } = require('./order-lifecycle');
const { computeFreshnessAlerts } = require('./driver-freshness');   // Driver Tracking C1: freshness-alarm reconcile core
const MR = require('./manual-resolve');   // atomic-claim money state machine (RECON_ATOMIC_CLAIM_PLAN rev-5)
const { resolveManualReconciliationCore, recoverStaleResolve } = require('./resolve-manual');   // the resolver core + sweep recovery (emulator-driven)
const { cancelOrderCore, cleanupTasksAndDriver, recoverStaleCancel, isReconcilerRetryable } = require('./cancel-order-core');   // universal dispatcher-cancel core (CANCEL_PAID_ORDER_FIX_PLAN rev-5)
const { runPrediction, runLabelAndUpdate } = require('./ready-time-predict-core');   // Phase-1 Step-3 shadow predictor + prediction-logging (PURE SHADOW)
const { computeGraduation, buildGraduationRows } = require('./ready-time-graduation');   // Phase 1b-i graduation core (writes ONLY ready_time_graduation)
const { hashConfig } = require('./ready-time-quality-run');          // reuse the signed-config hash (extended to cover graduation_thresholds)
const { ACTIVE_MODEL_VERSIONS } = require('./ready-time-predict');   // active model version(s) — windows prediction_logs by `<v>/new_at`

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
// RESTAURANT is retained ONLY as the materialize snapshot-fallback for in-flight pre-3b
// pending orders (see confirmDeps -> buildMaterializeUpdates). Live intake reads the config
// plane (restaurant-config); the delivery radius now comes from identity.delivery_radius_km.

// hubSnapshot (the ADR-0002 allowlist mapping identity -> immutable per-order snapshot) is
// defined in and imported from restaurant-config.js, above.

// Generate a random URL-safe tracking token. 12 chars from a 54-char alphabet
// gives 54^12 = ~6.3e20 possible tokens — guessing one is impossible. The
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
// Server-side price tables + total recomputation now live in ./menu-pricing
// (pure, restaurant-keyed, unit-tested). MENU_BY_RESTAURANT holds each restaurant's
// table; computeServerTotal(items, restaurantId) recomputes the total (x_pizza →
// match by name, la_musa → by id). EXTRA_PRICES + the x_pizza alias below keep the
// factura pricedLineItems call sites byte-identical until A3 makes them restaurant-aware.
// ---------------------------------------------------------------------------
const { MENU_BY_RESTAURANT, EXTRA_PRICES, computeServerTotal } = require('./menu-pricing');
const { checkItemAvailability } = require('./availability-gate');   // KDS 2b — server intake "86" fail-safe (fail-open)
const MENU_PRICES = MENU_BY_RESTAURANT.x_pizza; // x_pizza table — used by pricedLineItems (factura)
const { resolveRestaurantId, sameRestaurant } = require('./restaurant-id');
const { resolveReturnBase } = require('./pixelpay-return-url');
const { resolveAssignHub, X_PIZZA_HUB } = require('./assign-hub');

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

// ---------------------------------------------------------------------------
// Canonical money — priceBreakdownCents (ISV 15% tax-inclusive split, the
// platform-factura breakdown) + the restaurant-aware orderBreakdownCents now live
// in ./order-money (pure, unit-tested). Platform-factura restaurants (x_pizza) get
// the 15% split; non-platform (la_musa — Soft Restaurant POS factura) get NO split
// (subtotal == total, tax_cents:0). subtotal_cents + tax_cents === total_cents always.
// ---------------------------------------------------------------------------
const { orderBreakdownCents } = require('./order-money');

function validateOrderPayload(body, restaurantId) {
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

  // Recompute total server-side — NEVER trust body.total. Priced against the order's restaurant menu.
  const { total, error: totalError } = computeServerTotal(body.items, restaurantId);
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
    pickup_time: sanitizeText(body.pickup_time, 40) || 'standard',
    // Factura-with-RTN (D3). razon_social replaces CLIENTE; rtn_cliente validated server-side
    // as 14 digits (never trust the client) — blank if absent/invalid (= consumidor final).
    razon_social: sanitizeText(body.razon_social, 120),
    rtn_cliente: /^\d{14}$/.test(String(body.rtn_cliente || '')) ? String(body.rtn_cliente) : ''
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
  confirm_ip: { windowMs: 10 * 60 * 1000, max: 80 }, // confirm/poll guard: each payment does
                                                    // ~1 confirm (+ a few polls on 202), so this
                                                    // caps capture-hammering without blocking legit polling
  claim_token: { windowMs: 10 * 60 * 1000, max: 15 } // Track A claimPrefill: throttle per-TOKEN (the spoof-PROOF
                                                     // capability; on Cloud Run req.ip == the client-appended
                                                     // XFF, spoofable) — caps repeated phone pulls on one leaked
                                                     // link. Generous for legit retries; invalid-token probing
                                                     // is 403'd by the core + bounded by maxInstances.
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

  // Parse + validate. Resolve restaurant_id FIRST — it selects the menu the total is priced
  // against and gates idempotency + identity below. Missing → x_pizza; unknown → 400.
  const body = req.body || {};
  const { restaurantId, error: ridError, defaulted: ridDefaulted } = resolveRestaurantId(body.restaurant_id);
  if (ridError) return badRequest(res, ridError);
  if (!ridDefaulted) console.log(`createOrder: restaurant_id=${restaurantId}`);
  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId);
  if (errors.length > 0) {
    return badRequest(res, errors.join('; '));
  }

  const orderId = String(body.order_id);
  const orderType = body.order_type;

  // Online payments must NEVER enter through createOrder — they enter via chargeOnlineOrder as a
  // pending_payment order that only materializes after a VERIFIED capture. Without this guard a POST with
  // payment_method:'online' (+ scheduled_for) would write a held/live order with NO charge, and at release
  // buildMaterializeUpdates({paymentMethod:'online'}) would flip it to payment_status:'confirmed' → an
  // UNPAID order goes live (Codex-on-diff #1). createOrder is cash / card-on-delivery only.
  if (fields.payment_method === 'online') {
    return badRequest(res, 'online payments must use chargeOnlineOrder');
  }

  const db = getDatabase();

  // Idempotency check
  try {
    const existing = await db.ref(`orders/${orderId}`).once('value');
    if (existing.exists()) {
      // Legacy-normalized compare: a stored order with no restaurant_id is a pre-Phase-0 x_pizza order.
      if (!sameRestaurant(existing.val().restaurant_id, restaurantId)) {
        console.warn(`createOrder: ${orderId} exists for a different restaurant — conflict`);
        return res.status(409).json({ error: 'Order conflict', detail: 'order_id already used for a different restaurant', order_id: orderId });
      }
      console.log(`createOrder: order ${orderId} already exists, returning idempotent`);
      return res.status(200).json({ ok: true, idempotent: true, order_id: orderId });
    }
  } catch (e) {
    console.error('createOrder: existence check failed', e);
    return res.status(500).json({ error: 'Database read failed', detail: e.message });
  }

  // Config-plane identity (ADR-0002): fail-closed read, gate intake on active, zone-check from
  // config. After the idempotency check so idempotent retries don't re-read config; the delivery
  // zone enforcement (clients are bypassable) now uses identity.hub + identity.delivery_radius_km.
  let restIdentity;
  try {
    restIdentity = await getRestaurantIdentity(db, restaurantId);
  } catch (e) {
    console.error(`createOrder: config unavailable for ${orderId}: ${e.message}`);
    res.set('Retry-After', '2');
    return res.status(e.statusCode || 503).json({ error: 'Service temporarily unavailable', detail: 'restaurant config unavailable', retryable: true });
  }
  if (!restIdentity.active) {
    console.warn(`createOrder: ${restaurantId} inactive — rejecting ${orderId}`);
    return res.status(400).json({ error: 'Restaurant closed', detail: 'Not accepting orders right now' });
  }
  if (orderType === 'delivery') {
    const distanceKm = haversineKm(lat, lng, restIdentity.hub_lat, restIdentity.hub_lng);
    if (distanceKm > restIdentity.delivery_radius_km) {
      console.warn(`createOrder: order ${orderId} rejected — ${distanceKm.toFixed(2)}km > ${restIdentity.delivery_radius_km}km radius`);
      return badRequest(res, `Outside delivery zone (${distanceKm.toFixed(1)}km from restaurant, max ${restIdentity.delivery_radius_km}km)`);
    }
  }
  const hubSnap = hubSnapshot(restIdentity);

  // ── Item availability gate (KDS 2b · KDS_2B_PLAN.md §6/§8). Runs AFTER the idempotency dedupe (an
  // accepted retry already returned above → no re-eval) and validate, but BEFORE the rate-limit
  // increment and any order/scheduled write — so a blocked (86'd) cash attempt writes NOTHING (no
  // orders/{id}, no rate_limits). checkItemAvailability is fail-open internally (a read error/absent
  // node ⇒ blocked:[] ⇒ the sale proceeds), so a Firebase hiccup can never wrongly reject.
  const availGate = await checkItemAvailability(db, body.items, restaurantId);
  if (availGate.blocked.length > 0) {
    console.warn(`createOrder: rejecting ${orderId} — unavailable item(s): ${availGate.blocked.join(', ')}`);
    return res.status(400).json({ error: 'item_unavailable', blocked: availGate.blocked });
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

  // Optional logged-in attribution (H2): a SEPARATE `X-Firebase-ID-Token` header, verified server-side.
  // Guest path is byte-identical — guests send no token; a missing/malformed/expired/foreign token is
  // ignored and the order proceeds as guest. A client-supplied customer_uid in the body is NEVER trusted;
  // only decoded.uid from a VERIFIED customer:true token is used, so attribution can't be forged.
  let customer_uid = null;
  const idTok = req.get('x-firebase-id-token');
  if (idTok) {
    try {
      const dec = await getAuth().verifyIdToken(idTok);
      if (dec && dec.customer === true && dec.uid) {
        // H10 durability: a deleted (tombstoned) account never re-accrues attribution.
        const tomb = await getDatabase().ref('deleted_uids/' + dec.uid).get();
        customer_uid = attributionUid(dec, tomb.exists());
      }
    } catch (_) { /* malformed/expired/foreign/tomb-read-failure → ignore, treat as guest */ }
  }

  // ── Placeability gate (§B) — RE-VALIDATE the slot / closed-kitchen BEFORE any redemption reserve, so that
  // NOTHING between the reserve and the order write can fail (the write itself already releases the hold on
  // failure). These checks depend only on restIdentity.hours / scheduledForRaw / orderType — never on the
  // redemption — so proving placeability first eliminates the orphaned-hold class by construction.
  const scheduledForRaw = SCHED.normalizeScheduledFor(body.scheduled_for);
  const isScheduled = Number.isFinite(scheduledForRaw);
  let releaseAt = null;
  if (isScheduled) {
    const v = SCHED.validateScheduledFor(restIdentity.hours, scheduledForRaw, Date.now(), orderType);
    if (!v.valid) return badRequest(res, `Invalid scheduled time (${v.reason})`);
    releaseAt = SCHED.releaseAtFor(scheduledForRaw, orderType);
  } else if (SCHED.asapWhileClosed(restIdentity.hours, scheduledForRaw, Date.now())) {
    return badRequest(res, 'Cerrado — programá tu pedido');   // ASAP while closed → never dump onto a dark kitchen
  }

  // ── Rewards Phase B1: redemption (cash → RESERVE at create; the completion state consumes; cancel releases).
  // Gated by redemption_enabled + a VERIFIED non-guest uid; the discount is ALWAYS server-computed; ALL-OR-
  // NOTHING (any failure → non-payable 409/401, no order written). No `redeem` in the body → today's behavior
  // byte-for-byte (B1 stays inert until B2 flips the flag on and starts sending `redeem`).
  let redemptionCanonical = null;    // stamped onto the order when a reward is applied
  let redemptionPriced = null;       // discounted breakdown + factura lines (Task 4)
  let redemptionReserved = null;     // { uid, rid, orderId } ONLY if THIS call owns the hold → release on write failure
  if (body.redeem != null) {
    // cash has no scheduled fingerprint extra at this point (order_id + discounted total + items_text bind the
    // hold); the completion state consumes, cancel releases. See rewards-redeem-intake.resolveRedemptionForOrder.
    const rd = await resolveRedemptionForOrder(db, {
      redeem: body.redeem, items: body.items, restaurantId, orderId,
      customerUid: customer_uid, itemsText: fields.items_text, totalLempiras: total, schedExtra: '', now: Date.now(),
    });
    if (!rd.ok) return res.status(rd.status).json({ ...rd.body, order_id: orderId });   // ALL-OR-NOTHING: non-payable, no order
    fields.items_text = rd.itemsText;                                                   // La Musa free-item display line appended
    redemptionCanonical = rd.canonical;
    redemptionPriced = rd.priced;
    if (rd.ownsHold) redemptionReserved = { uid: customer_uid, rid: restaurantId, orderId };
  }
  const effectiveTotal = redemptionPriced ? redemptionPriced.total_lempiras : total;   // discounted total (== total when no redeem)

  const trackingToken = generateTrackingToken();
  // Redeemed → the discounted breakdown + split factura lines (Task 4); else today's pricing, byte-identical.
  const priceBreakdown = redemptionPriced
    ? { total_cents: redemptionPriced.total_cents, subtotal_cents: redemptionPriced.subtotal_cents, tax_cents: redemptionPriced.tax_cents,
        ...(redemptionPriced.desc_rebaja_cents ? { desc_rebaja_cents: redemptionPriced.desc_rebaja_cents } : {}) }  // A-F: factura comp rebaja (x_pizza only)
    : orderBreakdownCents(total, restaurantId);  // platform → ISV 15% incl.; non-platform → no split

  // ── A1: free-order intake. The forms grey out both payment methods + submit `free_order:true` ONLY when
  // the server quote zeroed the total (a fully-comping redemption). We RE-DERIVE it here from the
  // authoritative (re-priced) breakdown — the client flag is an optimistic hint, never trusted. If the
  // client claimed free but the total is NOT actually 0 (stale quote / reward invalidated), REJECT (and
  // release the hold) so the forms re-enable a payment method — we never silently place a payable order the
  // customer never paid for. When free, `free_order:true` is stamped onto the order + driver tasks so cash
  // surfaces show nothing to collect and accounting/factura (A-F) treat it as a comp.
  const freeOrder = !!redemptionPriced && priceBreakdown.total_cents === 0;
  if (body.free_order === true && !freeOrder) {
    if (redemptionReserved) await releaseRedemption(db, { ...redemptionReserved, now: Date.now() }).catch(() => {});
    return res.status(409).json({ error: 'free_order_stale', detail: 'El pedido ya no es gratis; seleccioná un método de pago', order_id: orderId, total_cents: priceBreakdown.total_cents });
  }
  // pricedLineItems feeds order.items, consumed ONLY by the platform factura trigger. Non-platform
  // restaurants (la_musa — Soft Restaurant POS) opt out → skip it; order.items is then omitted.
  const facturaPriced = redemptionPriced
    ? { items: (usesPlatformFactura(restaurantId) ? redemptionPriced.factura_items : null), error: null }
    : (usesPlatformFactura(restaurantId)
      ? pricedLineItems(body.items, MENU_PRICES, EXTRA_PRICES)
      : { items: null, error: null });

  // Cash tendered (FACTURA_PLAN §2): validated >= total (never trust client), defaults to exact
  // (no change) when absent/invalid so a bad value never blocks the order. Money in centavos.
  let cashTenderedCents = 0;
  if (fields.payment_method === 'cash') {
    const ct = Math.round(Number(body.cash_tendered) * 100);
    cashTenderedCents = (Number.isFinite(ct) && ct >= priceBreakdown.total_cents) ? ct : priceBreakdown.total_cents;
  }

  // ── Scheduled Orders (§B): a cash/card order with a valid scheduled_for is written HELD — no tasks,
  // no tracking token, no order-received WhatsApp, no factura — and materializes only at release. The slot
  // was already RE-VALIDATED above (before the reserve); releaseAt was computed there. No re-validation here
  // (nothing between the reserve and this write may fail — that's the orphaned-hold fix).
  if (isScheduled) {
    const heldUpdates = buildScheduledOrderRecord({
      orderId, orderType, now, trackingToken, total: effectiveTotal, lat, lng, fields, hubSnap,
      restaurantId, priceBreakdown, facturaPriced, cashTenderedCents, freeOrder,
      scheduledFor: scheduledForRaw, releaseAt,
    });
    attachCustomerAttribution(heldUpdates, orderId, customer_uid, { now, total: effectiveTotal, orderType, items_text: fields.items_text, restaurantId, items: body.items });
    if (redemptionCanonical) heldUpdates[`orders/${orderId}`].redemption = redemptionCanonical;   // bind the reward to the order (reserved until release→completion)
    try {
      await db.ref().update(heldUpdates);
      console.log(`createOrder: HELD scheduled ${orderType} order ${orderId} for ${scheduledForRaw} (release ${releaseAt})`);
    } catch (e) {
      console.error('createOrder: scheduled write failed', e);
      if (redemptionReserved) await releaseRedemption(db, { ...redemptionReserved, now: Date.now() }).catch(() => {});   // all-or-nothing: never leave a hold with no order
      return res.status(500).json({ error: 'Database write failed', detail: e.message });
    }
    // No tracking token, no "order received" WhatsApp — the customer got a scheduled confirmation client-side.
    return res.status(200).json({ ok: true, scheduled: true, order_id: orderId, scheduled_for: scheduledForRaw, release_at: releaseAt });
  }

  // ASAP order (no scheduled_for): the closed-kitchen fail-close was already applied above (before the
  // reserve). Fall through to the live-order write.

  // Order record + driver tasks + public tracking — extracted to a pure builder
  // (create-order-build.js) so the cash path is golden-tested for byte-identical output. The
  // field names are load-bearing (driver app, KDS, tracking site, factura trigger).
  Object.assign(updates, buildCreateOrderUpdates({
    orderId, orderType, now, trackingToken, total: effectiveTotal, lat, lng, fields, hubSnap,
    restaurantId, priceBreakdown, facturaPriced, cashTenderedCents, freeOrder,
  }));

  attachCustomerAttribution(updates, orderId, customer_uid, { now, total: effectiveTotal, orderType, items_text: fields.items_text, restaurantId, items: body.items });
  // Track A (MF2): immediate (cash/live) path — order_tracking is built HERE (not via buildMaterializeUpdates),
  // so stamp has_profile from the resolved server customer_uid. Guest → omitted → order_tracking byte-identical.
  if (customer_uid && updates[`order_tracking/${trackingToken}`]) updates[`order_tracking/${trackingToken}`].has_profile = true;
  if (redemptionCanonical) updates[`orders/${orderId}`].redemption = redemptionCanonical;   // bind the reward to the order (reserved until completion consumes)

  try {
    await db.ref().update(updates);
    console.log(`createOrder: wrote ${orderType} order ${orderId}`);
  } catch (e) {
    console.error('createOrder: write failed', e);
    if (redemptionReserved) await releaseRedemption(db, { ...redemptionReserved, now: Date.now() }).catch(() => {});   // all-or-nothing: never leave a hold with no order
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
  if (await whatsapp.isEnabledForRestaurant(db, restaurantId)) {
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
          total: effectiveTotal,
          pickupTime: String(updates[`orders/${orderId}`].pickup_time || 'standard'),
          trackingToken,
          restaurantId
        });
      } else {
        waBody = whatsapp.tplOrderReceived({
          customerName: String(updates[`orders/${orderId}`].customer_name || ''),
          orderId,
          itemsText: String(updates[`orders/${orderId}`].items_text || ''),
          total: effectiveTotal,
          trackingToken,
          restaurantId
        });
      }
      await whatsapp.sendMessage(updates[`orders/${orderId}`].customer_phone, waBody, restaurantId);
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
const { acquireHostedAttempt, classifyHostedAttempt, HOSTED_TTL_MS } = require('./pixelpay-hosted-charge');
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
  const { restaurantId, error: ridError, defaulted: ridDefaulted } = resolveRestaurantId(body.restaurant_id);
  if (ridError) return badRequest(res, ridError);
  if (!ridDefaulted) console.log(`chargeOnlineOrder: restaurant_id=${restaurantId}`);
  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId);
  if (errors.length > 0) return badRequest(res, errors.join('; '));

  // This endpoint is ONLY for online card payments. cash/card_delivery use createOrder.
  if (fields.payment_method !== 'online') {
    return badRequest(res, 'chargeOnlineOrder is for payment_method "online" only');
  }

  const orderId = String(body.order_id);
  const orderType = body.order_type;

  // NOTE (A1 · #2, R7): the PixelPay config + return-base reads were MOVED DOWN — to just before the
  // reserve/acquire, after the reprice + $0 guard + all non-PixelPay gates. Rationale: a $0 (free) order
  // must return BEFORE ever touching PixelPay config (it never charges), AND a payable order must prove
  // PixelPay is signable AFTER the gates but BEFORE opening any attempt/hold — preserving "never open an
  // attempt we can't sign" while never 500-ing a free order on a config read. See the reserve block below.

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const db = getDatabase();

  // Optional verified logged-in attribution (H2) — resolved EARLY here because the redemption path needs the
  // verified uid and both fingerprint sites need the discounted total. Fail-open to guest EXACTLY as before
  // (missing/malformed/expired/tombstoned/guest/timeout → null → the charge is UNAFFECTED). 1.5s deadline so a
  // hung verifyIdToken/tomb-read never delays the hosted-checkout mint. A client-supplied uid is never trusted.
  let customer_uid = null;
  const idTok = req.get('x-firebase-id-token');
  if (idTok) {
    try {
      customer_uid = await Promise.race([
        (async () => {
          const dec = await getAuth().verifyIdToken(idTok);
          if (dec && dec.customer === true && dec.uid) {
            const tomb = await getDatabase().ref('deleted_uids/' + dec.uid).get();
            return attributionUid(dec, tomb.exists());
          }
          return null;
        })(),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),   // deadline → guest; never delay/fail a payment
      ]);
    } catch (_) { customer_uid = null; }   // any error → guest
  }

  // ── Rewards Phase B1 (online): PREPARE the redemption BEFORE both fingerprint sites, so the reservation
  // binding AND the PixelPay payment fingerprint carry the discounted total + appended items_text. The RESERVE
  // (the debit) happens later — right before acquireHostedAttempt, after all placeability — so an abandoned
  // acquire releases it. Gated by redemption_enabled + a VERIFIED uid; ALL-OR-NOTHING (any failure → non-payable
  // 409/401, no attempt/URL). No `redeem` → byte-identical online path (effTotal===total, items_text unchanged).
  let redemptionCanonical = null, redemptionPriced = null, redemptionCost = 0;
  let effTotal = total;
  if (body.redeem != null) {
    const prep = await prepareRedemption(db, { redeem: body.redeem, items: body.items, restaurantId,
      itemsText: fields.items_text, totalLempiras: total, customerUid: customer_uid });
    if (!prep.ok) return res.status(prep.status).json({ ...prep.body, order_id: orderId });   // non-payable, nothing written, NO reserve yet
    redemptionCanonical = prep.canonical;
    redemptionPriced = prep.priced;
    redemptionCost = prep.redemption.cost;
    effTotal = prep.priced.total_lempiras;
    fields.items_text = prep.itemsText;   // free-item display line → flows into BOTH fingerprints + the pending order
  }
  // Effective (discounted) breakdown used by both fingerprint sites, the pending record, and the charge amount.
  const effBreakdown = redemptionPriced
    ? { total_cents: redemptionPriced.total_cents, subtotal_cents: redemptionPriced.subtotal_cents, tax_cents: redemptionPriced.tax_cents,
        ...(redemptionPriced.desc_rebaja_cents ? { desc_rebaja_cents: redemptionPriced.desc_rebaja_cents } : {}) }  // A-F: factura comp rebaja (x_pizza only)
    : orderBreakdownCents(total, restaurantId);

  // ── A1 (#2, R7): a $0 order is NOT chargeable online. The forms route a fully-comped ($0) order to
  // createOrder (the free path); this is the DEFENSIVE server guard for a stale/direct $0 request. Return a
  // typed non-payable response HERE — after the reprice, but BEFORE any config read, availability read,
  // rate-limit write, reserve, or acquire — so a $0 request opens no attempt and holds no reward, and the
  // client re-routes to the free path. (Sub-min online is a forms-side concern — cash-only routing — and is
  // unreachable server-side given min-order + redemption economics, so no server threshold is invented.)
  if (effBreakdown.total_cents === 0) {
    return res.status(409).json({ error: 'not_payable_online', reason: 'free_order', detail: 'El pedido es gratis; confirmá sin pago', order_id: orderId });
  }

  // ── Item availability gate (KDS 2b · KDS_2B_PLAN.md §6/§7/§8, R4). AUTHORITATIVE placement (Slice-4 fix,
  // closes the classify↔acquire TOCTOU):
  //   1. Capture `nowTs` ONCE and feed the SAME value to BOTH classifyHostedAttempt (here) and
  //      acquireHostedAttempt (below), so their freshness/expiry math can't drift between the two calls.
  //   2. A READ-ONLY classify runs FIRST — but ONLY to skip the availability read for a MONOTONIC-terminal
  //      order (already_paid / conflict / closed): those can never become a fresh-URL path within a request,
  //      so we never re-reject a paid/closed order and never regress the "Already paid" success path.
  //   3. For EVERYTHING ELSE — a predicted fresh attempt, an in_progress or a reuse (both of which can drift
  //      to a rotate over the multi-await gap before the CAS), or a classify read error — we read
  //      availability ONCE and thread `cartBlocked` INTO acquireHostedAttempt. The block is then enforced at
  //      the AUTHORITATIVE fresh-issuance point INSIDE the CAS state machine (create/install/recover/rotate),
  //      NOT on classify's unreliable prediction. A genuine reuse of a still-live URL returns from acquire
  //      BEFORE the cartBlocked check, so it still proceeds (plan §7 accepted post-issue race).
  //   4. The read happens BEFORE any orders/{id}, payment_attempts/{id}, OR rate_limits write (before the
  //      rate-limit increment below and before acquireHostedAttempt), so a blocked (86'd) attempt writes
  //      NOTHING and cannot burn the phone/IP quota.
  //   5. FAIL-OPEN throughout: classify throw ⇒ read availability anyway (the CAS stays authoritative);
  //      checkItemAvailability is itself fail-open (read error ⇒ blocked:[] ⇒ acquire proceeds). A DB hiccup
  //      can never block a sale. materialize/scheduled-release do NOT re-check.
  // The fingerprint/slot here are recomputed read-only (pure, from the same inputs as the authoritative
  // computation below) purely to classify already_paid/conflict — the CAS remains the source of truth.
  const nowTs = Date.now();
  let cartBlocked = [];
  {
    const schedForRawG = SCHED.normalizeScheduledFor(body.scheduled_for);
    const isScheduledG = Number.isFinite(schedForRawG);
    const totalCentsG = effBreakdown.total_cents;   // discounted when redeemed → the read-only classify fingerprint matches the authoritative one
    const fingerprintG = orderFingerprint(orderId, totalCentsG, fields.items_text, isScheduledG ? SCHED.fingerprintExtra({ scheduled_for: schedForRawG, order_type: orderType }) : '');
    let clsG;
    try {
      clsG = await classifyHostedAttempt(db, orderId, fingerprintG, nowTs);
    } catch (e) {
      console.error(`chargeOnlineOrder: availability classify failed for ${orderId} (failing open, reading availability + deferring to the CAS)`, e && e.message);
      clsG = null;   // unknown → treat as non-terminal → read availability; acquireHostedAttempt stays authoritative
    }
    // Skip the read ONLY for a MONOTONIC-terminal order — one that provably can't drift into a fresh-URL
    // path within this request. in_progress / reuse are DELIBERATELY excluded (they can rotate → fresh),
    // so we read + let the CAS decide. acquire returns in_progress/reuse before the cartBlocked check.
    const MONOTONIC_TERMINAL = ['already_paid', 'conflict', 'closed'];
    const bypassGate = clsG && MONOTONIC_TERMINAL.includes(clsG.outcome);
    if (!bypassGate) {
      const availGate = await checkItemAvailability(db, body.items, restaurantId);
      cartBlocked = availGate.blocked;
    }
  }

  // Rate limit (same buckets as createOrder). A genuine retry of an in-flight
  // submit re-enters acquireHostedAttempt and reuses the live checkout, so this throttles
  // distinct submit bursts, not 3DS polling.
  // SLICE-4 (Codex fix #2): checkRateLimit is the ONLY DB write between the availability read and the
  // authoritative acquireHostedAttempt below. A blocked (86'd) cart is decided by acquire and can ONLY
  // resolve to item_unavailable / reuse / in_progress / terminal — NONE mint a fresh attempt — so it must
  // NOT burn rate-limit quota. Run checkRateLimit ONLY on the unblocked path (cartBlocked === []), where a
  // fresh write may proceed and must be throttled. So a state-drift-blocked fresh attempt writes NOTHING —
  // no order, no payment_attempt, AND no rate_limits.
  if (cartBlocked.length === 0) {
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
  }

  // Scheduled Orders (§B): an online order may be scheduled. Validate the slot SERVER-SIDE (open hours,
  // lead/horizon, granularity, UTC−6) BEFORE opening a payment attempt — fail-closed on a config outage.
  // Normalize absence BEFORE Number() — guards the Number(null)===0 trap (see SCHED.normalizeScheduledFor):
  // the forms send `scheduled_for: null` for a normal ASAP order → NaN → not finite → the ASAP path.
  const scheduledForRaw = SCHED.normalizeScheduledFor(body.scheduled_for);
  const isScheduled = Number.isFinite(scheduledForRaw);
  let scheduledReleaseAt = null;
  // Read hours for BOTH paths: validate the slot (scheduled) OR fail-close an ASAP order while CLOSED
  // (the client moved scheduling to Checkout and no longer blocks Paso 1). Fail-closed on a config outage.
  let schedIdentity;
  try {
    schedIdentity = await getRestaurantIdentity(db, restaurantId);
  } catch (e) {
    res.set('Retry-After', '2');
    return res.status(e.statusCode || 503).json({ error: 'Service temporarily unavailable', detail: 'restaurant config unavailable', retryable: true });
  }
  if (isScheduled) {
    const v = SCHED.validateScheduledFor(schedIdentity.hours, scheduledForRaw, Date.now(), orderType);
    if (!v.valid) return badRequest(res, `Invalid scheduled time (${v.reason})`);
    scheduledReleaseAt = SCHED.releaseAtFor(scheduledForRaw, orderType);
  } else if (SCHED.asapWhileClosed(schedIdentity.hours, scheduledForRaw, Date.now())) {
    return badRequest(res, 'Cerrado — programá tu pedido');
  }

  const { total_cents, subtotal_cents, tax_cents } = effBreakdown;   // discounted when redeemed (Task 4); else today's breakdown
  // Bind the slot into the fingerprint (R2-#3): a reused cart can't be charged against a different slot. When
  // redeemed, total_cents (discounted) + items_text (free line appended) make this fingerprint carry the reward
  // — the SAME fingerprint the reservation binds to (below), so hold ↔ order ↔ charge are one identity.
  const fingerprint = orderFingerprint(orderId, total_cents, fields.items_text, isScheduled ? SCHED.fingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '');

  // Factura inputs (FACTURA_PLAN §2) — structured priced items for the factura trigger.
  // factura_status starts 'not_due': a pending_payment order is NOT yet a Sale, so it's
  // never reconciled; the trigger only acts once it materializes (status:new + confirmed).
  const facturaPriced = redemptionPriced
    ? { items: (usesPlatformFactura(restaurantId) ? redemptionPriced.factura_items : null), error: null }   // discounted split (x_pizza) / skipped (la_musa)
    : (usesPlatformFactura(restaurantId)
      ? pricedLineItems(body.items, MENU_PRICES, EXTRA_PRICES)
      : { items: null, error: null });  // non-platform (la_musa) → no factura line items

  // (customer_uid was resolved EARLY, above — the redemption prepare + both fingerprint sites need it.)

  // The HIDDEN pending order. Mirrors createOrder's orderRecord (so Stage-4
  // confirm can materialize tasks/tracking from it) but status=pending_payment,
  // payment_status=pending, and NO tasks/tracking/WhatsApp yet.
  const now = ServerValue.TIMESTAMP;
  const pendingOrderRecord = {
    order_id: orderId,
    customer_name: fields.customer_name,
    customer_phone: fields.customer_phone,
    items_text: fields.items_text,            // includes the La Musa free-item display line when redeemed
    total: effTotal,                          // discounted total (== total when no redeem)
    total_cents, subtotal_cents, tax_cents,   // discounted breakdown when redeemed; else x_pizza ISV 15% incl. / la_musa no split
    ...(effBreakdown.desc_rebaja_cents ? { desc_rebaja_cents: effBreakdown.desc_rebaja_cents } : {}),   // A-F: factura comp rebaja (x_pizza only)
    ...(redemptionCanonical ? { redemption: redemptionCanonical } : {}),   // bind the reward to the order (reserved until confirm consumes/holds)
    notes: fields.notes,
    payment_method: 'online',
    payment_status: 'pending',
    order_type: orderType,
    status: 'pending_payment',
    created_at: now,
    // --- factura (SAR) fields ---
    restaurant_id: restaurantId,
    factura_status: 'not_due',
    cash_tendered_cents: 0,                     // online: no cash, CAMBIO 0
    ...(facturaPriced.items ? { items: facturaPriced.items } : {}),
    ...(fields.razon_social ? { razon_social: fields.razon_social } : {}),
    ...(fields.rtn_cliente ? { rtn_cliente: fields.rtn_cliente } : {}),
    ...(customer_uid ? { customer_uid } : {}),   // H2: verified logged-in attribution (guest → absent)
    // P3: the ONLY place the online path has body.items — plumb the normalized reorder recipe onto the
    // pending order so materialize.js can copy it into user_orders/{uid}.items at CONFIRM (never pending).
    ...(customer_uid ? { reorder_items: normalizeReorderItems(body.items, restaurantId) } : {})
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
  // Scheduled Orders: carry the slot on the pending record. Confirm HOLDS it (status:scheduled, no
  // materialize); the sweep releases it at release_at. Stays factura not_due + no tracking until release.
  if (isScheduled) {
    pendingOrderRecord.scheduled_for = scheduledForRaw;
    pendingOrderRecord.release_at = scheduledReleaseAt;
  }

  // Read-only reuse probe (#3): config is read ONLY when creating a fresh pending order, so a
  // customer reusing a live hosted checkout during a config outage is NOT failed closed. The CAS
  // in acquireHostedAttempt stays authoritative; on a probe-fresh/CAS-reuse race the only cost is
  // one wasted config read.
  let probeOrder;
  try {
    probeOrder = (await db.ref(`orders/${orderId}`).once('value')).val();
  } catch (e) {
    console.error(`chargeOnlineOrder: order probe failed for ${orderId}`, e.message);
    return res.status(500).json({ error: 'Database error', detail: e.message });
  }
  // Cross-restaurant reuse guard (legacy-normalized): a charge must not attach to an existing
  // order_id owned by a different restaurant. Runs before the CAS/fingerprint in acquireHostedAttempt.
  if (probeOrder && !sameRestaurant(probeOrder.restaurant_id, restaurantId)) {
    console.warn(`chargeOnlineOrder: ${orderId} exists for a different restaurant — conflict`);
    return res.status(409).json({ error: 'Order conflict', detail: 'order_id already used for a different restaurant', order_id: orderId });
  }
  if (!probeOrder) {
    // Fresh pending-order creation → gate + zone + immutable charge-time snapshot BEFORE persistence.
    let id;
    try {
      id = await getRestaurantIdentity(db, restaurantId);
    } catch (e) {
      console.error(`chargeOnlineOrder: config unavailable for ${orderId}: ${e.message}`);
      res.set('Retry-After', '2');
      return res.status(e.statusCode || 503).json({ error: 'Service temporarily unavailable', detail: 'restaurant config unavailable', retryable: true });
    }
    if (!id.active) {
      console.warn(`chargeOnlineOrder: ${restaurantId} inactive — rejecting ${orderId}`);
      return res.status(400).json({ error: 'Restaurant closed', detail: 'Not accepting orders right now' });
    }
    if (orderType === 'delivery') {
      const distanceKm = haversineKm(lat, lng, id.hub_lat, id.hub_lng);
      if (distanceKm > id.delivery_radius_km) {
        return badRequest(res, `Outside delivery zone (${distanceKm.toFixed(1)}km from restaurant, max ${id.delivery_radius_km}km)`);
      }
    }
    Object.assign(pendingOrderRecord, hubSnapshot(id)); // immutable snapshot on the fresh pending order
  }

  // ── A1 (#2, R7): PixelPay config + return-base — resolved HERE, after the reprice + $0 guard + ALL
  // non-PixelPay gates (availability / rate-limit / schedule / active / zone), but BEFORE the reserve +
  // acquire. Fail fast (500) if production creds / the return URL are missing, so we NEVER open an attempt
  // (reserve/acquire) we can't sign — while a $0 (free) order already returned above and never reaches this.
  // FAIL-CLOSED for la_musa if the return base is unconfigured (never fall back to the x_pizza origin).
  let pp;
  try {
    pp = resolvePixelPayConfig();
  } catch (e) {
    console.error('chargeOnlineOrder: PixelPay config error', e.message);
    return res.status(500).json({ error: 'Payment not configured', detail: e.message });
  }
  const returnBase = resolveReturnBase(restaurantId, process.env);
  if (returnBase.error) {
    console.error(`chargeOnlineOrder: ${returnBase.error} for ${orderId} (${restaurantId})`);
    return res.status(500).json({ error: 'Payment not configured', detail: 'return URL not configured for restaurant' });
  }

  // ── Rewards Phase B1 (online): RESERVE the hold NOW — after ALL placeability (slot/closed/active/zone),
  // so the only post-reserve failures are the acquire outcomes + hosted-create, each released below. Bound to
  // the SAME payment fingerprint the attempt uses → hold ↔ order ↔ charge are one identity. Idempotent: a
  // retry/reuse returns 'reused' (a prior attempt's hold → we do NOT own the debit).
  let redemptionOwnsHold = false;
  if (redemptionCanonical) {
    // hosted_expires_at bound AT RESERVE = nowTs + HOSTED_TTL_MS — IDENTICAL to acquireHostedAttempt's
    // expires_at (same nowTs, same TTL) — so an unattached hold is sweep-visible immediately; attach refines
    // to the exact attempt expiry (same value). Closes the crash/attach-fail orphan by construction.
    const rr = await reserveRedemption(db, { uid: customer_uid, rid: restaurantId, orderId, cost: redemptionCost,
      canonical: redemptionCanonical, orderFingerprint: fingerprint, configVersion: REDEMPTION_CONFIG_VERSION, now: nowTs, hostedExpiresAt: nowTs + HOSTED_TTL_MS });
    if (!rr.ok) return res.status(409).json({ error: 'redemption_reserve_failed', reason: rr.reason, order_id: orderId });
    redemptionOwnsHold = (rr.action === 'created' || rr.action === 're_reserved');
  }
  // Release THIS call's hold on a truly-ABANDONED acquire/hosted-create outcome — ONLY if we own the debit
  // (created/re_reserved). A 'reused' hold belongs to a prior in-flight attempt → NEVER release. in_progress /
  // reuse PRESERVE the hold (a creating/live checkout is backed by it — releasing would strand a payable URL).
  const releaseHoldIfOwned = async () => {
    if (redemptionOwnsHold) await releaseRedemption(db, { uid: customer_uid, rid: restaurantId, orderId, now: Date.now() }).catch(() => {});
  };

  // Acquire the hosted-charge lock + attempt (create-claim state machine; HOSTED-PAYMENT-PLAN.md).
  let acq;
  try {
    acq = await acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, nowTs, cartBlocked);
  } catch (e) {
    console.error(`chargeOnlineOrder: hosted acquire failed for ${orderId}`, e.message);
    await releaseHoldIfOwned();   // abandoned: no attempt written → release our hold
    return res.status(500).json({ error: 'Database error', detail: e.message });
  }

  // Authoritative intake gate (Slice-4): a fresh/rotated payable URL was about to be minted for a 86'd
  // cart → the CAS aborted BEFORE any write. Respond 400 with the blocked labels; nothing was persisted.
  if (acq.outcome === 'item_unavailable') {
    console.warn(`chargeOnlineOrder: rejecting ${orderId} at the CAS — unavailable item(s): ${(acq.blocked || []).join(', ')}`);
    await releaseHoldIfOwned();   // abandoned: CAS aborted before any write → release our hold
    return res.status(400).json({ error: 'item_unavailable', blocked: acq.blocked || [] });
  }
  if (acq.outcome === 'already_paid') {
    await releaseHoldIfOwned();   // abandoned for THIS call (order already paid via another attempt)
    return res.status(409).json({ error: 'Already paid', detail: 'This order is already confirmed paid', order_id: orderId });
  }
  if (acq.outcome === 'conflict') {
    await releaseHoldIfOwned();   // abandoned: order_id used for a different cart/total
    return res.status(409).json({ error: 'Order conflict', detail: 'order_id already used for a different cart/total', order_id: orderId });
  }
  if (acq.outcome === 'closed') {
    await releaseHoldIfOwned();   // abandoned: order is in a terminal-closed state
    return res.status(409).json({ error: 'Order closed', detail: `order is ${acq.reason}; please start a new order`, order_id: orderId });
  }
  if (acq.outcome === 'in_progress') {
    // A checkout is being created for this order — don't start a 2nd (one-live-checkout, I10). PRESERVE the
    // hold: the concurrent creating checkout is backed by it (releasing would strand a payable discounted URL).
    return res.status(202).json({ ok: true, status: 'in_progress', detail: 'a checkout is being created; retry shortly', order_id: orderId });
  }
  // Double-submit while a checkout is still live → return the SAME url (I10). PRESERVE the hold (the live
  // checkout it backs is being reused; this call's reserve was 'reused' → we don't own it anyway).
  if (acq.outcome === 'reuse') {
    console.log(`chargeOnlineOrder: reuse live hosted checkout ${orderId}-${acq.attempt_id}`);
    return res.status(200).json({ ok: true, order_id: orderId, attempt_id: acq.attempt_id, poll_token: acq.poll_token, checkout_url: acq.checkout_url, payment_status: 'pending' });
  }
  if (acq.outcome !== 'claimed') {
    await releaseHoldIfOwned();   // abandoned: no fresh attempt minted
    return res.status(503).json({ error: 'Could not start payment', detail: 'please retry', order_id: orderId });
  }

  // Claimed a FRESH attempt → bind it to the reservation (attempt_id + hosted_expires_at) for the sweep +
  // Task-7 consume/hold at confirm. Idempotent; only when this order carries a reward.
  if (redemptionCanonical) {
    await attachAttempt(db, { uid: customer_uid, rid: restaurantId, orderId, attemptId: acq.attempt_id, hostedExpiresAt: acq.expires_at, now: nowTs }).catch(() => {});
  }

  // We own a FRESH attempt in hosted_state:'creating' (hosted_order_id already persisted by the
  // claim, so a racing paid callback can still bind/recover — I7). Create the hosted checkout with
  // the SERVER-SET amount, then mark the attempt 'created'.
  const attemptId = acq.attempt_id;
  const pixelpayOrderId = acq.hosted_order_id;            // `${orderId}-${attemptId}`
  const pollToken = acq.poll_token;
  const amountStr = centsToLempiras(total_cents);          // real server total (NOT the sandbox 1-14 map) so the callback amount-check holds

  // PixelPay requires first+last name (each ≥3 chars) and a valid email. Pad short parts with
  // dots so a short / single-word name never blocks checkout (the real name is on the order record).
  const pad3 = (s) => { s = String(s || '').trim(); while (s.length < 3) s += '.'; return s; };
  const nameParts = String(fields.customer_name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = pad3(nameParts[0] || 'Cliente');
  const lastName = pad3(nameParts.slice(1).join(' ') || nameParts[0] || 'Cliente');
  const rawEmail = body.customer_email;
  // Fallback when the customer leaves the (optional) email blank: it MUST be a deliverable, PixelPay-accepted
  // address. The former 'pedidos@xpizza.hn' is on a domain with NO MX record → PixelPay's email validation
  // intermittently rejects it ({"_email": invalid}), failing card checkout for every blank-email order.
  // PIXELPAY_MERCHANT_EMAIL is PixelPay's own registered merchant user (a real gmail.com address, valid MX)
  // so it can never be rejected. A customer-supplied valid email is used unchanged — only the fallback moves.
  const fallbackEmail = process.env.PIXELPAY_MERCHANT_EMAIL || 'pedidos@lamusa.hn';   // both deliverable (MX-valid)
  const email = (typeof rawEmail === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail.trim())) ? rawEmail.trim() : fallbackEmail;

  // Customer-facing return URLs + the AUTHENTICATED server callback (?secret=…).
  // IMPORTANT: the return URLs use the ORDER-SITE origin (where the return/poll page lives),
  // NOT pp.app_url — that's the PixelPay ENDPOINT (it's the x-client-signature app_url, a
  // different thing; reusing it would redirect the paid customer to the bank's domain).
  // Restaurant-aware base, resolved + fail-closed up front (see resolveReturnBase above).
  // x_pizza → PIXELPAY_RETURN_URL || the orders site (unchanged); la_musa → its own origin.
  const siteBase = returnBase.base;
  const completeUrl = `${siteBase}/?pay=complete&order=${encodeURIComponent(orderId)}&t=${encodeURIComponent(pollToken)}`;
  const cancelUrl = `${siteBase}/?pay=cancel&order=${encodeURIComponent(orderId)}`;
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
    await releaseHoldIfOwned();   // hosted-create failed after claim → abandoned → release our hold
    return res.status(502).json({ error: 'Payment gateway error', detail: 'could not create checkout; please retry', order_id: orderId });
  }

  if (!hosted.ok || !hosted.url) {
    console.error(`chargeOnlineOrder: hosted create rejected for ${pixelpayOrderId}`, JSON.stringify(hosted.errors || hosted.raw || {}).slice(0, 400));
    await db.ref(`payment_attempts/${attemptId}`).update({ hosted_state: 'failed_create', failed_create_reason: JSON.stringify(hosted.errors || {}).slice(0, 300), updated_at: now }).catch(() => {});
    await releaseHoldIfOwned();   // hosted-create rejected after claim → abandoned → release our hold
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
  if (o === 'voided_inactive') {
    // 3c: auth voided because the Restaurant was deactivated — terminal failure, client must NOT retry.
    return res.status(200).json({ ok: false, payment_status: 'failed', order_id: orderId, detail: 'restaurant not accepting orders; payment authorization voided' });
  }
  if (o === 'in_progress' || o === 'capture_error_retryable' || o === 'no_payment_uuid' || o === 'config_unavailable_retryable') {
    return res.status(202).json({ ok: false, pending: true, order_id: orderId, detail: o === 'config_unavailable_retryable' ? 'restaurant config temporarily unavailable; keep polling' : 'payment processing; keep polling' });
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
    getIdentity: getRestaurantIdentity,   // 3c: confirm-time active-recheck (plan 10b)
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

    // Parse + handle the hosted callback (the authoritative paid signal). Dedup by a unique
    // event id (transaction_id) so PixelPay's 3x/15min retries don't double-process; the
    // handler is also idempotent (materialized_at) as a backstop.
    const db = getDatabase();
    const b = req.body || {};
    const eventId = rateLimitKey(String(b.transaction_id || b.uuid || b.order || b.ref || 'unknown'));
    try {
      const claim = await db.ref(`webhook_events/${eventId}`).transaction((cur) => {
        if (cur && cur.state === 'done') return;                                    // already handled
        if (cur && cur.state === 'processing' && Date.now() - (cur.at || 0) < 120000) return; // in flight
        return { state: 'processing', at: Date.now(), order: String(b.order || b.ref || '') };
      });
      if (!claim.committed) return res.status(200).json({ ok: true, deduped: true });
    } catch (e) {
      console.error('pixelPayWebhook: event claim failed (proceeding)', e.message);
    }

    let result = { code: 500, outcome: 'error' };
    try {
      const deps = { ...confirmDeps(db), genToken: generateTrackingToken };
      result = await handleHostedCallback(deps, b, Date.now());
    } catch (e) {
      console.error('pixelPayWebhook: handler threw', e.message);
      result = { code: 500, outcome: 'handler_error' };
    }
    // 2xx → durable decision (done); 5xx → transient (failed) so a PixelPay retry re-runs (I5/R2-3).
    const finalState = (result.code >= 200 && result.code < 300) ? 'done' : 'failed';
    try { await db.ref(`webhook_events/${eventId}`).update({ state: finalState, outcome: result.outcome, done_at: Date.now() }); } catch (_) {}

    console.log(`pixelPayWebhook: ${String(b.order || b.ref || '?')} -> ${result.outcome} (${result.code})`);
    return res.status(result.code).json({ ok: result.code < 300, outcome: result.outcome });
  }
);

// ============================================================
// paymentStatus — public hosted-payment status poll (for the _complete return page)
// ============================================================
//
// After paying on the hosted checkout the customer returns to ?pay=complete&order&t; the page
// polls this to learn the outcome (the webhook remains the money authority). Gated by the
// per-attempt poll_token (only the customer who started THIS payment can read it). Returns a
// COARSE state + the tracking_token once paid — never order PII.
exports.paymentStatus = onRequest(
  { region: 'us-central1', cors: true, timeoutSeconds: 10, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    const orderId = String((req.query && req.query.order_id) || (req.body && req.body.order_id) || '').trim();
    const token = String((req.query && (req.query.t || req.query.token)) || (req.body && req.body.token) || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId) || !token || token.length > 128) {
      return res.status(400).json({ error: 'bad request' });
    }
    const db = getDatabase();
    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!order) return res.status(404).json({ error: 'not found' });

    // Gate on the active attempt's poll_token (constant-time). No match → no info.
    const attemptId = order.active_attempt_id;
    const attempt = attemptId ? (await db.ref(`payment_attempts/${attemptId}`).once('value')).val() : null;
    if (!attempt || !attempt.poll_token || !constantTimeEqual(String(attempt.poll_token), token)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Coarse, public-safe state.
    const ps = order.payment_status, st = order.status;
    // A2/A5/#6 — poll-token-gated SAFE SUMMARY for the online-return success screen. After the PixelPay
    // redirect the in-memory redeem quote is gone, so the return page can't recompute the discounted total.
    // This gives it the SERVER-CONFIRMED total_cents + a minimal redemption summary (discount + freed/added
    // item name + model) so the success Total + reward display come from the server, not stale client values.
    // Poll-token-gated (only the customer who started THIS payment) → their own order money/reward, no PII.
    const redeemSummary = order.redemption
      ? { discount_cents: Number(order.redemption.discount_cents) || 0, free_item: order.redemption.free_item_key || null, model: order.redemption.model || null }
      : null;
    // Scheduled Orders (§B.4 / R2-#4): a paid-and-HELD order (or one mid-release) matches the paid check
    // below (confirmed) but is NOT cooking. Return a distinct scheduled_paid state carrying scheduled_for
    // (no tracking token) so the form shows "programado para <slot>", never "ya está en cocina".
    if (st === 'scheduled' || st === 'releasing') {
      return res.status(200).json({ ok: true, state: 'scheduled_paid', scheduled_for: order.scheduled_for || null, tracking_token: null,
        total_cents: Number.isFinite(order.total_cents) ? order.total_cents : null, redemption: redeemSummary });
    }
    let state = 'pending';
    if (ps === 'confirmed' || ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered'].includes(st)) state = 'paid';
    else if (st === 'cancelled' || ps === 'refunded' || ps === 'refund_pending') state = 'cancelled';
    else if (ps === 'failed') state = 'failed';
    else if (ps === 'manual_reconciliation') state = 'verifying';

    return res.status(200).json({ ok: true, state, tracking_token: state === 'paid' ? (order.tracking_token || null) : null,
      total_cents: state === 'paid' ? (Number.isFinite(order.total_cents) ? order.total_cents : null) : null,
      redemption: state === 'paid' ? redeemSummary : null });
  }
);

// ============================================================
// claimPrefill — Track A: token-gated name+phone lookup for the profile-claim soft-fill
// ============================================================
//
// The tracker's "Crear mi perfil" deep-links to the order form with ?claim=<order_id>#t=<tracking_token>
// (token in the URL FRAGMENT — never sent to servers/Referer/logs; MF1). The order form POSTs {order_id,
// token} here to soft-fill the create-profile sheet with the just-ordered customer's OWN name+phone (one tap
// → OTP, no re-type). Capability = the tracking_token, which is bound to exactly ONE order: we return the
// phone ONLY when order_tracking/{token}.order_id STRICTLY equals the requested order_id. Read-only, returns
// NO other PII (no address/items/uid), per-IP throttled (MF3 — this returns phone PII), and account creation
// stays OTP-gated so a leaked token can't hijack. Money path untouched.
exports.claimPrefill = onRequest(
  { region: 'us-central1', cors: true, timeoutSeconds: 10, memory: '256MiB', maxInstances: 5 },
  async (req, res) => {
    // MF-A: POST-only, and read {order_id, token} from the JSON BODY ONLY. A query-string token would
    // reintroduce the exact URL / access-log leak the fragment transport (MF1) exists to prevent.
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    const orderId = String((req.body && req.body.order_id) || '').trim();
    const token = String((req.body && req.body.token) || '').trim();
    // Missing/malformed order_id → 403 (no info). Token must be present + RTDB-path-safe (real tokens are 12
    // alphanumerics) so `order_tracking/{token}` can never be a path-injection.
    const db = getDatabase();
    // MF-B (R2) — throttle per-TOKEN, not per-IP. On Cloud Run the Functions Framework enables `trust proxy`,
    // so req.ip resolves to the client-APPENDED left-most X-Forwarded-For (spoofable) — an IP key is bypassable
    // by rotating the header. The tracking_token is the spoof-PROOF capability, and the real abuse is repeated
    // pulls of ONE leaked link's phone → a per-token cap limits that directly, independent of IP spoofability.
    // checkRateLimit hashes the key (the token never sits in rate_limits in the clear). BEFORE the DB read.
    // An empty token → checkRateLimit no-ops (allowed) → the core 403s it (missing token).
    const rl = await checkRateLimit(db, 'claim_token', token, RATE_LIMIT_BUCKETS.claim_token);
    if (!rl.allowed) { res.set('Retry-After', String(rl.retryAfterSec)); return res.status(429).json({ error: 'Too Many Requests' }); }
    // Validation + token↔order STRICT bind + phone lookup — pure core (claim-prefill.js), emulator-tested.
    const r = await claimPrefillCore(db, orderId, token);
    return res.status(r.status).json(r.body);
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
    const GRACE_MS = 15 * 60 * 1000;   // PixelPay retries the callback 3x/15min after expiry
    const RESOLVE_STALE_MS = 10 * 60 * 1000;   // recover a CRASHED resolve: >> the 60s fn timeout so an in-flight resolve is never reverted
    const snap = await db.ref('orders').orderByChild('status').equalTo('pending_payment').once('value');
    const orders = snap.val() || {};
    let flagged = 0, left = 0;

    for (const orderId of Object.keys(orders)) {
      const order = orders[orderId];
      if (order.payment_method !== 'online') continue;
      // [rev-5 D / R2-#2] Phase-aware recovery for a CRASHED resolve. Pre-side-effect stale → revert to
      // manual_reconciliation (safe, no money moved); post-side-effect stale → manual_review + alert, NEVER
      // back to re-resolvable (a 2nd resolver could re-void). CAS on the claim_id so a live resolve is untouched.
      if (MR.isResolving(order.payment_status)) {
        await recoverStaleResolve(resolveDeps(db), orderId, order, now, RESOLVE_STALE_MS); // [D] phase-aware CAS recovery
        continue;
      }
      if (MR.isStatusChangeClosedToAutomation(order.payment_status)) continue; // skip terminal / manual_reconciliation
      const attempt = order.active_attempt_id
        ? (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val()
        : null;
      if (!attempt || attempt.hosted_state === 'paid') { left++; continue; }

      // Hosted: a checkout is payable until hosted_expires_at. Past expiry + the callback-retry
      // grace with no paid callback is AMBIGUOUS (paid-but-lost is possible; no uuid to query) →
      // manual_reconciliation, NEVER failed (I6). Within the window → leave (live flow may finish).
      if (attempt.hosted_state === 'creating' || attempt.hosted_state === 'created') {
        const expires = Number(attempt.hosted_expires_at) || 0;
        if (expires && now > expires + GRACE_MS) {
          try {
            await db.ref(`payment_attempts/${order.active_attempt_id}`).update({ hosted_state: 'manual_reconciliation', manual_reason: 'stale_no_callback', flagged_at: now });
            await db.ref(`orders/${orderId}`).update({ payment_status: 'manual_reconciliation' });
            await paymentAlert(db, 'hosted_stale_no_callback', { orderId, total: order.total || null });
            flagged++;
          } catch (e) { console.error(`sweep: flag failed ${orderId}`, e.message); }
        } else { left++; }
      } else { left++; }
    }
    console.log(`sweepStalePending: manual_flagged=${flagged} left=${left}`);
  }
);

// ============================================================
// resetItemAvailability — KDS Phase 2b: end-of-business-day availability auto-reset
// ============================================================
//
// Every 30 min (Tegucigalpa clock), returns each restaurant's sold-out ("86'd") items to available WHILE
// CLOSED, once per business day (Square's default). Logic lives in ./availability-reset.js (unit-tested with
// an injected clock). ISOLATION: reads/writes ONLY item_availability + availability_reset_marker under
// /restaurants/{rid}; only WIDENS (sold-out → available); a crashed partial run self-heals on the next tick.
// R4: the cutoff is the RTDB server-time started_at (ServerValue.TIMESTAMP, read back), never Date.now().
exports.resetItemAvailability = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const { runAvailabilityReset } = require('./availability-reset');
    // Config parsed INSIDE the handler (never module top-level) with a local try/catch + default, so a bad
    // env var can't break the co-resident HTTPS/payment/sweep functions at cold start.
    let restaurants;
    try {
      const raw = process.env.AVAILABILITY_RESET_RESTAURANTS;
      const parsed = raw ? JSON.parse(raw) : null;
      restaurants = Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : undefined;
    } catch (e) {
      console.error('resetItemAvailability: bad AVAILABILITY_RESET_RESTAURANTS — using default', e.message);
      restaurants = undefined;
    }
    // now = wall clock (closed-gate + marker date); the server-time cutoff comes from ServerValue.TIMESTAMP.
    await runAvailabilityReset({ db: getDatabase(), ServerValue, now: Date.now(), restaurants });
  }
);

// ============================================================
// driverFreshnessMonitor — Driver Tracking C1: the missing safety net. A scheduled sweep (~every 1 min,
// America/Tegucigalpa) that alarms dispatch when an ON-SHIFT driver's phone goes dark — a freeze, revoked
// permission, or dead battery that dispatch would otherwise catch only by staring at pins.
//
// Freshness = drivers/<uid>/last_ping (SERVER-received ServerValue.TIMESTAMP — the same field dispatch
// stales pins on, clock-consistent with Date.now(); NOT last_location_ts, which is device GPS-fix time).
// Dispatch already ambers a pin at 90s; this ALARM sits higher (config default 180s) so it fires on genuine
// freezes, not routine GPS gaps. Threshold = config/driver_freshness_alert_sec (tunable WITHOUT a redeploy).
//
// Alerts are KEYED at dispatcher_alerts/driver_stale_<uid> (the existing floating-alerts channel), so the
// pure reconcile core (driver-freshness.js) raises exactly ONE alert per silence episode (no per-tick storm),
// auto-clears on recovery / clock-off / disappearance, and never touches other alert types. Off-shift drivers
// never alert. Needs NO env (RTDB reads + an alert write). Fail-safe: any read failure skips the tick (no writes).
exports.driverFreshnessMonitor = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db = getDatabase();
    const now = Date.now();

    // Threshold from config (tunable without a redeploy); default 180s. Fail-safe to the default on any issue.
    let thresholdSec = 180;
    try {
      const v = (await db.ref('config/driver_freshness_alert_sec').once('value')).val();
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) thresholdSec = v;
    } catch (e) {
      console.warn('driverFreshnessMonitor: config read failed, using default 180s', e.message);
    }

    let drivers, existingAlerts;
    try {
      const [dSnap, aSnap] = await Promise.all([
        db.ref('drivers').once('value'),
        db.ref('dispatcher_alerts').once('value'),
      ]);
      drivers = dSnap.val() || {};
      existingAlerts = aSnap.val() || {};
    } catch (e) {
      console.error('driverFreshnessMonitor: read failed, skipping tick', e.message);
      return;   // fail-safe: no reads ⇒ no writes
    }

    const keyed = computeFreshnessAlerts({
      drivers, existingAlerts, now, thresholdMs: thresholdSec * 1000, createdAt: ServerValue.TIMESTAMP,
    });
    const keys = Object.keys(keyed);
    if (keys.length === 0) return;

    const updates = {};
    for (const k of keys) updates[`dispatcher_alerts/${k}`] = keyed[k];
    const raised = keys.filter((k) => keyed[k] !== null).length;
    try {
      await db.ref().update(updates);
      console.log(`driverFreshnessMonitor: ${raised} raised, ${keys.length - raised} cleared (threshold ${thresholdSec}s)`);
    } catch (e) {
      console.error('driverFreshnessMonitor: alert write failed', e.message);
    }
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
      // [B.10] Phase-aware recovery for a stale resolving_action='cancel' claim (ANY method — a crashed cancel;
      // checked BEFORE the online-only filter since cash cancels can strand a claim too). Full order scan is the
      // only place these live claims are reachable (they aren't pending_payment). CAS on cancel_claim_id.
      if (o.resolving_action === 'cancel') {
        await recoverStaleCancel({ db, alert: (k, d) => paymentAlert(db, k, d) }, orderId, o, now, 6 * 3600 * 1000);
        continue;                                                      // mid-cancel — skip the payment breach-checks
      }
      // Scheduled Orders (§E / R1-#7,#14): a held (scheduled/releasing) order is LEGITIMATE until its
      // release_at — NEVER flag it by charged_at age. Only alert when it's genuinely overdue: past
      // release_at+SLA (still unreleased) or past scheduled_for+grace (never served, capture-now liability).
      if (o.status === 'scheduled' || o.status === 'releasing') {
        const ov = SCHED.scheduledOverdue(o, now);
        if (ov.overdue) breaches.push({ orderId, kind: ov.kind });
        continue;
      }
      if (o.payment_method !== 'online') continue;
      const a = o.active_attempt_id ? attempts[o.active_attempt_id] : null;
      // I2: a confirmed online order must have a VERIFIED payment — a verified hosted callback
      // (hosted_callback_verified) or, for legacy auth+capture orders, a captured attempt.
      if (o.payment_status === 'confirmed' && !(a && (a.hosted_callback_verified || a.status === 'captured' || a.capture_verified))) {
        breaches.push({ orderId, kind: 'confirmed_without_verified_payment' });
      }
      // Aged operator-queue states.
      const age = now - (Number(o.charged_at || o.created_at) || now);
      if (o.payment_status === 'manual_reconciliation' && age > 6 * 3600 * 1000) breaches.push({ orderId, kind: 'aged_manual_reconciliation' });
      if (o.payment_status === 'refund_pending' && age > 6 * 3600 * 1000) breaches.push({ orderId, kind: 'aged_refund_pending' });
      if (MR.isResolving(o.payment_status) && (now - (Number(o.resolving_claimed_at) || 0)) > 6 * 3600 * 1000) breaches.push({ orderId, kind: 'aged_resolving' }); // [D] sweep-recovery backstop

    }
    // Stuck claims never recovered: legacy capturing (crash mid-capture) or hosted creating
    // (crashed after the create-claim but the checkout/callback never resolved).
    for (const id of Object.keys(attempts)) {
      const a = attempts[id];
      if (a.status === 'capturing' && now - (Number(a.capturing_started_at) || now) > 3600 * 1000) {
        breaches.push({ attemptId: id, orderId: a.order_id, kind: 'stuck_capturing' });
      }
      if (a.hosted_state === 'creating' && now - (Number(a.hosted_created_at) || now) > 3600 * 1000) {
        breaches.push({ attemptId: id, orderId: a.order_id, kind: 'stuck_creating' });
      }
    }

    if (breaches.length) {
      console.warn('reconcilePayments: breaches', JSON.stringify(breaches));
      await paymentAlert(db, 'reconcile_breaches', { count: breaches.length, breaches: breaches.slice(0, 50) });
    } else {
      console.log('reconcilePayments: no breaches');
    }

    // ── Rewards Phase B1: reconcile redemption reservations (money-safety backstops) ──
    // (1) release ABANDONED holds — online past hosted_expires_at, cash orphan/cancelled (sweepStaleReservations);
    // (2) consume-recovery — holds stuck 'reserved' on an order that already materialized/delivered/completed
    // (orders/* and user_rewards/* are NOT one atomic write, so a failed primary consume must be caught here).
    // Both are idempotent + fail-open; alert on aged/audited so a human sees a persistent stuck hold.
    try {
      // Order matters (belt-and-suspenders — the online-release branch is now self-guarding anyway):
      // realize paid-but-consume-failed holds FIRST, THEN release genuinely-abandoned ones.
      const rec = await sweepConsumeRecovery(db, { now });
      const rel = await sweepStaleReservations(db, { now });
      if (rel.audited.length || rec.aged.length) {
        await paymentAlert(db, 'redemption_sweep', { released: rel.released.length, audited: rel.audited.slice(0, 20), consume_recovered: rec.consumed.length, aged: rec.aged.slice(0, 20) });
      }
      if (rel.released.length || rec.consumed.length) console.log(`reconcilePayments: redemption sweep — released ${rel.released.length}, consume-recovered ${rec.consumed.length}`);
    } catch (e) { console.error('reconcilePayments: redemption sweep failed', e && e.message); }
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
//   action 'abandon'     → dispatcher verified NO charge on the PixelPay portal: a
//                          missed order, not a lost charge. Terminal — clears the queue.
//                          Refused if a payment_uuid is recorded (real charge → refund).
// Auth: RECON_SECRET (server) OR a dispatcher Firebase ID token (the dashboard
// Pedidos view). Records an audit entry keyed by the verified actor.
// Deps for the extracted manual-resolve money state machine (resolve-manual.js) — mirrors confirmDeps.
function resolveDeps(db) {
  return {
    db,
    client: pixelpayClient,
    buildMaterializeUpdates,
    restaurant: RESTAURANT,
    genToken: generateTrackingToken,
    getIdentity: getRestaurantIdentity,   // paid-after-close re-check at manual materialize (Codex-on-diff)
    alert: (kind, detail) => paymentAlert(db, kind, detail),
    sanitizeText,
    serverTimestamp: ServerValue.TIMESTAMP,
  };
}

// Deps for the universal dispatcher-cancel core (cancel-order-core.js).
function cancelDeps(db) {
  return {
    db,
    client: pixelpayClient,     // voidOrRefund needs the PixelPay client
    voidOrRefund,               // shared void helper (honors the pre-void markSideEffectStarted hook)
    alert: (kind, detail) => paymentAlert(db, kind, detail),
    serverTimestamp: ServerValue.TIMESTAMP,
  };
}

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
    if (!['materialize', 'refund', 'keep', 'abandon'].includes(action)) return badRequest(res, 'action must be materialize|refund|keep|abandon');

    const db = getDatabase();
    const crypto = require('crypto');
    // The money state machine lives in resolve-manual.js (deps injected) so the emulator F-matrix drives it
    // with REAL concurrent transactions. This wrapper is a thin adapter: auth (above) → core → HTTP.
    const result = await resolveManualReconciliationCore(resolveDeps(db), {
      orderId, action, actor, note: body.note, now: Date.now(), claimId: crypto.randomUUID(),
    });
    return res.status(result.status).json(result.body);
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
    // Scheduled Orders: a paid-scheduled order is confirmed + unmaterialized but must NOT auto-release
    // here — it materializes ONLY at release (scheduled→releasing→new, scheduled-release-core). Gate this
    // recovery trigger to pending_payment-origin confirms only.
    if (after.status === 'scheduled' || after.status === 'releasing') return;
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
// allocateFacturaOnSale — issue a SAR factura when an order becomes a Sale (ADR-0003)
// ============================================================
//
// Fires on every /orders write but acts only when the order is a fresh Sale still owing a
// factura (facturaSaleEligible: status:new + online-confirmed + factura_status:'not_due' +
// past the launch cutoff). Covers cash/card_delivery (Sale at creation) AND every online
// materialize route (confirm, hosted webhook, recovery, manual reconciliation) uniformly,
// because they all land the same order state. Idempotent + race-safe in allocateFacturaNumber
// (the sequence reservation), so concurrent re-fires never double-burn a number. Non-blocking:
// a failure marks factura_status and alerts; it never affects the customer order.
exports.allocateFacturaOnSale = onValueWritten(
  { ref: '/orders/{orderId}', region: 'us-central1' },
  async (event) => {
    const after = event.data.after.val();
    if (!facturaSaleEligible(after, FACTURA_LAUNCH_CUTOFF_MS)) return;
    const orderId = event.params.orderId;
    const db = getDatabase();
    const restaurantId = after.restaurant_id || FACTURA_RESTAURANT_ID;

    // External-POS restaurants (e.g. La Musa → Soft Restaurant) are NOT on the platform factura
    // pipeline: skip allocation entirely and mark the Sale `external_pos` — no config_missing alert,
    // never reconciled here. Skips BEFORE both alert paths. x_pizza is in-set → no-op.
    if (!usesPlatformFactura(restaurantId)) {
      if (after.factura_status !== 'external_pos') {
        await db.ref(`orders/${orderId}/factura_status`).set('external_pos').catch(() => {});
      }
      return;
    }

    // Field-presence is checked HERE (not in the predicate) so a Sale missing priced data is
    // surfaced as failed+alert, never silently skipped (Codex R2-#4).
    if (!Array.isArray(after.items) || after.items.length === 0 ||
        after.total_cents == null || after.subtotal_cents == null || after.tax_cents == null) {
      console.error(`[factura] order ${orderId} reached Sale state without priced fields — marking failed`);
      await db.ref(`orders/${orderId}/factura_status`).set('failed').catch(() => {});
      await db.ref(`dispatcher_alerts/factura_${orderId}`).set({
        kind: 'factura_missing_fields', order_id: orderId, at: Date.now()
      }).catch(() => {});
      return;
    }

    try {
      const r = await allocateFacturaNumber(db, {
        restaurantId,
        orderId,
        order: { ...after, orderId, razon_social: after.razon_social || '', rtn_cliente: after.rtn_cliente || '' },
        now: Date.now(),
      });
      if (r.ok) {
        console.log(`[factura] ${orderId} → ${r.factura ? r.factura.factura_number : 'issued'}${r.voided ? ' (voided: cancel race)' : ''}`);
      } else {
        console.error(`[factura] ${orderId} not issued: ${r.reason || r.skipped}`);
        if (r.reason === 'range_exhausted' || r.reason === 'expired' || r.reason === 'config_missing') {
          await db.ref(`dispatcher_alerts/factura_${orderId}`).set({
            kind: `factura_${r.reason}`, order_id: orderId, at: Date.now()
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error(`[factura] allocate ${orderId} threw:`, e.message);
    }
  }
);

// ============================================================
// allocateDisplayNumberOnSale — per-restaurant daily human-friendly order number (#47) for staff verbal
// reference (order-display-number-design.md · Core). SEPARATE from allocateFacturaOnSale (same live/Sale
// predicate, INDEPENDENT state) so a cosmetic label can never entangle the money/factura path.
//
// Fires on the live/Sale transition (status → 'new'; an online order must be payment-confirmed) — the one
// moment every creation path converges on (cash create, all online materialize routes, scheduled release) —
// and NEVER on a hidden pending_payment order (failed payments burn no number; scheduled orders get numbered
// on release day). INHERENTLY FAIL-OPEN: the trigger runs AFTER the order exists, so a counter failure NEVER
// blocks an order — display_number just stays absent and every surface falls back to order_id. It is a LABEL,
// never a key. Idempotent: one transaction keyed by orderId (decideDisplayNumber); any re-fire (incl. our own
// stamp write, which re-enters this whole-node trigger) short-circuits on the already-set number.
// ============================================================
exports.allocateDisplayNumberOnSale = onValueWritten(
  { ref: '/orders/{orderId}', region: 'us-central1' },
  async (event) => {
    const after = event.data.after.val();
    if (!after) return;                                  // order gone
    if (Number.isFinite(after.display_number)) return;   // already stamped → nothing to do (also skips our re-fire)
    const before = event.data.before.val();

    // ALLOCATE only on the TRANSITION into live/Sale (F1) — NOT on every write to an already-'new' order (else a
    // pre-ship live order burns a number on its next unrelated write, mis-numbering the day). Otherwise HEAL-only:
    // re-stamp an existing reservation whose stamp write earlier failed / crashed (F3). A non-transition write
    // never mints a number — allocateAllowed = isTransition.
    const isTransition = displayNumberEligible(after) && (!before || before.status !== 'new');
    // A pre-live order that isn't transitioning can't hold a reservation (numbers are minted only on the
    // transition into 'new') → skip the transaction (avoids no-op churn on pending_payment/scheduled writes).
    const preLive = after.status === 'pending_payment' || after.status === 'scheduled' || after.status === 'releasing';
    if (!isTransition && preLive) return;

    const orderId = event.params.orderId;
    const restaurantId = after.restaurant_id || 'x_pizza';   // legacy-normalize (mirror the factura default)
    // Day anchored to the order's LIVE timestamp (F2), NOT trigger-run time — deterministic, and it makes the heal
    // cross-midnight-safe (same day-node → same reservation → same number). cash: created_at; online:
    // materialized_at; scheduled: released_at. Date.now() only as a last-resort fallback.
    const liveTs = Number(after.released_at) || Number(after.materialized_at) || Number(after.created_at) || Date.now();
    const day = hnDateISO(liveTs);                           // YYYY-MM-DD, America/Tegucigalpa (factura day boundary)
    const db = getDatabase();
    const counterPath = `counters/order_display_seq/${restaurantId}/${day}`;

    let allocated = null;
    if (isTransition) {
      // ALLOCATE atomically. Null-run-safe: the update fn COMMITS (returns .next), so on contention RTDB re-runs
      // with the true server value — a concurrent handler's reservation then wins idempotently (one number, no gap).
      try {
        await db.ref(counterPath).transaction((cur) => {
          const d = decideDisplayNumber(cur, orderId);
          allocated = d.number;
          return d.next === undefined ? undefined : d.next;   // undefined ⇒ abort (already reserved → idempotent)
        });
      } catch (e) {
        console.warn(`allocateDisplayNumberOnSale: counter txn failed for ${orderId} — fail-open (no number)`, e.message);
        return;   // FAIL-OPEN: a counter failure never blocks the order
      }
    } else {
      // HEAL (F3): re-stamp an existing reservation whose earlier stamp write failed / crashed. A plain READ —
      // NOT a transaction: a txn that aborts on its initial null-cache run doesn't re-fetch, so it would miss the
      // reservation. No minting here (not a transition) ⇒ no atomicity needed. Cross-midnight-safe via the
      // live-timestamp day (F2): same live-day node → same reservation → same number.
      try {
        allocated = (await db.ref(`${counterPath}/by_order/${orderId}`).once('value')).val();
      } catch (e) {
        console.warn(`allocateDisplayNumberOnSale: heal read failed for ${orderId} — fail-open`, e.message);
        return;   // FAIL-OPEN
      }
    }
    if (!Number.isFinite(allocated)) return;   // no reservation (heal no-op), or nothing to allocate → no-op

    // Stamp in TWO places: /orders/{id} (auth-readable staff surfaces) AND order_tracking/{token} (the public
    // customer tracker reads the token-gated node, not auth-only /orders). One atomic multi-path update.
    const updates = { [`orders/${orderId}/display_number`]: allocated };
    if (after.tracking_token) updates[`order_tracking/${after.tracking_token}/display_number`] = allocated;
    try { await db.ref().update(updates); }
    catch (e) { console.warn(`allocateDisplayNumberOnSale: stamp failed for ${orderId} (#${allocated})`, e.message); }
  }
);

// ============================================================
// voidFacturaOnCancel — void an issued factura when its order is cancelled (ADR-0003)
// ============================================================
//
// Fires on the order's transition into 'cancelled' from ANY path (dispatcher cancelPaidOrder,
// manual reconciliation, client-side cash cancel). If a number was issued → void it (the SAR
// number is retained, never recycled). If none was issued yet → mark factura_status:'cancelled'
// (no factura owed — a pre-issuance cancellation isn't a Sale; confirmed with fiscal counsel).
// P3 — mirror an order's status into the customer's history entry. onValueWritten on the status LEAF so
// it fires on every status transition. UPDATE-ONLY-IF-EXISTS (decideStatusMirror): reads the order's
// customer_uid; guest → no-op; else reads user_orders/{uid}/{orderId} and updates its status ONLY if the
// entry already EXISTS (never creates one → a pending_payment/unpaid checkout is never indexed). Writes a
// DIFFERENT subtree than it listens on (no loop); fully fail-open (a mirror failure never affects the
// order's own status write).
exports.mirrorStatusToHistory = onValueWritten(
  { ref: '/orders/{orderId}/status', region: 'us-central1' },
  async (event) => {
    try {
      const status = event.data.after.val();
      if (status == null) return;                          // status cleared / order gone
      const orderId = event.params.orderId;
      const db = getDatabase();
      const uid = (await db.ref(`orders/${orderId}/customer_uid`).get()).val();
      if (!uid) return;                                    // guest → no-op
      const entrySnap = await db.ref(`user_orders/${uid}/${orderId}`).get();
      const decision = decideStatusMirror(orderId, uid, entrySnap.exists(), status);
      if (!decision) return;                               // no entry (pending/unpaid) → NEVER create
      await db.ref(decision.path).set(decision.value);     // update the existing entry's status leaf only
    } catch (e) {
      console.warn('mirrorStatusToHistory: fail-open —', e && e.message);   // never affect the order-status write
    }
  }
);

// Rewards Phase A — credit earn when an order reaches its real TERMINAL state (delivery completes at
// 'delivered', pickup at 'completed'). 'ready' is pre-collection → must NOT earn. creditEarnForOrder is
// guest-NOOP + at-most-once (deterministic earn_${orderId} ledger key inside a single user_rewards
// transaction → crash-safe, no double-credit on re-fire) + fail-open. Additive; no money-path.
exports.earnRewardsOnCompletion = onValueWritten(
  { ref: '/orders/{orderId}/status', region: 'us-central1' },
  async (event) => {
    try {
      const after = event.data.after.val();
      if (!shouldEarnOnStatus(after)) return;
      const orderId = event.params.orderId;
      const db = getDatabase();
      const order = (await db.ref(`orders/${orderId}`).get()).val();
      await creditEarnForOrder(db, { orderId, order, now: Date.now() });
      // Phase B1: CASH primary redemption consume at delivered/completed (online already consumed at confirm →
      // idempotent no-op). Realizes the debit; the consume-recovery sweep is the backstop. Fail-open.
      await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'consume', now: Date.now() });
    } catch (e) {
      console.warn('earnRewardsOnCompletion: fail-open —', e && e.message);   // never affect the order-status write
    }
  }
);

exports.voidFacturaOnCancel = onValueWritten(
  { ref: '/orders/{orderId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    if (!facturaVoidEligible(before, after)) return;
    const orderId = event.params.orderId;
    const db = getDatabase();
    const restaurantId = after.restaurant_id || FACTURA_RESTAURANT_ID;
    // External-POS restaurants have no platform factura to void (and must not be marked
    // factura_status:'cancelled' on an external_pos order). See allocateFacturaOnSale. x_pizza → no-op.
    if (!usesPlatformFactura(restaurantId)) return;
    try {
      const r = await voidFactura(db, { restaurantId, orderId, reason: after.cancel_reason || 'cancelado', now: Date.now() });
      console.log(`[factura] void ${orderId} → ${r.voided ? 'voided' : (r.no_factura ? 'no factura owed' : 'noop')}`);
    } catch (e) {
      console.error(`[factura] void ${orderId} threw:`, e.message);
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
    const crypto = require('crypto');
    // Universal money-aware dispatcher cancel — the state machine lives in cancel-order-core.js (deps injected,
    // emulator-driven). This wrapper is a thin adapter: auth (above) → core → HTTP. Handles ALL payment methods
    // (the old payment_method!=='online' guard is removed); allowed-state gate / idempotency / heal / void /
    // finalize all live inside the core. Name kept (misnomer) so the endpoint stays 31→31 zero-prune.
    const result = await cancelOrderCore(cancelDeps(db), {
      orderId, actor, reason, now: Date.now(), claimId: crypto.randomUUID(),
    });
    return res.status(result.status).json(result.body);
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
      // Re-drive a failed void (refund_pending) OR a STALE reversing (crash after the reversal CAS, before the
      // terminal write) — skip FRESH reversing (in-flight void; re-driving would double-void). Same 2-min
      // threshold as the CAS. Selector is the shared pure predicate so it can't drift from the CAS's freshness rule.
      if (!isReconcilerRetryable(a, now, 2 * 60 * 1000)) continue;
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
  'norisf56@gmail.com',
  'johanisaac2011@gmail.com'
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

// ------------------------------------------------------------
// Dual-transport driver push (FCM native + web-push fallback)
// ------------------------------------------------------------
//
// Pure decision logic (transport order, reachability, error classification,
// message shape) lives in ./driver-push and is unit-tested. These two thin
// wrappers do the db + admin.messaging() side effects.

// Recompute and persist the materialized /drivers/{uid}/push_reachable flag,
// which dispatch reads (raw FCM tokens are server-only and not world-readable).
async function refreshPushReachable(db, uid) {
  const [driverSnap, tokSnap] = await Promise.all([
    db.ref(`drivers/${uid}`).once('value'),
    db.ref(`driver_push_tokens/${uid}`).once('value')
  ]);
  const driver = driverSnap.val() || {};
  const tok = tokSnap.val();
  const fcmToken = validateTokenOwner(uid, tok) ? tok.token : null;
  const reachable = computePushReachable({ push_subscription: driver.push_subscription, fcm_token: fcmToken });
  await db.ref(`drivers/${uid}/push_reachable`).set(reachable);
  return reachable;
}

// Send one notification to a driver. Tries FCM first (if a valid owned token
// exists), falls back to web-push on ANY FCM failure; clears a transport only
// on a TERMINAL error (dead FCM token / web 404|410) and then refreshes
// push_reachable. NOT gated on VAPID — FCM works even with VAPID unset.
async function sendDriverPush(db, uid, payload) {
  const [driverSnap, tokSnap] = await Promise.all([
    db.ref(`drivers/${uid}`).once('value'),
    db.ref(`driver_push_tokens/${uid}`).once('value')
  ]);
  const driver = driverSnap.val();
  if (!driver) return { sent: false, reason: 'no_driver' };

  const tokRec = tokSnap.val();
  const fcmToken = validateTokenOwner(uid, tokRec) ? tokRec.token : null;
  const transports = selectTransports({ push_subscription: driver.push_subscription, fcm_token: fcmToken });
  if (transports.length === 0) {
    console.log(`sendDriverPush: ${uid} has no push transport, skipping (${payload.tag})`);
    return { sent: false, reason: 'unreachable' };
  }

  for (const transport of transports) {
    try {
      if (transport === 'fcm') {
        await getMessaging().send(buildFcmMessage(fcmToken, payload));
      } else {
        await webpush.sendNotification(
          driver.push_subscription,
          JSON.stringify({ title: payload.title, body: payload.body, tag: payload.tag, data: payload.data || {} }),
          { urgency: 'high', TTL: PUSH_TTL_SECONDS }
        );
      }
      console.log(`sendDriverPush: ${transport} ok ${uid} (${payload.tag})`);
      return { sent: true, transport };
    } catch (err) {
      if (transport === 'fcm') {
        const terminal = isTerminalFcmError(err);
        console.error(`sendDriverPush: fcm failed ${uid} code=${err.code} terminal=${terminal} (${payload.tag})`);
        if (terminal) {
          await db.ref(`driver_push_tokens/${uid}`).remove();
          await refreshPushReachable(db, uid);
        }
        // fall through to web-push on ANY fcm failure
      } else {
        const terminal = isTerminalWebPushError(err);
        console.error(`sendDriverPush: web failed ${uid} status=${err.statusCode} terminal=${terminal} (${payload.tag})`);
        if (terminal) {
          await db.ref(`drivers/${uid}/push_subscription`).remove();
          await db.ref(`drivers/${uid}/push_subscription_updated_at`).remove();
          await refreshPushReachable(db, uid);
        }
      }
    }
  }
  return { sent: false, reason: 'all_failed' };
}

exports.notifyDriverOnAssignment = onValueWritten(
  {
    ref: '/tasks/{taskId}',
    region: 'us-central1'
  },
  async (event) => {
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

    // Look up the order for the notification body
    const orderSnap = await db.ref(`orders/${after.order_id}`).once('value');
    const order = orderSnap.val();

    // S3f (gate finding A): if the order is cancelled but this pickup just got assigned, a race revived it
    // — e.g. the sweeper's finalize landing in cancelOrder's read→update gap. This trigger fires on exactly
    // that pickup null→driver transition, so it's the enforcement point: UNDO the revived assignment (back
    // to cancelled) and never push a driver for a cancelled order. Closes the cancel-revival residual.
    if (order && order.status === 'cancelled') {
      const undo = {};
      for (const tt of ['pickup', 'delivery']) {
        undo[`tasks/${after.order_id}_${tt}/assigned_driver_id`] = null;
        undo[`tasks/${after.order_id}_${tt}/status`] = 'cancelled';
        undo[`tasks/${after.order_id}_${tt}/assignment_deadline`] = null;
      }
      undo[`tasks/${after.order_id}_delivery/half_claim_since`] = null;
      await db.ref().update(undo);
      console.warn(`notifyDriverOnAssignment: ${after.order_id} is cancelled — undid revived assignment, no push`);
      return;
    }

    const title = '¡Nuevo pedido!';
    const body = order
      ? `${order.customer_name || 'Cliente'} · L${order.total ?? '—'}`
      : `Pedido #${after.order_id}`;

    // Dual-transport (FCM native first, web-push fallback). No-op if the driver
    // has no push transport — they'll see the in-app card when they look.
    await sendDriverPush(db, newDriverId, {
      title,
      body,
      tag: `order-${after.order_id}`,
      data: { order_id: after.order_id }
    });
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
    const before = event.data.before.val();
    const after = event.data.after.val();

    // Only fire on transitions INTO cancelled
    if (after !== 'cancelled') return;
    if (before === 'cancelled') return;

    const orderId = event.params.orderId;

    // [F2-r4] DURABLE task/driver cleanup runs FIRST — NEVER behind the KDS_SHEET_ID early-return or the
    // Sheets try/catch. The inline cancelOrderCore update is the fast path; this trigger guarantees eventual
    // consistency (idempotent: already-cancelled task = no-op; driver released only if still on this order).
    try {
      const db = getDatabase();
      const order = (await db.ref(`orders/${orderId}`).once('value')).val();
      if (order) await cleanupTasksAndDriver({ db }, orderId, order, Date.now());
    } catch (e) {
      console.error(`onOrderCancelled: task/driver cleanup failed for ${orderId}`, e && e.message);
    }

    // KDS sheet sync — best-effort telemetry, AFTER the money/ops-critical cleanup above.
    if (!KDS_SHEET_ID) {
      console.warn('onOrderCancelled: KDS_SHEET_ID not configured, skipping KDS sync');
      return;
    }
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

    // Same dual-transport path as assignment; tag matches so the cancel banner
    // replaces the new-order banner on the device.
    await sendDriverPush(db, driverId, {
      title,
      body,
      tag: `order-${orderId}`,
      data: { order_id: orderId, cancelled: true }
    });
  }
);

// ============================================================
// Driver push-token registration (native FCM) + reachability upkeep
// ============================================================

// registerDriverPushToken — the native app calls this (authenticated) to
// register its FCM token. The token lives on the SERVER-ONLY
// /driver_push_tokens path (never world-readable /drivers); we materialize
// /drivers/{uid}/push_reachable so dispatch sees reachability without seeing
// tokens. Idempotent — safe to call on every refresh / app start.
exports.registerDriverPushToken = onCall({ region: 'us-central1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const token = String(request.data?.token || '').trim();
  if (!token) throw new HttpsError('invalid-argument', 'token required');

  const db = getDatabase();
  await db.ref(`driver_push_tokens/${uid}`).set({
    token,
    owner_uid: uid,
    platform: request.data?.platform || 'android',
    app_build: request.data?.app_build || null,
    last_seen: ServerValue.TIMESTAMP
  });
  const reachable = await refreshPushReachable(db, uid);
  console.log(`registerDriverPushToken: ${uid} registered (reachable=${reachable})`);
  return { ok: true, push_reachable: reachable };
});

// unregisterDriverPushToken — called on logout / notifications-off to drop the
// FCM token and recompute reachability.
exports.unregisterDriverPushToken = onCall({ region: 'us-central1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const db = getDatabase();
  await db.ref(`driver_push_tokens/${uid}`).remove();
  const reachable = await refreshPushReachable(db, uid);
  return { ok: true, push_reachable: reachable };
});

// onDriverSubscriptionChange — keeps push_reachable in sync for the PWA
// web-push path, which still writes /drivers/{uid}/push_subscription directly
// from the client. (FCM updates push_reachable via the callables above.)
exports.onDriverSubscriptionChange = onValueWritten(
  { ref: '/drivers/{uid}/push_subscription', region: 'us-central1' },
  async (event) => {
    await refreshPushReachable(getDatabase(), event.params.uid);
  }
);

// ============================================================
// Native location ingest — server-mediated shift + ingestDriverLocation
// ============================================================
//
// The native app's background-location uploader (Step 2c) POSTs to
// ingestDriverLocation with a per-shift opaque bearer token. Pure decision
// logic (geofence, batch ordering, token validation) lives in ./driver-ingest
// and is unit-tested; these wrappers do the db side effects. See ADR 0003.

const INGEST_TOKEN_TTL_MS = 16 * 60 * 60 * 1000;  // 16h — covers a long shift (Candidate B: no refresh)
const INGEST_MAX_AGE_MS = 5 * 60 * 1000;          // drop points older than 5 min
const INGEST_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;  // drop absurd-future points (clock skew)
const INGEST_GEOFENCE_RADIUS_M = 50;              // matches the client RESTAURANT.geofence_radius_m
const INGEST_RATE_MAX = 120;                      // per driver per window
const INGEST_RATE_WINDOW_MS = 60 * 1000;
const ingestRate = new Map();                     // uid -> { count, windowStart } (per-instance soft guard)

// startDriverShift — server-mediated clock-in. Atomically sets active/status/
// shift id/location_source and, for native clients, mints a hashed per-shift
// ingest token (returns the RAW token once, stores only its hash). PWA clients
// pass platform!=='native' and just get the clock-in (no token).
exports.startDriverShift = onCall({ region: 'us-central1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const crypto = require('crypto');
  const db = getDatabase();
  const isNativeClient = request.data?.platform === 'native';
  const deviceId = request.data?.device_id || null;
  const now = Date.now();
  const shiftId = crypto.randomUUID();

  const updates = {
    [`drivers/${uid}/active`]: true,
    [`drivers/${uid}/status`]: 'available',
    [`drivers/${uid}/shift_started_at`]: ServerValue.TIMESTAMP,
    [`drivers/${uid}/last_ping`]: ServerValue.TIMESTAMP,
    [`drivers/${uid}/current_task_id`]: null,
    // S1 #4: explicitly clear the hub snapshot on clock-in. The syncDriverHub trigger fires only on
    // current_task_id CHANGES, so an already-null→null write here would not fire it — clear directly
    // (mirrors endDriverShift) so a stale hub from an abnormal prior shift end can't survive.
    [`drivers/${uid}/current_hub_lat`]: null,
    [`drivers/${uid}/current_hub_lng`]: null,
    [`drivers/${uid}/current_restaurant_id`]: null,
    [`drivers/${uid}/current_hub_task_id`]: null,
    [`drivers/${uid}/current_shift_id`]: shiftId,
    [`drivers/${uid}/location_source`]: isNativeClient ? 'native' : 'pwa'
  };

  let ingestToken = null;
  if (isNativeClient) {
    const priorHash = (await db.ref(`drivers/${uid}/ingest_token_hash`).once('value')).val();
    if (priorHash) updates[`driver_tokens/${priorHash}`] = null;  // revoke prior token
    ingestToken = crypto.randomBytes(32).toString('hex');
    const hash = hashToken(ingestToken);
    updates[`driver_tokens/${hash}`] = {
      uid, shift_id: shiftId, device_id: deviceId,
      issued_at: now, expires_at: now + INGEST_TOKEN_TTL_MS, revoked_at: null
    };
    updates[`drivers/${uid}/ingest_token_hash`] = hash;
  }

  await db.ref().update(updates);
  console.log(`startDriverShift: ${uid} on shift ${shiftId} (source=${isNativeClient ? 'native' : 'pwa'})`);
  return { ok: true, shift_id: shiftId, location_source: isNativeClient ? 'native' : 'pwa', ingest_token: ingestToken };
});

// endDriverShift — server-mediated clock-out. Revokes (deletes) the ingest
// token, clears shift id + hub snapshot, and clocks the driver off.
exports.endDriverShift = onCall({ region: 'us-central1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const db = getDatabase();
  const hash = (await db.ref(`drivers/${uid}/ingest_token_hash`).once('value')).val();
  const updates = {
    [`drivers/${uid}/active`]: false,
    [`drivers/${uid}/status`]: 'off_shift',
    [`drivers/${uid}/shift_ended_at`]: ServerValue.TIMESTAMP,
    [`drivers/${uid}/current_shift_id`]: null,
    [`drivers/${uid}/current_task_id`]: null,
    [`drivers/${uid}/current_hub_lat`]: null,
    [`drivers/${uid}/current_hub_lng`]: null,
    [`drivers/${uid}/current_restaurant_id`]: null,
    [`drivers/${uid}/current_hub_task_id`]: null,
    [`drivers/${uid}/ingest_token_hash`]: null
  };
  if (hash) updates[`driver_tokens/${hash}`] = null;
  await db.ref().update(updates);
  console.log(`endDriverShift: ${uid} off shift`);
  return { ok: true };
});

// ingestDriverLocation — native uploader POSTs { locations: [{ ts, lat, lng,
// accuracy?, heading?, speed? }] } with Authorization: Bearer <opaque token>.
// Token -> uid (hash lookup), freshness + shift-binding checks, batch ordering
// (offline-replay safe), server geofence (native only, fail-closed on non-
// x_pizza), persist the final point + any status transition.
exports.ingestDriverLocation = onRequest({ region: 'us-central1' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // The token rides in a CUSTOM header, not Authorization: Bearer — Cloud
  // Functions gen2 reserves Authorization for Google IAM auth and rejects an
  // opaque bearer at the infra layer before it reaches us. Transistorsoft's
  // uploader sends custom headers, so this works for the native path too.
  const raw = (req.get('x-driver-token') || '').trim();
  if (!raw) return res.status(401).json({ error: 'missing token' });

  const db = getDatabase();
  const tokenRec = (await db.ref(`driver_tokens/${hashToken(raw)}`).once('value')).val();
  if (!tokenRec) return res.status(401).json({ error: 'invalid token' });
  const uid = tokenRec.uid;

  // Per-uid rate limit (per-instance soft guard; harden with a shared store before scale).
  const nowMs = Date.now();
  const rl = ingestRate.get(uid);
  if (!rl || nowMs - rl.windowStart > INGEST_RATE_WINDOW_MS) {
    ingestRate.set(uid, { count: 1, windowStart: nowMs });
  } else if (rl.count >= INGEST_RATE_MAX) {
    console.warn(`ingestDriverLocation: rate limit hit for ${uid}`);
    return res.status(429).json({ error: 'rate_limited' });
  } else {
    rl.count++;
  }

  const driver = (await db.ref(`drivers/${uid}`).once('value')).val();
  if (!driver) return res.status(401).json({ error: 'no driver' });

  const v = validateIngestToken(tokenRec, { now: nowMs, currentShiftId: driver.current_shift_id });
  if (!v.ok) {
    console.warn(`ingestDriverLocation: token rejected for ${uid} (${v.reason})`);
    return res.status(401).json({ error: v.reason });
  }
  // Freshness: must be actively on shift (defense-in-depth beyond token revoke).
  if (driver.active !== true || driver.status === 'off_shift') {
    return res.status(403).json({ error: 'off_shift' });
  }

  // Normalize each point's ts to epoch ms (Transistorsoft sends ISO; curl sends
  // numbers). selectIngestPoints then drops any with a non-finite ts.
  const rawPoints = Array.isArray(req.body && req.body.locations) ? req.body.locations : [];
  const points = rawPoints.map((p) => (p && typeof p === 'object') ? { ...p, ts: coerceTs(p.ts) } : p);
  const accepted = selectIngestPoints(points, {
    lastLocationTs: driver.last_location_ts || 0,
    now: nowMs,
    maxAgeMs: INGEST_MAX_AGE_MS,
    maxFutureSkewMs: INGEST_MAX_FUTURE_SKEW_MS
  });
  if (accepted.length === 0) {
    // Liveness receipt (Driver Tracking · BRIEF E · Surface 1). Every point was dropped by the freshness
    // filters — a verbatim heartbeat re-post, or a rare dup/stale POST — but the AUTHENTICATED, on-shift
    // device just contacted us, so advance ONLY last_ping (server clock). Deliberately NOT last_location_ts/
    // lat/lng/status: this writes the last_ping="device alive" vs last_location_ts="fix age" split the system
    // always implied but never wrote, so position age stays honest. The full auth chain (token → hash→uid →
    // rate-limit → validateIngestToken → active/off_shift) sits ABOVE this branch, so the receipt is
    // forge-proof and can't be spammed past the existing per-uid rate limit.
    await db.ref(`drivers/${uid}/last_ping`).set(ServerValue.TIMESTAMP);
    return res.status(200).json({ ok: true, accepted: 0, dropped: points.length, liveness: true });
  }

  // Server geofence — native drivers only, fail-closed on an unresolvable/mismatched hub.
  let status = driver.status;
  const hasTask = !!driver.current_task_id;
  const hubLat = driver.current_hub_lat ?? RESTAURANT_LAT;
  const hubLng = driver.current_hub_lng ?? RESTAURANT_LNG;
  // S1 E4: resolvable iff the restaurant_id is allow-listed AND the coords match its pinned hub
  // (a legacy null restaurant_id resolves as X. Pizza when the coords are the fallback). This is the
  // atomic partner of the syncDriverHub trigger writing current_hub_*; passing the coords defends
  // against a stale/corrupt snapshot.
  // S1 version stamp: trust the hub only while it is stamped for the LIVE task
  // (current_hub_task_id === current_task_id). A versioned-but-stale snapshot — the residual
  // syncDriverHub recheck window — self-detects here and fail-closes. current_hub_task_id == null is
  // the legacy / in-flight-at-deploy + sub-second accept-lag case (driver far from any hub) → lenient,
  // preserving X. Pizza behaviour.
  const hubVersionCurrent = driver.current_hub_task_id == null
    || driver.current_hub_task_id === driver.current_task_id;
  const hubOk = hubVersionCurrent && isHubResolvable(driver.current_restaurant_id, hubLat, hubLng);
  let arrived = false;
  if (driver.location_source === 'native' && hubOk) {
    for (const p of accepted) {
      const t = geofenceTransition({ status, hasTask, hubLat, hubLng, lat: p.lat, lng: p.lng, radiusM: INGEST_GEOFENCE_RADIUS_M });
      if (t) { status = t.status; if (t.arrivedAtRestaurant) arrived = true; }
    }
  } else if (!hubOk) {
    console.warn(`ingestDriverLocation: hub not resolvable for ${uid} (restaurant_id=${driver.current_restaurant_id}) — geofence skipped`);
  }

  const final = accepted[accepted.length - 1];
  const updates = {
    [`drivers/${uid}/lat`]: final.lat,
    [`drivers/${uid}/lng`]: final.lng,
    [`drivers/${uid}/accuracy`]: typeof final.accuracy === 'number' ? final.accuracy : null,
    [`drivers/${uid}/heading`]: typeof final.heading === 'number' ? final.heading : null,
    [`drivers/${uid}/speed`]: typeof final.speed === 'number' ? final.speed : null,
    [`drivers/${uid}/last_location_ts`]: final.ts,
    [`drivers/${uid}/last_ping`]: ServerValue.TIMESTAMP
  };
  if (status !== driver.status) updates[`drivers/${uid}/status`] = status;
  if (arrived) updates[`drivers/${uid}/arrived_at_restaurant_at`] = ServerValue.TIMESTAMP;
  await db.ref().update(updates);

  return res.status(200).json({ ok: true, accepted: accepted.length, dropped: points.length - accepted.length, status });
});

// ============================================================
// syncDriverHub — server-writes the driver's per-restaurant hub snapshot (S1 E3)
// ============================================================
//
// current_hub_lat/lng + current_restaurant_id are dispatcher-only/server-managed (database.rules.json),
// so the driver app can't write them. This trigger derives them from the driver's current_task_id
// whenever it changes:
//   pickup task   → set the pickup-approach hub (destination_lat/lng + restaurant_id)
//   delivery task → keep the linked-pickup hub (no-op, or BACKFILL a lagged/absent one)
//   null/unknown  → clear (→ returning to the X. Pizza base via the geofence fallback)
// The geofence (ingestDriverLocation + the client checkGeofenceTransition) reads this snapshot, so a
// la_musa order geofences/navigates to La Musa while X. Pizza stays on its hub.
//
// Idempotent recheck (watch-point #1): a slow/out-of-order event can fire after current_task_id has
// already advanced. We re-read the LIVE value (the driver record, as late as possible before writing)
// and act only if it still equals the event's after-value (syncDriverHubUpdate). The residual sub-ms
// window between that read and the write is deliberately tolerated rather than locked behind a
// transaction on the driver node — that node takes high-frequency GPS writes, so a transaction would
// contend badly. A residual stale write is benign: x_pizza-harmless (hub == x_pizza either way), the
// next current_task_id change re-resolves it, and the geofence fail-closes on a mismatched hub (plus
// the 90s-ping staleness backstop). The trigger writes only current_hub_* (never current_task_id), so
// it cannot recurse.
exports.syncDriverHub = onValueWritten(
  { ref: '/drivers/{uid}/current_task_id', region: 'us-central1' },
  async (event) => {
    const uid = event.params.uid;
    const afterTaskId = event.data.after.val();   // new current_task_id (null on clear)
    const db = getDatabase();

    // Minimal task map: the after-task + (for a delivery) its linked pickup — never read all of /tasks.
    const tasks = {};
    if (afterTaskId != null) {
      const t = (await db.ref(`tasks/${afterTaskId}`).once('value')).val();
      if (t) {
        tasks[afterTaskId] = t;
        if (t.type === 'delivery' && t.linked_task_id) {
          const pk = (await db.ref(`tasks/${t.linked_task_id}`).once('value')).val();
          if (pk) tasks[t.linked_task_id] = pk;
        }
      }
    }

    // Recheck read AS LATE AS POSSIBLE: the live driver gives both the fresh current_task_id and the
    // existing hub snapshot in one read.
    const driver = (await db.ref(`drivers/${uid}`).once('value')).val() || {};
    const freshTaskId = driver.current_task_id ?? null;
    const existingHub = {
      current_restaurant_id: driver.current_restaurant_id ?? null,
      current_hub_lat: driver.current_hub_lat ?? null,
      current_hub_lng: driver.current_hub_lng ?? null,
    };

    const update = syncDriverHubUpdate(afterTaskId, freshTaskId, tasks, existingHub);
    if (!update) return;   // diverged (out-of-order) or no-op → nothing to write
    await db.ref(`drivers/${uid}`).update(update);
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

    // C2: route notifications to the ORDER's restaurant. Source is the loaded `order` (NOT `after`,
    // which is the status string — this trigger watches /orders/{orderId}/status). Legacy-normalized.
    const restaurantId = order?.restaurant_id || 'x_pizza';

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

    // Order-received confirmation for ONLINE (prepaid) orders — cash/pickup already got it inline from
    // createOrder; online (chargeOnlineOrder→confirm→materialize) never notified until now. Fires on the
    // live-transition to 'new' (both unscheduled materialize AND scheduled release converge here); held
    // states (scheduled hold / manual_review) never reach 'new' → correctly no message. Additive +
    // fail-open; money-path untouched.
    if (after === 'new') {
      if (!order) { console.warn(`orderReceived: order ${orderId} not loaded on 'new', skipping`); return; }   // the trigger allows order=null — guard before any order.*
      if (!shouldSendOrderReceived(order, after)) return;   // not online / no phone → skip (cash & pickup already sent → no double-send)
      if (!(await whatsapp.isEnabledForRestaurant(db, restaurantId))) return;

      // Mark-before-send (mirror notifyPickupReady): atomic claim so a duplicate 'new' write / trigger
      // redelivery can't double-send. The marker is a SIBLING of /status → it does NOT re-trigger this watcher.
      let claim;
      try { claim = await db.ref(`orders/${orderId}/order_received_notified_at`).transaction((cur) => (cur ? undefined : ServerValue.TIMESTAMP)); }
      catch (e) { console.warn(`orderReceived: claim failed ${orderId}`, e.message); return; }
      if (!claim.committed) return;   // already sent

      const body = (order.order_type === 'pickup')
        ? whatsapp.tplPickupReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, pickupTime: order.pickup_time || 'standard', trackingToken, restaurantId })
        : whatsapp.tplOrderReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, trackingToken, restaurantId });

      // sendMessage RETURNS null on failure (bad phone / no config / provider error) — it does NOT throw.
      // Marker already committed (at-most-once, no auto-retry — same tradeoff as notifyPickupReady). Record
      // a failed send so it's visible/recoverable, never silently marked sent.
      let res = null;
      try { res = await whatsapp.sendMessage(order.customer_phone, body, restaurantId); }
      catch (e) { console.error(`orderReceived: send threw ${orderId}`, e.message); }
      if (res == null) {
        try { await db.ref(`orders/${orderId}/order_received_send_unresolved_at`).set(ServerValue.TIMESTAMP); } catch (_) {}
        console.warn(`orderReceived: send unresolved (null) ${orderId} — marked for visibility, not retried`);
      }
      return;   // 'new' handled — do NOT fall through to the delivery/cancel logic below
    }

    // WhatsApp send only fires for these specific transitions. preparing/ready
    // and other intermediate states update the tracking page but don't
    // notify the customer (would be too noisy).
    if (!['out_for_delivery', 'delivered', 'cancelled'].includes(after)) return;

    if (!(await whatsapp.isEnabledForRestaurant(db, restaurantId))) {
      console.log(`sendOrderStatusNotifications: ${orderId} → ${after}, but whatsapp disabled for ${restaurantId}, skipping send`);
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
          trackingToken,
          restaurantId
        });

      } else if (after === 'delivered') {
        body = whatsapp.tplDelivered({
          customerName: order.customer_name,
          restaurantId
        });

      } else if (after === 'cancelled') {
        body = whatsapp.tplCancelled({
          orderId,
          restaurantId
        });
      }

      if (!body) return;

      console.log(`sendOrderStatusNotifications: ${orderId} → ${after}, sending WhatsApp to ${order.customer_phone}`);
      await whatsapp.sendMessage(order.customer_phone, body, restaurantId);

    } catch (e) {
      console.error(`sendOrderStatusNotifications: failed for ${orderId} → ${after}`, e.message);
      // Swallow — never throw out of the trigger
    }
  }
);

// ============================================================
// logOrderLifecycle — Ready-Time Phase 0 lifecycle-event instrumentation (READY_TIME_PHASE0.md).
//
// OBSERVER-ONLY + ADDITIVE. On each REAL orders/{id}/status change it does two fully-decoupled writes
// to two NEW top-level trees — order_events (immutable audit spine) + order_timelines (first-entry
// label source). It writes NOTHING under /orders, so it fires NO existing order trigger (autoAssign,
// onOrderCancelled, sendOrderStatusNotifications, materialize, factura). It must not change any
// X. Pizza / La Musa behavior; the emulator gate proves that. The two ephemeral, unrecoverable context
// values (kitchen_load_ahead, drivers_online) are captured live — the whole point of banking early.
exports.logOrderLifecycle = onValueWritten(
  {
    ref: '/orders/{orderId}/status',
    region: 'us-central1'
  },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    // No-op guard (compare .val(), NOT the snapshots): status cleared, or a re-write with no change.
    if (after == null) return;
    if (before === after) return;

    const orderId = event.params.orderId;
    const db = getDatabase();

    try {
      // restaurant_id from the order (legacy pre-Phase-0 orders lack it → normalize to x_pizza).
      const ridSnap = await db.ref(`orders/${orderId}/restaurant_id`).once('value');
      const restaurantId = ridSnap.val() || 'x_pizza';

      // Ephemeral context (unrecoverable after the fact). Two INDEXED status reads for the kitchen
      // queue (restaurant-filtered + self-excluded in memory — RTDB can't IN-query; orders already has
      // .indexOn:["status"]) + ONE full /drivers read for the coarse supply proxy (small collection,
      // filtered in memory → no drivers index needed). All READS — never writes anything.
      const [newSnap, prepSnap, drvSnap] = await Promise.all([
        db.ref('orders').orderByChild('status').equalTo('new').once('value'),
        db.ref('orders').orderByChild('status').equalTo('preparing').once('value'),
        db.ref('drivers').once('value'),
      ]);
      const kitchenLoadAhead = countKitchenLoadAhead(newSnap.val(), prepSnap.val(), restaurantId, orderId);
      const { drivers_available, drivers_on_shift } = countDriverSupply(drvSnap.val());

      // 1. Immutable event — one per REAL transition (records bounces too, for audit).
      await db.ref(`order_events/${orderId}`).push(buildLifecycleEvent({
        from: before, to: after, restaurantId, kitchenLoadAhead,
        driversAvailable: drivers_available, driversOnShift: drivers_on_shift, now: ServerValue.TIMESTAMP,
      }));

      // 2. First-entry timeline — the clean label source. Transactional, set ONLY if absent (first
      //    entry wins), so a ready→preparing→ready bounce / dispatcher override / stale-tab re-write
      //    can't corrupt the label. Separate top-level tree → no /orders trigger fanout.
      await db.ref(`order_timelines/${orderId}/${timelineStampKey(after)}`).transaction(
        (cur) => (cur === null ? ServerValue.TIMESTAMP : undefined)
      );
    } catch (e) {
      // Swallow — instrumentation must NEVER affect the live order path.
      console.error(`logOrderLifecycle: failed for ${orderId} (${before} → ${after})`, e.message);
    }
  }
);

// ============================================================
// notifyPickupReady — KDS Phase 2c: pickup-ready customer WhatsApp (KDS_2C_PLAN.md).
//
// Watches /orders/{orderId}/status. On a transition INTO 'ready' for a PICKUP order, sends the customer
// ONE "listo para recoger" WhatsApp via the ORDER's restaurant UltraMsg instance, AT MOST ONCE EVER.
// SEPARATE from sendOrderStatusNotifications (which stays byte-for-byte unchanged) so the live, money-
// adjacent delivery/cancel sender is untouched — the only cost is one extra order read per ready transition.
//
// State lives in a SEPARATE top-level tree /pickup_ready_notifications/{orderId}, NEVER under /orders:
// four triggers watch the whole order node (materializeOnConfirm, allocateFacturaOnSale, voidFacturaOnCancel,
// autoAssignOnOrderCreate), so a mark under the order would re-fire all four. No trigger watches
// /pickup_ready_notifications, and this trigger watches /orders/{id}/status, so it cannot self-trigger.
// Mirrors the logOrderLifecycle isolation pattern.
//
// At-most-once: a transaction() claim on claimed_at is the SOLE redelivery/concurrency authority (a
// redelivered new→ready event still carries before='new'; only the claim stops a second send).
// Mark-before-send: send_started_at is awaited BEFORE sendMessage, so a claimed_at-only node (no
// send_started_at) is provably unsent. Honest states: sent_at ONLY on a confirmed (non-null) provider
// return; otherwise send_unresolved_at (a null return may mean the customer already received it → never
// auto-safe to resend). Never throws (no retry storm); no auto-reclaim.
const SUPPORTED_WHATSAPP_RESTAURANTS = new Set(['x_pizza', 'la_musa']);

exports.notifyPickupReady = onValueWritten(
  {
    ref: '/orders/{orderId}/status',
    region: 'us-central1'
  },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    // Explicit early return FIRST — a no-op status rewrite does nothing before any diagnostic/claim/send
    // work. (This is NOT the redelivery guard; the claim transaction below is.)
    if (after !== 'ready' || before === after) return;

    const orderId = event.params.orderId;
    const db = getDatabase();
    const notifRef = db.ref(`pickup_ready_notifications/${orderId}`);

    // stamp(): guarded diagnostic write. ABORTS if the node already carries claimed_at/sent_at, so a
    // redelivered invocation can never stamp a diagnostic (skipped_at / read_error_at) onto an already-
    // claimed/sent node (sent_at/claimed_at ALWAYS beat any diagnostic). Never claims, never sends.
    const stamp = async (fields) => {
      try {
        await notifRef.transaction((cur) => {
          if (cur && (cur.claimed_at || cur.sent_at)) return;   // abort — already claimed/sent
          return Object.assign(cur || {}, fields);
        });
      } catch (e) {
        console.warn(`notifyPickupReady: diagnostic stamp failed for ${orderId}`, e.message);
      }
    };
    const skip = (reason) => stamp({ skipped_at: ServerValue.TIMESTAMP, skipped_reason: reason });

    // Load the order once, then classify eligibility (ALL required; the restaurant check FAILS CLOSED).
    let order = null;
    try {
      order = (await db.ref(`orders/${orderId}`).once('value')).val();
    } catch (e) {
      // Transient read error ⇒ NOT a durable ineligibility, so do NOT claim/send. But leave a durable
      // read_error_at trace (RTDB at-least-once does NOT guarantee a business re-attempt after a clean
      // resolve) so ops can see + manually recover a missed ping. Guarded ⇒ never clobbers a real
      // claim/sent. Do NOT rethrow — the stamp IS the recovery signal, and the trigger must never throw
      // (no retry config; a throw would just mark the invocation failed with no benefit).
      console.warn(`notifyPickupReady: couldn't read order ${orderId}, stamping read_error_at`, e.message);
      await stamp({ read_error_at: ServerValue.TIMESTAMP, read_error_reason: String((e && e.message) || 'read_failed').slice(0, 200) });
      return;
    }

    if (!order) return skip('order_missing');
    if (order.order_type !== 'pickup') return skip('not_pickup');
    if (!order.restaurant_id) return skip('no_restaurant_id');
    if (!SUPPORTED_WHATSAPP_RESTAURANTS.has(order.restaurant_id)) return skip('unsupported_restaurant');
    if (!order.customer_phone) return skip('no_phone');
    if (!(await whatsapp.isEnabledForRestaurant(db, order.restaurant_id))) return skip('whatsapp_disabled');

    // ---- Claim → start → send → record (mark-before-send) ----
    // a. Claim: transaction on claimed_at — present ⇒ abort (already claimed); absent ⇒ win. The SOLE
    //    redelivery/concurrency authority.
    let claim;
    try {
      claim = await notifRef.child('claimed_at').transaction((cur) => (cur ? undefined : ServerValue.TIMESTAMP));
    } catch (e) {
      console.warn(`notifyPickupReady: claim transaction failed for ${orderId}`, e.message);
      return;   // couldn't claim — do nothing (no send)
    }
    if (!claim.committed) return;   // lost the claim (already claimed) — no second send

    // b. Durable start: stamp send_started_at and AWAIT it. If it FAILS, abort WITHOUT sendMessage — this
    //    guarantees claimed_at-only (no send_started_at) ⇒ sendMessage was never called ⇒ genuinely unsent.
    try {
      await notifRef.child('send_started_at').set(ServerValue.TIMESTAMP);
    } catch (e) {
      console.error(`notifyPickupReady: send_started_at write failed for ${orderId} — NOT sending`, e.message);
      return;
    }

    // c. Build the message (the template OMITS the tracking link when the token is absent).
    const body = whatsapp.tplPickupReady({
      customerName: order.customer_name,
      trackingToken: order.tracking_token,
      restaurantId: order.restaurant_id
    });

    // d. Send — handle BOTH a null return and a throw as "unconfirmed".
    let result = null;
    try {
      result = await whatsapp.sendMessage(order.customer_phone, body, order.restaurant_id);
    } catch (e) {
      console.error(`notifyPickupReady: sendMessage threw for ${orderId}`, e.message);
      result = null;
    }

    // e. Honest record: sent_at ONLY on a confirmed (non-null) return; otherwise send_unresolved_at. NEVER
    //    set sent_at on a null/thrown result. f. Never throw out of the trigger; no auto-reclaim of claimed_at.
    try {
      if (result != null) {
        await notifRef.child('sent_at').set(ServerValue.TIMESTAMP);
        console.log(`notifyPickupReady: ${orderId} → pickup-ready WhatsApp sent to ${order.customer_phone}`);
      } else {
        await notifRef.child('send_unresolved_at').set(ServerValue.TIMESTAMP);
        console.warn(`notifyPickupReady: ${orderId} → send UNRESOLVED (no confirmed provider success)`);
      }
    } catch (e) {
      console.error(`notifyPickupReady: outcome write failed for ${orderId}`, e.message);
    }
  }
);

// ============================================================
// Ready-Time Phase 1 · Step 3 — shadow ready-time predictor + prediction-logging (PURE SHADOW).
// Two onValueCreated triggers, thin adapters over the deps-injected core (ready-time-predict-core.js).
// They write ONLY order_predictions / prediction_logs / ready_time_model — NEVER /orders, /order_tracking,
// /tasks, /drivers, /dispatcher_alerts, any push/notification, or config/ready_time. Shadow-only: no
// user-facing or dispatch behavior changes. Errors are swallowed so the shadow can never affect live paths.
// ============================================================

// Trigger A — Prediction: fires on each order_events/{orderId}/{eventId} create; acts only when to==='new'
// (the creation instant; avoids the /orders/status race with logOrderLifecycle). Anchors new_at on the
// event's own `at`. Transactional create-if-absent → idempotent against event bounces.
exports.predictReadyTimeOnNew = onValueCreated(
  { ref: '/order_events/{orderId}/{eventId}', region: 'us-central1' },
  async (event) => {
    const row = event.data.val();
    if (!row || row.to !== 'new') return;                       // cheap pre-filter; the core confirms this
    try {                                                       // eventId IS the pickNewEvent winner before writing
      await runPrediction({ db: getDatabase(), now: Date.now() }, { orderId: event.params.orderId, eventId: event.params.eventId });
    } catch (e) {
      console.error(`predictReadyTimeOnNew: failed for ${event.params.orderId}`, e.message);
    }
  }
);

// Trigger B — Actual label + model update: fires on order_timelines/{orderId}/ready_at create (the
// first-entry ready). Write-once prediction_logs per active version (always the actual; NO backfill) +
// updates the model rings for eligible + timeline-sane x_pizza rows only.
exports.logReadyTimeActual = onValueCreated(
  { ref: '/order_timelines/{orderId}/ready_at', region: 'us-central1' },
  async (event) => {
    const readyAt = event.data.val();
    try {
      await runLabelAndUpdate({ db: getDatabase(), now: Date.now() }, { orderId: event.params.orderId, readyAt });
    } catch (e) {
      console.error(`logReadyTimeActual: failed for ${event.params.orderId}`, e.message);
    }
  }
);

// ============================================================
// readyTimeGraduationMonitor — Phase 1b-i. Hourly graduation sweep. READS prediction_logs ⟕ order_predictions
// + ready_time_config; WRITES ONLY ready_time_graduation/{v}/{restaurant}/{source}/{bucket_key} +
// _meta/active_config_hash. PURE-SHADOW-ADJACENT: never touches /orders or the predictor's write paths (the
// shadow boundary is inviolable). Preview-until-signed: unsigned graduation_thresholds ⇒ verdicts mode:'preview'
// ⇒ nothing graduates. Mirrors driverFreshnessMonitor's fail-safe shape (any read failure ⇒ skip, no writes).
// ============================================================

// isGraduationConfigSigned (plan-gate #2): signed = a REAL version + approval stamp (mirrors ready-time-quality.js
// isCaptureAcceptable), NOT a flippable boolean. The preview seed omits both, so it reads unsigned.
function isGraduationConfigSigned(cfg){
  const g = cfg && cfg.graduation_thresholds;
  return !!(g && g.version && g.approved_at != null);
}
// Deterministic PRNG — seeded from the window so reruns are reproducible without Math.random (matches the core's test RNG).
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return((t^t>>>14)>>>0)/4294967296; }; }
// buildGraduationRows lives in ready-time-graduation.js (pure + unit-tested; codex-on-diff #1: iterates only the
// active versions + re-verifies each log.new_at is in [from,to], since the deep-path query returns the whole node).

exports.readyTimeGraduationMonitor = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const db = getDatabase();
    const now = Date.now();
    let cfg;
    try { cfg = (await db.ref('ready_time_config').once('value')).val() || {}; }
    catch (e) { console.error('readyTimeGraduationMonitor: config read failed, skipping', e.message); return; }
    const gt = cfg.graduation_thresholds;
    if (!gt || !Number.isFinite(gt.window_ms)) { console.warn('graduation: no thresholds config, skipping'); return; }
    const settleLag = Number.isFinite(cfg.settle_lag_ms) ? cfg.settle_lag_ms : 0;
    const from = now - gt.window_ms, to = now - settleLag;

    // Read the window. Join BASE = prediction_logs (superset). ★ EXECUTOR CORRECTION vs the plan's Task-4
    // snippet: prediction_logs is TWO-LEVEL — prediction_logs/{orderId}/{v}/…new_at — so a flat
    // orderByChild('new_at') can't window it (new_at is one level deeper). Query per ACTIVE_MODEL_VERSION by the
    // DEEP path `${v}/new_at` (matching .indexOn in database.rules.json) and merge. The order_predictions read is
    // then BOUND (plan-gate #3) to the windowed orderIds — never db.ref('order_predictions').once() on the whole tree.
    let logsVal = {}, preds = {};
    try {
      const perVersion = await Promise.all(ACTIVE_MODEL_VERSIONS.map((v) =>
        db.ref('prediction_logs').orderByChild(`${v}/new_at`).startAt(from).endAt(to).once('value').then((s) => s.val() || {})
      ));
      for (const chunk of perVersion){
        for (const orderId in chunk){ logsVal[orderId] = { ...(logsVal[orderId] || {}), ...chunk[orderId] }; }
      }
      const orderIds = Object.keys(logsVal);
      const snaps = await Promise.all(orderIds.map((id) => db.ref(`order_predictions/${id}`).once('value')));
      orderIds.forEach((id, i) => { const v = snaps[i].val(); if (v) preds[id] = v; });
    } catch (e) { console.error('graduation: read failed, skipping', e.message); return; }

    const rows = buildGraduationRows(logsVal, preds, { from, to, activeVersions: ACTIVE_MODEL_VERSIONS });
    const rng = mulberry32((from ^ to) >>> 0);   // deterministic per window
    const out = computeGraduation(rows, { ...cfg, config_hash: hashConfig(cfg), signed: isGraduationConfigSigned(cfg) }, { rng, now });

    const updates = {};
    for (const path in out.verdicts) updates[path] = out.verdicts[path];
    updates['ready_time_graduation/_meta/active_config_hash'] = out.activeConfigHash;   // fix 7' pointer
    try { await db.ref().update(updates); console.log(`graduation: ${Object.keys(out.verdicts).length} verdicts (${out.mode})`); }
    catch (e) { console.error('graduation: write failed', e.message); }
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

    // Which restaurant's number was texted? From the ?restaurant= webhook param; absent/unknown → x_pizza,
    // so X. Pizza's existing webhook URL stays byte-identical (the secret check above already gated this;
    // the param only ROUTES it). Resolved EARLY so even non-chat / unhandled records carry routing context.
    // Warn on an unrecognized non-empty param — surfaces a mis-wired la_musa webhook instead of silently
    // serving x_pizza replies.
    const restaurantId = inbound.resolveInboundRestaurant(req.query && req.query.restaurant);
    if (inbound.isUnrecognizedRestaurantParam(req.query && req.query.restaurant)) {
      console.warn(`onIncomingWhatsApp: unrecognized ?restaurant=${JSON.stringify(req.query && req.query.restaurant)} → x_pizza fail-safe (mis-wired webhook?)`);
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
          restaurant_id: restaurantId,   // routing context for human follow-up (per-restaurant)
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

    const cfg = inbound.configFor(restaurantId);

    // Per-restaurant enablement — for x_pizza this is EXACTLY isEnabled(db) (byte-identical); a
    // non-x_pizza restaurant additionally requires its identity.whatsapp_enabled (fail-closed).
    if (!(await whatsapp.isEnabledForRestaurant(getDatabase(), restaurantId))) {
      console.log(`onIncomingWhatsApp: whatsapp disabled for ${restaurantId}, no auto-reply`);
      return res.status(200).send('ignored: disabled');
    }

    // Hours for the closed-message. x_pizza uses its hardcoded HOURS (byte-identical). Non-x_pizza reads
    // identity.hours LIVE (single source — no drift vs the order-form/gate). On a read miss, degrade to a
    // generic closed reply (still gives the order-form link).
    let hoursMap;
    if (restaurantId !== 'x_pizza') {
      try {
        const hsnap = await getDatabase().ref(`restaurants/${restaurantId}/identity/hours`).once('value');
        hoursMap = inbound.hoursFromIdentity(hsnap.val());
      } catch (e) {
        console.warn(`onIncomingWhatsApp: hours read failed for ${restaurantId}`, e.message);
        hoursMap = inbound.hoursFromIdentity(null);
      }
    }
    let replyBody = null;

    try {
      // Inside the try: a malformed live identity.hours can only degrade to a reply, never throw → 500 →
      // UltraMsg retry. (hoursFromIdentity already null-guards bad HH:MM; this is defense-in-depth.)
      const intent = inbound.classify(body);
      const hours = inbound.getHoursStatus(new Date(), hoursMap);   // hoursMap undefined → x_pizza HOURS default
      console.log(`onIncomingWhatsApp: rid=${restaurantId} from=${fromPhoneRaw} intent=${intent} body="${body.substring(0, 80)}"`);

      if (intent === 'STATUS_CHECK') {
        // Look up active orders for this phone number. We match by suffix
        // because order.customer_phone may be stored with or without the "+"
        // and country code, while UltraMsg gives us the raw digits.
        const db = getDatabase();
        const ordersSnap = await db.ref('orders').once('value');
        const orders = ordersSnap.val() || {};
        const activeOrders = Object.values(orders).filter(o => {
          if (!o || !o.customer_phone) return false;
          // Scope to the restaurant whose number was texted (legacy-normalized). A customer texting the
          // wrong restaurant's number falls through to tplStatusCheckNotFound (no cross-restaurant leak).
          if ((o.restaurant_id || 'x_pizza') !== restaurantId) return false;
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
            replyBody = inbound.tplStatusCheckFound(cfg, {
              trackingToken: order.tracking_token,
              customerName: (order.customer_name || '').split(' ')[0]
            });
          } else {
            // No tracking token (legacy order) — fall back to generic reply
            replyBody = inbound.tplStatusCheckNotFound(cfg);
          }
        } else {
          replyBody = inbound.tplStatusCheckNotFound(cfg);
        }

      } else if (intent === 'GENERAL_INQUIRY') {
        replyBody = inbound.tplGeneralInquiry(cfg, hours);

      } else if (intent === 'SHORT_ACK') {
        replyBody = inbound.tplShortAck(cfg);

      } else {
        // UNHANDLED — log to /incoming_messages for dispatcher review
        replyBody = inbound.tplUnhandled(cfg, hours);
        try {
          const db = getDatabase();
          await db.ref('incoming_messages').push({
            from: fromPhoneRaw,
            restaurant_id: restaurantId,   // routing context for human follow-up (per-restaurant)
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
        await whatsapp.sendMessage(fromPhoneRaw, replyBody, restaurantId);   // reply via the texted restaurant's instance
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
const RESTAURANT_LAT = X_PIZZA_HUB.lat;   // x_pizza hub (single source: assign-hub.js) — geofence + auto-assign fallback
const RESTAURANT_LNG = X_PIZZA_HUB.lng;

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

// Unassigned delivery order still needs a driver in these states. Excludes
// out_for_delivery (already has a driver) + delivered/cancelled (terminal).
// Replaces the over-broad `status !== 'new'` skip that dropped kitchen-accepted
// ('preparing') orders during the grace. Vocab confirmed: new·preparing·ready·
// out_for_delivery·delivered·cancelled.
const AUTO_ASSIGNABLE_STATUSES = new Set(['new', 'preparing', 'ready']);

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
async function pickEligibleDriver(db, excludeDriverIds = [], hubLat = RESTAURANT_LAT, hubLng = RESTAURANT_LNG) {
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
  const acceptedOrdersByDriver = {};
  for (const taskId of Object.keys(tasks)) {
    const t = tasks[taskId];
    if (!t || !t.assigned_driver_id) continue;
    if (t.status === 'completed' || t.status === 'cancelled') continue;
    if (!activeOrdersByDriver[t.assigned_driver_id]) activeOrdersByDriver[t.assigned_driver_id] = new Set();
    if (t.order_id) activeOrdersByDriver[t.assigned_driver_id].add(t.order_id);
    // A stack auto-accepts the NEXT order only once the driver has already
    // ACCEPTED one (matches buildAssignmentUpdates' documented isStacked intent).
    // Tracked separately from orderCount, which stays the basis for the cap.
    if (t.status === 'accepted' || t.status === 'in_progress') {
      if (!acceptedOrdersByDriver[t.assigned_driver_id]) acceptedOrdersByDriver[t.assigned_driver_id] = new Set();
      if (t.order_id) acceptedOrdersByDriver[t.assigned_driver_id].add(t.order_id);
    }
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
    //   - reachable: we can deliver the order via FCM native OR web-push.
    //     Authoritative on the materialized push_reachable flag (covers native
    //     FCM-only drivers). Falls back to a REAL web subscription when the flag
    //     isn't set yet, so a driver stays assignable even if the backfill
    //     hasn't run — no deploy-ordering footgun.
    //   - cooldown not active (last assignment didn't time out)
    //
    // Lat/lng absence is OK — used only for distance sort. If GPS is missing
    // we fall back to the restaurant location for sort distance, treating
    // the driver as if they're at the restaurant. They probably are if their
    // phone hasn't pinged.
    if (d.status === 'off_shift') continue;
    // computePushReachable on the driver record only sees web push_subscription
    // (FCM tokens are server-only), which is exactly the legacy fallback we want.
    const reachable = (typeof d.push_reachable === 'boolean') ? d.push_reachable : computePushReachable(d);
    if (!reachable) continue;
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
      distanceKm = haversineKm(d.lat, d.lng, hubLat, hubLng);
    } else {
      distanceKm = 0;
    }
    const statusPriority = STATUS_PRIORITY[d.status] ?? 99;
    const hasAcceptedOrder = (acceptedOrdersByDriver[driverId]?.size || 0) > 0;
    // S2 note: the same-hub force-accept gate is NOT computed here — it is resolved fail-closed (against
    // the new order's own pickup hub) in reassertAssignable right before the write (TOCTOU-safe). This
    // loop only ranks eligibility; hubLat/hubLng here are for the distance sort (resolveAssignHub).
    eligible.push({ driverId, orderCount, hasAcceptedOrder, statusPriority, distanceKm, name: d.name || driverId });
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
  // S3f (gate finding B): every finalize clears the delivery's self-heal marker, so a marker set by the
  // sweeper while observing this claim can never survive a successful finalize and later mislead the heal
  // pass into nulling a FUTURE live claim. (Shared by autoAssign / timeout-reassign / sweeper finalizes.)
  updates[`tasks/${orderId}_delivery/half_claim_since`] = null;
  return updates;
}

// Re-derive whether a driver is still assignable, re-reading current state.
// Closes the TOCTOU race between pickEligibleDriver's snapshot and the
// assignment write (driver may have gone en_route via the pickup swipe, clocked
// off, or been stacked by a concurrent trigger). Mirrors the eligibility + cap
// logic in pickEligibleDriver. Pilot-tier guard; a per-driver capacity lease is
// the harden-before-scale form (see SHERPA_DRIVER_PLAN.md).
async function reassertAssignable(db, driverId, newOrderId = null) {
  const [dSnap, tSnap] = await Promise.all([
    db.ref(`drivers/${driverId}`).once('value'),
    db.ref('tasks').once('value')
  ]);
  const d = dSnap.val();
  if (!d) return { ok: false, reason: 'no_driver' };
  if (d.status === 'off_shift') return { ok: false, reason: 'off_shift' };
  const reachable = (typeof d.push_reachable === 'boolean')
    ? d.push_reachable : !!(d.push_subscription && d.push_subscription.endpoint);
  if (!reachable) return { ok: false, reason: 'unreachable' };
  if (d.timeout_until && d.timeout_until > Date.now()) return { ok: false, reason: 'cooldown' };

  const tasks = tSnap.val() || {};
  // S3a: exclude the order being placed (newOrderId) from the cap count — the sweeper CAS-claims the
  // delivery task BEFORE this recheck, so counting it would wrongly reject a valid stackable driver.
  // No-op for the S2 auto-assign caller (the order isn't claimed there yet).
  const orderCount = activeOrderCount(tasks, driverId, newOrderId);
  let cap;
  if (orderCount === 0) cap = 1;
  else if (orderCount === 1 && STACKABLE_STATUSES.has(d.status)) cap = 2;
  else cap = orderCount;
  if (orderCount >= cap) return { ok: false, reason: `at_cap(${orderCount})` };
  // S2 (TOCTOU-safe): recompute same-hub from THIS fresh read so the force-accept gate uses the state
  // as of right-before-write, not the stale pick-time value.
  const hasAcceptedSameHubOrder = driverHasSameHubAccepted(tasks, driverId, newOrderId);
  return { ok: true, orderCount, hasAcceptedSameHubOrder };
}

// S3d: roll a delivery claim back after a finalize-write failure, and make a DOUBLE fault loud. If the
// finalize update() threw AND the rollback transaction also throws, the order is left delivery-claimed +
// pickup-unassigned = hidden from SIN ASIGNAR (getPendingOrders keys off delivery) with no armed timer —
// a silent strand. We retry the rollback once, then push a dispatcher_alert so a human recovers it rather
// than the order vanishing. Shared by all three server writers' catch blocks.
async function rollbackOrAlert(db, claim, orderId, ctx) {
  try {
    await claim.rollback();
    return;
  } catch (e1) {
    console.error(`${ctx}: rollback failed for ${orderId}, retrying once`, e1);
  }
  try {
    await claim.rollback();
  } catch (e2) {
    console.error(`${ctx}: rollback failed twice for ${orderId} — order may be stranded`, e2);
    try {
      await db.ref('dispatcher_alerts').push({
        type: 'assignment_strand',
        order_id: orderId,
        context: ctx,
        created_at: ServerValue.TIMESTAMP
      });
    } catch (e3) {
      console.error(`${ctx}: strand alert also failed for ${orderId}`, e3);
    }
  }
}

// S3e (gate finding 3): unassign an order back to SIN ASIGNAR (null BOTH tasks), CAS-GUARDED so it can't
// clobber a concurrent reassign. The timeout-monitor's escalation branches run after awaits
// (pickEligibleDriver / order reads) during which a reassign could move the order A→B; a plain null-write
// would then clobber B's fresh assignment. We CAS the delivery to null only if it's STILL on `driverId`
// (claimDelivery to null with expectCurrent=driverId); if that aborts, another writer owns the order now —
// leave it untouched. Returns true iff we actually unassigned. On a post-CAS write failure, restores the
// timed-out driver (consistent, no strand). Extends the universal-CAS discipline to the UNASSIGN paths.
async function releaseToSinAsignar(db, orderId, driverId) {
  // Clear the self-heal marker FIRST (invariant: clear the marker before every null-transition of
  // assigned_driver_id — a null delivery must never carry a stale marker a re-claim could inherit).
  // Defensive — a consistent timed-out order normally carries no marker.
  await db.ref(`tasks/${orderId}_delivery/half_claim_since`).set(null);
  // CAS the delivery FROM the timed-out driver → null, and only proceed if we ACTUALLY transitioned it (not
  // if it was already null, and not if another driver now owns it). Uses the dedicated release primitive —
  // NOT claimDelivery(target=null), whose null-target ownership test false-positives on an already-null
  // delivery and whose rollback would RESURRECT the timed-out driver onto an already-released order.
  const { released } = await releaseDeliveryFromDriver(db, orderId, driverId);
  if (!released) return false;   // wasn't ours to release (already null, or re-owned) — leave it
  const updates = {};
  for (const taskType of ['pickup', 'delivery']) {
    const tid = `${orderId}_${taskType}`;
    updates[`tasks/${tid}/assigned_driver_id`] = null;
    updates[`tasks/${tid}/status`] = 'pending';
    updates[`tasks/${tid}/assignment_deadline`] = null;
  }
  updates[`tasks/${orderId}_delivery/half_claim_since`] = null;
  try {
    await db.ref().update(updates);
    return true;
  } catch (e) {
    // The delivery is ALREADY released (null). Do NOT restore the driver — a failed release must never
    // resurrect. The pickup is left on the old driver = a reverse-mismatch that the sweeper heal reconciles
    // to SIN ASIGNAR within a cycle. Report not-fully-released so the caller skips the premature alert.
    console.error(`releaseToSinAsignar: pickup-unassign failed for ${orderId} (delivery released; heal will reconcile the pickup)`, e);
    return false;
  }
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
    if (!AUTO_ASSIGNABLE_STATUSES.has(orderNow.status)) {
      console.log(`autoAssign: ${orderId} status is '${orderNow.status}' (not auto-assignable), skipping`);
      return;
    }
    if (pickup.status === 'cancelled') {
      console.log(`autoAssign: ${orderId} pickup task is cancelled, skipping`);
      return;
    }

    const { hubLat, hubLng } = resolveAssignHub(orderNow);   // C1: assign against the order's restaurant hub
    const chosen = await pickEligibleDriver(db, [], hubLat, hubLng);
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

    // Close the TOCTOU race: re-read the chosen driver right before the write.
    // If they're no longer assignable (clocked off / went en_route / stacked by
    // a concurrent trigger), abort and alert rather than over-stack them.
    const recheck = await reassertAssignable(db, chosen.driverId, orderId);
    if (!recheck.ok) {
      console.warn(`autoAssign: ${orderId} — ${chosen.driverId} no longer assignable (${recheck.reason}); alerting`);
      await db.ref('dispatcher_alerts').push({
        type: 'no_drivers_available',
        order_id: orderId,
        customer_name: after.recipient_name || 'Cliente',
        total: after.total || null,
        created_at: ServerValue.TIMESTAMP
      });
      return;
    }

    // STACK (force-accept the new order, no swipe) ONLY when the driver has already ACCEPTED an order
    // at the SAME hub as this one — computed from the FRESH recheck read (TOCTOU-safe), so a driver who
    // accepted a cross-hub order between pick and recheck is not force-accepted. A cross-hub 2nd order
    // stays 'assigned' (swipe-to-accept). orderCount stays the basis for the 2-order cap (unchanged).
    const isStacked = recheck.hasAcceptedSameHubOrder;
    if (isStacked) {
      console.log(`autoAssign: ${orderId} is SAME-HUB STACKED on ${chosen.name} (already has ${chosen.orderCount} active)`);
    }

    // S3d: CAS-claim the delivery task before the finalize write, so a manual assign / sweep landing in
    // the window between reassert and this write can't be overwritten (and vice-versa). NULL-claim: a
    // brand-new order's delivery is null → the claim commits uncontended and the finalize update() below
    // rewrites the same value — identical end state to the pre-S3d plain write (no-op on the happy path).
    // Only a genuine race (another writer already claimed) makes it back off instead of double-assigning.
    const claim = await claimDelivery(db, orderId, chosen.driverId);
    if (!claim.claimed) {
      console.warn(`autoAssign: ${orderId} — delivery already claimed by ${claim.current} during finalize; backing off`);
      return;
    }

    // attempts=1 = initial assignment. monitorAssignmentTimeout uses this
    // for its 2-strikes rule (only relevant for non-stacked).
    const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);
    try {
      await db.ref().update(updates);
      console.log(`autoAssign: success for ${orderId} → ${chosen.driverId}`);
    } catch (e) {
      console.error(`autoAssign: write failed for ${orderId}`, e);
      await rollbackOrAlert(db, claim, orderId, 'autoAssign');  // return delivery to SIN ASIGNAR (alert on double-fault)
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
      // CAS-guarded unassign (finding 3): only null if the delivery is still on the timed-out driver — a
      // reassign during the awaits above must not be clobbered. Alert only if we actually unassigned.
      if (await releaseToSinAsignar(db, orderId, driverId)) {
        await db.ref('dispatcher_alerts').push({
          type: 'no_response_takeover',
          order_id: orderId,
          customer_name: order.recipient_name || 'Cliente',
          total: order.total || null,
          attempts,
          created_at: ServerValue.TIMESTAMP
        });
      } else {
        console.log(`timeout-monitor: ${orderId} moved off ${driverId} before takeover-unassign; leaving it`);
      }
      return;
    }

    // First-strike timeout → try one more driver, excluding the timed-out one
    const { hubLat, hubLng } = resolveAssignHub(orderForTimeout);   // C1: reassign against the order's restaurant hub
    const nextDriver = await pickEligibleDriver(db, [driverId], hubLat, hubLng);
    if (!nextDriver) {
      console.warn(`timeout-monitor: no eligible drivers after ${driverId} timeout on ${orderId}, escalating`);
      const orderSnap = await db.ref(`orders/${orderId}`).once('value');
      const order = orderSnap.val() || {};
      // CAS-guarded unassign (finding 3), same as the 2-strike branch.
      if (await releaseToSinAsignar(db, orderId, driverId)) {
        await db.ref('dispatcher_alerts').push({
          type: 'no_drivers_available',
          order_id: orderId,
          customer_name: order.recipient_name || 'Cliente',
          total: order.total || null,
          created_at: ServerValue.TIMESTAMP
        });
      } else {
        console.log(`timeout-monitor: ${orderId} moved off ${driverId} before no-eligible-unassign; leaving it`);
      }
      return;
    }

    console.log(`timeout-monitor: reassigning ${orderId} from ${driverId} → ${nextDriver.name} (attempt ${attempts + 1})`);

    // S3d: CAS-claim the delivery task, REPLACING the timed-out driver — expectCurrent = driverId, NOT
    // null. The delivery is already assigned to the timed-out driver here (pickup+delivery were assigned
    // together), so a null-claim would abort every reassign. The claim only commits if the field is STILL
    // the timed-out driver; if a concurrent writer moved it during our 60s wait, we back off (the field
    // already reflects that writer's decision). Uncontended (field still == driverId), it's a no-op: the
    // finalize update() rewrites the same delivery/assigned_driver_id = nextDriver.
    const claim = await claimDelivery(db, orderId, nextDriver.driverId, { expectCurrent: driverId });
    if (!claim.claimed) {
      console.log(`timeout-monitor: ${orderId} delivery no longer on ${driverId} (now ${claim.current}); backing off reassign`);
      return;
    }
    const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);
    try {
      await db.ref().update(reassignUpdates);
      // The new assigned_driver_id write will trigger another monitorAssignmentTimeout
      // for the new driver. The notifyDriverOnAssignment trigger will push to them.
    } catch (e) {
      console.error(`timeout-monitor: reassignment write failed for ${orderId}`, e);
      await rollbackOrAlert(db, claim, orderId, 'timeout-reassign');  // restore timed-out driver (alert on double-fault)
    }
  }
);

// ============================================================
// sweepPendingOrders — S3: re-offer stuck pending orders to newly-eligible drivers
// ============================================================
//
// A pending order that ran out of drivers (autoAssign / timeout no-eligible) sits in SIN ASIGNAR
// (dispatcher-visible) — today, manual-only. This scheduled sweep re-offers such orders to any
// newly-eligible driver via the NORMAL placement path (a normal 'assigned' swipe that re-arms
// monitorAssignmentTimeout), so a freed-up driver picks them up without a human. Dispatcher-parked
// orders are exempt (the explicit "behaves like today" opt-out). It is NEVER removed from SIN ASIGNAR
// (always human-grabbable) → no black hole by construction.
//
// PURELY ADDITIVE: the entire timeout/assign path is unchanged. The one new behaviour (auto-retry of
// pending orders) is the conscious change (pinned via sweepDecision in sweep-pending.test.js).
//
// retry_count (on the delivery task) counts actual OFFERS that then bounced (drivers declining), NOT
// no-driver cycles — so a no-taker order keeps waiting for a driver to free, and the throttle only
// gives up on an order drivers repeatedly decline (dispatcher then looks / parks it).
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_RETRY_MAX = 2;
// Finding 4: a half-claim must persist THIS long (≥ a full sweep cycle) before the sweeper heals it, so a
// live in-flight claim (claim→finalize is milliseconds) is never mistaken for a strand.
const HALF_CLAIM_STALE_MS = 2 * SWEEP_INTERVAL_MS;

exports.sweepPendingOrders = onSchedule(
  { schedule: 'every 1 minutes', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db = getDatabase();
    const now = Date.now();
    // Read config + all data up front. The HEAL pass runs EVERY tick regardless of the flags (H1) — the
    // delivery CAS-claim is on the LIVE autoAssign/timeout paths, so a strand there must self-heal even
    // while the pending-re-offer behaviour is OFF. Only the OFFER pass is gated.
    const [sweepEnabledSnap, autoEnabledSnap, ordersSnap, tasksSnap] = await Promise.all([
      db.ref('config/sweep_pending_enabled').once('value'),
      db.ref('config/auto_assign_enabled').once('value'),
      db.ref('orders').once('value'),
      db.ref('tasks').once('value')
    ]);
    const orders = ordersSnap.val() || {};
    const tasks = tasksSnap.val() || {};
    let offered = 0, waiting = 0, healed = 0;

    // ---- HEAL PASS (ALWAYS on, H1) — self-heal stranded/inconsistent assignments ----
    // A process death between a delivery CAS-claim and its finalize leaves pickup and delivery on DIFFERENT
    // drivers — a "half-claim" (delivery claimed, pickup null: autoAssign/sweeper/manual) or a "split"
    // (delivery→new, pickup still old: timeout-reassign/reassignOrder). Both are hidden from SIN ASIGNAR and
    // never self-recover; the split even leaves two drivers each holding half an order. This is the safety
    // net for the universal CAS on the LIVE paths, so it runs regardless of the offer flag.
    // assignmentStrandState two-passes via a half_claim_since marker so a live in-flight window (ms) is
    // never healed (staleMs=120s > every writer's 90s claim→finalize bound).
    for (const orderId of Object.keys(orders)) {
      // #4: never TOUCH a terminal (done) order — skip BEFORE strand-eval so a delivered/cancelled
      // order with a historical mismatch gets zero sweeper writes (no mark/wait/heal marker churn).
      // The fresh-status re-read at the heal step below stays, for a cancel/delivery that lands AFTER
      // this batch snapshot but before the (much later) heal write.
      if (HEAL_TERMINAL_STATUSES.has(orders[orderId]?.status)) continue;
      const delTask = tasks[`${orderId}_delivery`];
      const pickTask = tasks[`${orderId}_pickup`];
      const st = assignmentStrandState(pickTask, delTask, now, { staleMs: HALF_CLAIM_STALE_MS });
      if (st === 'none') {
        if (delTask && typeof delTask.half_claim_since === 'number') {
          await db.ref(`tasks/${orderId}_delivery/half_claim_since`).set(null);  // clear a stale marker on a since-consistent order
        }
        continue;
      }
      if (st === 'mark') { await db.ref(`tasks/${orderId}_delivery/half_claim_since`).set(now); continue; }
      if (st === 'wait') continue;
      // st === 'heal'. Two server-gate guards on this destructive write:
      //   #2 terminal — re-read the order status FRESH (a cancel/delivery may have landed after the batch
      //      snapshot); never heal a TERMINAL order (cancelled/delivered/completed) — its tasks are
      //      legitimately final (fix #4) — just clear any stale marker.
      const freshStatus = (await db.ref(`orders/${orderId}/status`).once('value')).val();
      if (HEAL_TERMINAL_STATUSES.has(freshStatus)) {
        if (delTask && typeof delTask.half_claim_since === 'number') {
          await db.ref(`tasks/${orderId}_delivery/half_claim_since`).set(null);
        }
        continue;
      }
      //   #1 overlapping healers — CAS each task's assigned_driver_id on the STRANDED snapshot value, so a
      //      re-claim since the snapshot (changed assigned_driver_id) aborts the txn and is never clobbered.
      //      Restores the CAS-guard the S3i atomic-update dropped. Clears the marker FIRST (clear-first).
      // KNOWN RESIDUAL (accepted, arbiter-logged — see DRIVER_PICKUP_HUB_S3d.md): if the order transitions
      // to terminal (delivered/cancelled) in the sub-second window BETWEEN the fresh-status read above and
      // this task-CAS, the heal still nulls its task assigned_driver_id. Cosmetic only — the order is
      // already done, so its task drivers no longer drive any live behavior; and the CAS is per-task-leaf,
      // so there's no clean way to atomically condition it on the order-status node. Rare² (terminal
      // transition × already-stranded mismatch); prod dry-run (Gate 3.6) found zero live instances.
      const strandedDel = delTask.assigned_driver_id == null ? null : delTask.assigned_driver_id;
      const strandedPick = pickTask && pickTask.assigned_driver_id != null ? pickTask.assigned_driver_id : null;
      const { healed: didHeal } = await healStrandedOrder(db, orderId, strandedDel, strandedPick);
      if (didHeal) {
        healed++;
        console.warn(`sweepPending: self-healed strand ${orderId} (delivery ${strandedDel}, pickup ${strandedPick})`);
      }
    }

    // ---- OFFER PASS (gated, S3a kill-switch) ----
    // Stays OFF until config/sweep_pending_enabled === true (flip only after every writer's CAS is live, so a
    // dispatcher grab landing mid-sweep can't be overwritten). Also honor the global auto-assign pause.
    if (sweepEnabledSnap.val() !== true) { if (healed) console.log(`sweepPending: healed ${healed} (offer pass off)`); return; }
    if (autoEnabledSnap.val() === false) { console.log(`sweepPending: offer pass skipped (auto-assign paused)${healed ? `, healed ${healed}` : ''}`); return; }
    const opts = { graceMs: GRACE_PERIOD_MS, sweepIntervalMs: SWEEP_INTERVAL_MS, retryMax: SWEEP_RETRY_MAX };

    for (const orderId of Object.keys(orders)) {
      const order = orders[orderId];
      if (!sweepDecision(order, tasks, now, opts).sweep) continue;

      // Best currently-eligible driver — normal ranking (fewest orders → priority → nearest), no dibs.
      const { hubLat, hubLng } = resolveAssignHub(order);
      const chosen = await pickEligibleDriver(db, [], hubLat, hubLng);
      if (!chosen) { waiting++; continue; }   // no taker this cycle — leave pending, keep waiting (no throttle bump)

      // S3d: CAS-claim the DELIVERY task's assigned_driver_id (null → chosen) via the shared helper. This
      // is the field getPendingOrders reads, so the claim atomically leaves SIN ASIGNAR + blocks a
      // concurrent sweep/grab, and it's invisible to monitorAssignmentTimeout (watches PICKUP) and
      // notifyDriverOnAssignment (fires on pickup only). NULL-claim: a pending order's delivery is null.
      const claim = await claimDelivery(db, orderId, chosen.driverId);
      if (!claim.claimed) continue;   // lost the race — skip

      // S3a exception-safety: EVERYTHING after the claim is inside try/catch so any throw (recheck read,
      // finalize write, etc.) rolls the claim back — the order can never be stranded delivery-claimed +
      // hidden from SIN ASIGNAR. claim.rollback() only nulls the field if it's still OURS (no clobber).
      try {
        // TOCTOU recheck (excludes THIS order from the cap) + fresh finalize revalidation: re-read the
        // order + delivery task immediately before the write. sweepDecision ran against the batch snapshot,
        // so a dispatcher park, a cancel, a status change, or a driver-state change landing mid-sweep must
        // abort the placement. (delNow is also the FRESH source for retry_count below.)
        const recheck = await reassertAssignable(db, chosen.driverId, orderId);
        const [parkedSnap, orderNowSnap, delNowSnap, pickupNowSnap] = await Promise.all([
          db.ref(`orders/${orderId}/dispatch_parked`).once('value'),
          db.ref(`orders/${orderId}`).once('value'),
          db.ref(`tasks/${orderId}_delivery`).once('value'),
          db.ref(`tasks/${orderId}_pickup`).once('value')
        ]);
        const parkedNow = parkedSnap.val();
        const orderNow = orderNowSnap.val();
        const delNow = delNowSnap.val();
        const pickupNow = pickupNowSnap.val();
        const stillOurs = !!delNow && delNow.assigned_driver_id === chosen.driverId && delNow.status !== 'cancelled';
        const stillSweepable = !!orderNow && AUTO_ASSIGNABLE_STATUSES.has(orderNow.status);
        // Finding 2 (cancel-revival): also require a FRESH pickup that is still unassigned and not cancelled.
        // cancelOrder() flips both task statuses to 'cancelled' but does NOT touch delivery/assigned_driver_id,
        // so our claim survives a cancel — without this guard the unconditional finalize would REVIVE both
        // tasks to 'assigned' + fire a spurious driver push for an order that stays cancelled. This closes the
        // window down to the irreducible read→update gap (a few ms), documented as an accepted residual.
        const pickupClean = !!pickupNow && !pickupNow.assigned_driver_id && pickupNow.status !== 'cancelled';
        if (!recheck.ok || parkedNow || !stillOurs || !stillSweepable || !pickupClean) {
          await claim.rollback();   // back to SIN ASIGNAR, no throttle bump
          continue;
        }

        // Finalize as a NORMAL new offer: attempts=1 → fresh 60s deadline + slide-to-accept, re-arms the
        // timer. Same-hub force-accept (S3a): mirror autoAssign — if the chosen driver already ACCEPTED a
        // SAME-HUB order, force-accept (no swipe); a cross-hub 2nd order stays 'assigned'.
        // Atomic retry_count: read FRESH from delNow (taken under our exclusive claim — no other writer can
        // touch this delivery while we hold it), NOT the stale batch snapshot, so the bump can't double- or
        // under-count. retry_count is written SEPARATELY (buildAssignmentUpdates never touches it).
        const retryCount = (delNow.retry_count) || 0;
        const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, recheck.hasAcceptedSameHubOrder);
        updates[`tasks/${orderId}_delivery/retry_count`] = retryCount + 1;
        updates[`tasks/${orderId}_delivery/last_swept`] = now;
        await db.ref().update(updates);
        offered++;
        console.log(`sweepPending: re-offered ${orderId} → ${chosen.name} (offer ${retryCount + 1})`);
      } catch (e) {
        console.error(`sweepPending: failed after claim for ${orderId}`, e);
        await rollbackOrAlert(db, claim, orderId, 'sweepPending');
      }
    }
    if (offered || waiting || healed) console.log(`sweepPending: offered ${offered}, waiting ${waiting}, healed ${healed}`);
  }
);

// ============================================================
// Scheduled Orders — release sweep + dispatcher override (SCHEDULED_ORDERS_PLAN §C/§D)
// ============================================================

// Deps for the release core: alert via the shipped dispatcher-alert surface; a fresh public token per release.
function scheduledReleaseDeps(db) {
  return { db, alert: (kind, detail) => paymentAlert(db, kind, detail), genToken: () => generateTrackingToken() };
}

// sweepScheduledReleases — every 2 min: atomically release DUE scheduled orders (scheduled→releasing→new,
// single-claim; closed-at-release → HOLD + alert) + recover stale releasing claims. Overdue/SLA alerting is
// reconcilePayments' job (daily) to avoid a 2-min re-alert loop. Runs unless explicitly disabled — a held
// order that never releases is captured money with no service, so the sweep must run for the feature to be safe.
exports.sweepScheduledReleases = onSchedule(
  { schedule: 'every 2 minutes', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const crypto = require('crypto');
    const db = getDatabase();
    const now = Date.now();
    const enabledSnap = await db.ref('config/scheduled_releases_enabled').once('value');
    if (enabledSnap.val() === false) { console.log('sweepScheduledReleases: disabled'); return; }

    const deps = scheduledReleaseDeps(db);
    let released = 0, blocked = 0, recovered = 0;

    // Due scheduled orders — indexed status query + in-memory release_at filter (R1-#9).
    const schedSnap = await db.ref('orders').orderByChild('status').equalTo('scheduled').once('value');
    for (const [orderId, order] of Object.entries(schedSnap.val() || {})) {
      if (SCHED.releaseDecision(order, now).action !== 'claim') continue;
      try {
        const r = await releaseScheduledCore(deps, { orderId, now, claimId: crypto.randomUUID() });
        if (r.released) released++; else if (r.blocked) blocked++;
      } catch (e) { console.error(`sweepScheduledReleases: release ${orderId} failed`, e.message); }
    }

    // Recover stale releasing claims (an owner that died mid-materialize).
    const relSnap = await db.ref('orders').orderByChild('status').equalTo('releasing').once('value');
    for (const [orderId, order] of Object.entries(relSnap.val() || {})) {
      if (SCHED.releaseDecision(order, now).action !== 'recover_stale') continue;
      try {
        const r = await recoverStaleReleasing(deps, { orderId, now, claimId: crypto.randomUUID() });
        if (r.recovered) recovered++;
      } catch (e) { console.error(`sweepScheduledReleases: recover ${orderId} failed`, e.message); }
    }
    if (released || blocked || recovered) console.log(`sweepScheduledReleases: released ${released}, blocked ${blocked}, recovered ${recovered}`);
  }
);

// releaseScheduledOrder — dispatcher-only, audited MANUAL release (R2-#2). Clears scheduled_blocked and
// forces the release gate to now, then runs the IDENTICAL single-claim materialization (never a raw
// status→new write). If the slot is still closed/invalid it re-blocks (dispatcher then refunds via
// cancelPaidOrder). Used to clear a scheduled_blocked hold once the kitchen can fulfill it.
exports.releaseScheduledOrder = onRequest(
  { region: 'us-central1', cors: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    const crypto = require('crypto');
    const auth = await authorizeDispatcherAction(req);
    if (!auth.ok) return res.status(auth.code || 403).json({ error: 'forbidden', detail: auth.msg });
    const orderId = String((req.body || {}).order_id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return badRequest(res, 'valid order_id required');

    const db = getDatabase();
    const now = Date.now();
    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!order) return res.status(404).json({ error: 'not_found' });
    if (order.status === 'releasing') return res.status(409).json({ error: 'release_in_progress', detail: 'order is materializing; the sweep recovers it if stalled' });
    if (order.status !== 'scheduled') return res.status(409).json({ error: 'not_releasable', detail: `order is ${order.status}, not scheduled` });

    // Dispatcher override: clear the block + force the release gate to now, then the SAME claim path runs
    // (which STILL re-validates open hours — a manual release can't dump onto a closed kitchen either).
    const patch = { release_at: Math.min(Number(order.release_at) || now, now) };
    if (order.scheduled_blocked) { patch.scheduled_blocked = null; patch.blocked_reason = null; }
    await db.ref(`orders/${orderId}`).update(patch);

    let result;
    try {
      result = await releaseScheduledCore(scheduledReleaseDeps(db), { orderId, now, claimId: crypto.randomUUID() });
    } catch (e) {
      console.error(`releaseScheduledOrder: ${orderId} failed`, e.message);
      return res.status(500).json({ error: 'release_failed', detail: e.message });
    }
    await db.ref('scheduled_release_audit').push({ order_id: orderId, actor: auth.actor || 'dispatcher', at: ServerValue.TIMESTAMP, result });
    return res.status(result.released ? 200 : 409).json({ ok: !!result.released, order_id: orderId, ...result });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// User Profiles P0 — WhatsApp-OTP account auth (requestOtp / verifyOtp / deleteAccount)
// These endpoints are their OWN auth (no ORDER_SECRET). CORS = EXACT allowlist (H6). otp-lib is
// required LAZILY so a missing/weak OTP_SALT fails ONLY these endpoints closed (500, H7) — it does
// NOT couple the rest of the functions module (createOrder, payments) to the OTP secret.
// ─────────────────────────────────────────────────────────────────────────────
const ACCOUNT_ORIGINS = [
  'https://orders.xpizza.hn',
  'https://orders.lamusa.hn',
];

exports.requestOtp = onRequest(
  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    let OTP;
    try { OTP = require('./otp-lib'); }
    catch (e) { console.error('requestOtp: OTP_SALT misconfigured — failing closed', e.message); return res.status(500).json({ ok: false }); }
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const { phone, restaurant_id } = req.body || {};
      const { restaurantId } = resolveRestaurantId(restaurant_id);
      const pHash = OTP.phoneHash(phone);
      if (!pHash) return res.status(200).json({ ok: true, cooldown: 30 });   // uniform — no enumeration
      const now = Date.now();
      const db = getDatabase();
      // per-IP soft cap (secondary; req.ip is the Cloud Run-trusted peer, NOT spoofable XFF — H4)
      const ipHash = require('crypto').createHash('sha256').update(String(req.ip || '')).digest('hex');
      const ipTx = await db.ref('otp_ip/' + ipHash).transaction((v) => OTP.ipReserve(v, now));
      if (!ipTx.committed) return res.status(200).json({ ok: true, cooldown: 30 });   // rate-limited → uniform
      // per-phone atomic slot reservation (GLOBAL across brands, H4)
      let code = null;
      const tx = await db.ref('otp/' + pHash).transaction((v) => { const r = OTP.sendReserve(v, now); code = r.code; return r.next; });
      if (!tx.committed || !code) return res.status(200).json({ ok: true, cooldown: 30 });   // too soon / too many → uniform
      // Stash the brand this code was requested for (server-only otp node) so verifyOtp can credit the
      // welcome to the RIGHT brand — spoof-proof, no client-supplied brand at verify. verifyConsume spreads
      // `...v`, so this rid survives the consume transaction. Fail-open: on miss, verifyOtp defaults x_pizza.
      try { await db.ref('otp/' + pHash + '/rid').set(restaurantId); } catch (_) {}
      const brand = restaurantId === 'la_musa' ? 'La Musa' : 'X. Pizza';
      await whatsapp.sendMessage(phone, `Tu código de ${brand} es ${code}. Vence en 5 minutos. No lo compartas.`, restaurantId);
      return res.status(200).json({ ok: true, cooldown: 30 });
    } catch (e) {
      console.error('requestOtp', e);
      return res.status(200).json({ ok: true, cooldown: 30 });   // never leak — uniform
    }
  }
);

exports.verifyOtp = onRequest(
  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    let OTP;
    try { OTP = require('./otp-lib'); }
    catch (e) { console.error('verifyOtp: OTP_SALT misconfigured — failing closed', e.message); return res.status(500).json({ ok: false }); }
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const { phone, code } = req.body || {};
      const pHash = OTP.phoneHash(phone);
      if (!pHash || !/^\d{6}$/.test(String(code || ''))) return res.status(200).json({ ok: false });   // generic
      const now = Date.now();
      const db = getDatabase();
      const otpRef = db.ref('otp/' + pHash);
      // ATOMIC (H3): verify expiry/attempts/code AND consume (mark consumed) in ONE transaction, BEFORE any
      // mint. Parallel verifies can't exceed the 5-attempt cap or mint twice — `consumed` is CAS-guarded.
      let outcome = 'fail';
      await otpRef.transaction((v) => { const r = OTP.verifyConsume(v, now, String(code)); outcome = r.outcome; return r.next; });
      if (outcome !== 'ok') return res.status(200).json({ ok: false });   // wrong/expired/capped → generic, no mint

      // Resolve/create the stable server-issued uid. `u_`-prefixed → DISJOINT from Firebase staff/driver
      // UIDs by construction (staff sign in with email/password; their UIDs are never `u_...`), so a
      // customer:true token can never collide with a staff uid in the uid-match rules.
      const idxRef = db.ref('phone_index/' + pHash);
      let uid = (await idxRef.get()).val();
      if (!uid) { uid = 'u_' + require('crypto').randomBytes(12).toString('hex'); await idxRef.set(uid); }
      const now2 = Date.now();
      const profRef = db.ref('user_profiles/' + uid);
      const prof = (await profRef.get()).val();
      // phone_hash is stored (server-only write) so deleteAccount/sweep can find /phone_index in O(1).
      if (!prof) await profRef.set({ phone: OTP.normalizePhone(phone), phone_hash: pHash, created_at: now2, last_login: now2 });
      else await profRef.child('last_login').set(now2);
      const rid = resolveRestaurantId((await otpRef.child('rid').get()).val()).restaurantId;   // brand the code was requested for
      await otpRef.remove();   // one-time use — the code cannot be replayed
      const token = await getAuth().createCustomToken(uid, { customer: true });   // mint ONLY after verified+consumed
      // Rewards Phase A — welcome bonus, once per phone_hash per brand (reward_welcome tombstone → un-farmable,
      // survives account deletion). Fail-open: NEVER block login/token issuance on a rewards error.
      try { await creditWelcome(db, { uid, phoneHash: pHash, restaurantId: rid, now: now2 }); }
      catch (e) { console.warn('verifyOtp: welcome credit fail-open —', e && e.message); }
      return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null });
    } catch (e) {
      console.error('verifyOtp', e);
      return res.status(200).json({ ok: false });
    }
  }
);

// ============================================================
// quoteRedemption (Rewards B2) — READ-ONLY redemption preview for the checkout review (mockup screen 5)
// ============================================================
// The live order handlers compute the discount internally but never return it, so the UI needs a server-
// authoritative preview WITHOUT ever client-computing a discount. This runs the SAME redemption flow as intake
// (uid-first gate/allowlist → server-priced cart → compute/La-Musa-86/price) + a read-only available check —
// NO reserve, NO order, NO DB write. Guarantee (narrowed): the quoted discount === the discount submit applies
// GIVEN submit reaches redemption (submit-only cart/placeability gates are not run here — the UI routes their
// item_unavailable/closed to the existing cart error paths, never the redemption fallback).
exports.quoteRedemption = onRequest(
  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
      const body = req.body || {};
      const { restaurantId, error: ridError } = resolveRestaurantId(body.restaurant_id);
      if (ridError) return res.status(400).json({ ok: false, error: 'bad_request', detail: ridError });
      const db = getDatabase();
      // Verified non-guest uid — SAME as intake (customer:true + tombstone check); a client-supplied uid is never used.
      let customerUid = null;
      const idTok = req.get('x-firebase-id-token');
      if (idTok) {
        try {
          const dec = await getAuth().verifyIdToken(idTok);
          if (dec && dec.customer === true && dec.uid) {
            const tomb = await db.ref('deleted_uids/' + dec.uid).get();
            customerUid = attributionUid(dec, tomb.exists());
          }
        } catch (_) { customerUid = null; }   // malformed/expired/foreign/tomb-read-failure → guest
      }
      const q = await quoteRedemptionCore(db, { redeem: body.redeem, items: body.items, restaurantId, customerUid });
      if (!q.ok) return res.status(q.status).json({ ok: false, ...q.body });   // same typed errors as intake (+ bad_cart)
      return res.status(200).json(q);   // { ok:true, discount_cents, total_cents, subtotal_cents, tax_cents, free_item:{name} }
    } catch (e) {
      console.error('quoteRedemption', e && e.message);
      return res.status(500).json({ ok: false, error: 'error' });
    }
  }
);

// deleteAccount (H10) — server-side account deletion. The client CANNOT null its profile directly (the
// user_profiles .write rule requires newData.exists()); deletion goes through here, authenticated by the
// caller's own Firebase ID token. Clears the caller's profile + order history + phone_index atomically.
const ACCOUNT = require('./account-lib');

exports.deleteAccount = onRequest(
  { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const idTok = req.get('x-firebase-id-token');
      if (!idTok) return res.status(401).json({ ok: false });
      let dec;
      try { dec = await getAuth().verifyIdToken(idTok); }
      catch (_) { return res.status(401).json({ ok: false }); }
      if (!dec || dec.customer !== true || !dec.uid) return res.status(403).json({ ok: false });
      const uid = dec.uid;   // only ever the CALLER's own account — a client can't pass someone else's uid
      const db = getDatabase();
      const pHash = (await db.ref(`user_profiles/${uid}/phone_hash`).get()).val();
      await db.ref().update(ACCOUNT.accountDeleteUpdates(uid, pHash, Date.now()));
      console.log(`deleteAccount: cleared account ${uid}`);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('deleteAccount', e);
      return res.status(500).json({ ok: false });
    }
  }
);

// Inactivity-aging sweep (H9) — a scheduled server-side prune of accounts dormant > ~6 months, so a
// recycled phone number resolves to a FRESH account rather than inheriting the prior holder's (a risk
// REDUCER, not a proof of ownership). Reads all profiles (P0 scale is small) and applies one atomic delete.
exports.pruneInactiveAccounts = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db = getDatabase();
    const snap = await db.ref('user_profiles').get();
    if (!snap.exists()) { console.log('pruneInactiveAccounts: no profiles'); return; }
    const cutoff = Date.now() - ACCOUNT.INACTIVE_MS;
    const { updates, count } = ACCOUNT.pruneUpdates(snap.val(), cutoff);
    if (count) await db.ref().update(updates);
    console.log(`pruneInactiveAccounts: removed ${count} inactive profile(s) (cutoff ${new Date(cutoff).toISOString()})`);
  }
);

// ── Test-only exports (NOT Cloud Function triggers — the Firebase deployer only deploys CloudFunction
// instances, so these plain values are ignored at deploy). Let the RTDB emulator suites exercise the
// per-token claimPrefill throttle (checkRateLimit + the claim_token bucket) directly.
module.exports.checkRateLimit = checkRateLimit;
module.exports.RATE_LIMIT_BUCKETS = RATE_LIMIT_BUCKETS;
