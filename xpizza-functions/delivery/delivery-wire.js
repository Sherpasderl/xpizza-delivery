'use strict';
// S3a — ENVÍO, the order-path seam. index.js calls these on ONE line per site (inverse-fold invariant:
// tools/s3a-inverse.js); everything they decide is in delivery-pricing.js (pure).
//
// The result `dq` of deliveryFor is:
//   null                    DARK (no config / restaurant not active) — every caller behaves exactly as before S3
//   { ctx }                 ACTIVE: the envío for this request (quoteDelivery)
//   { refusal, httpStatus } ACTIVE but refused (no mode / no confirmed pin / outside the bands / config invalid or
//                           unreadable). The ORDER paths refuse through the gate step (refusalGate), which runs AFTER
//                           a live issued PixelPay checkout is resumed (§3.3 grandfathering) and releases a reward hold.
const P = require('./delivery-pricing');

const REFUSAL_STATUS = { delivery_pricing_unavailable: 503 };

// One read of platform_config/delivery_pricing. NEVER rejects (a handler starts it early and may return before awaiting
// it). A read FAILURE is a refusal (fail closed), never dark: an outage must not make an active restaurant's delivery free.
async function loadPricing(db, rid) {
  try {
    const snap = await db.ref('platform_config/delivery_pricing').get();
    return { pricing: P.readPricing(snap.val(), rid) };
  } catch (e) {
    return { failed: true };
  }
}

// The ORDER paths' envío. Dark → null after ONE config read (no identity read). Active → the hub from the restaurant
// identity (the same cached reader the order path uses; unreadable → a 503 refusal, never free).
async function deliveryFor(db, { rid, mode, pin, customerUid, getIdentity, pricingP }) {
  const lp = await (pricingP || loadPricing(db, rid));   // pricingP: the handler started the read in parallel with its first reads
  if (lp.failed) return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 };
  if (!lp.pricing) return null;
  let identity = null;
  try { identity = await getIdentity(db, rid); } catch (_) { return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }; }
  const hub = identity && { lat: identity.hub_lat, lng: identity.hub_lng };
  const q = P.quoteDelivery({ pricing: lp.pricing, hub, mode, pin, customerUid });
  return q.refusal ? { refusal: q.refusal, httpStatus: REFUSAL_STATUS[q.refusal] || 409 } : q;
}

/* The CHARGE path, against the STORED order (codex S3a P1-1 / P1-2). Only when activated: dark (dq null) reads nothing.
   One read of orders/{id}; absent → this request's dq (a fresh order). Present:
     · already paid → this request's dq (the acquire answers already_paid, as today)
     · a LIVE issued checkout (its active attempt 'created', unexpired) keeps its STORED economics — storedCtx, or
       food-only when it was issued dark — so the checkout is reused, never re-priced or refused (§3.3)
     · otherwise a different fulfilment or pin than the stored order's → refused order_context_changed: the client starts a
       fresh order; mixed contexts are never re-priced
   A refusal dq is answered by the handler BEFORE any pending order or hold exists. */
async function chargeContext(db, orderId, dq, body, now) {
  if (!dq) return dq;
  const order = (await db.ref(`orders/${orderId}`).get()).val();
  if (!order || order.payment_status === 'confirmed') return dq;   // fresh, or already paid (the acquire answers already_paid as today)
  if (typeof order.active_attempt_id === 'string' && order.active_attempt_id) {
    const at = (await db.ref(`payment_attempts/${order.active_attempt_id}`).get()).val();
    if (at && at.hosted_state === 'created' && Number(at.hosted_expires_at) > now) { const c = P.storedCtx(order); return c ? { ctx: c } : null; }
  }
  const pin = orderPin(body);
  const same = order.order_type === (body && body.order_type)
    && (order.order_type !== 'delivery' || (Number(order.lat) === pin.lat && Number(order.lng) === pin.lng));
  return same ? dq : { refusal: 'order_context_changed', httpStatus: 409 };
}

// The order body's pin: lat/lng are the existing top-level fields; `pin_confirmed: true` is the new client's assertion.
const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
const orderPin = (body) => ({ lat: num(body && body.lat), lng: num(body && body.lng), confirmed: !!(body && body.pin_confirmed === true) });
// The quote body's pin: { pin: { lat, lng, confirmed } } (plan §10.2 fixture).
const quotePin = (body) => (body && body.pin && typeof body.pin === 'object' ? { lat: num(body.pin.lat), lng: num(body.pin.lng), confirmed: body.pin.confirmed === true } : null);

const ctxOf = (dq) => (dq && dq.ctx ? dq.ctx : null);

// The breakdown the order RECORDS and CHARGES: unchanged when dark/refused; else total + net envío and the envío facts.
// subtotal/tax stay the FOOD split (envío is pass-through to Sherpa, outside the restaurant's revenue and factura).
function withDelivery(dq, breakdown) {
  const c = ctxOf(dq);
  if (!c) return breakdown;
  return {
    ...breakdown,
    total_cents: breakdown.total_cents + P.netDeliveryCents(c),
    delivery_cents: c.delivery_cents,
    promo_discount_cents: c.promo_discount_cents,
    delivery_snapshot: { mode: c.mode, policy_version: c.policy_version, ...(c.mode === 'delivery' ? { km: c.km, band: c.band, promo: c.promo || null } : {}) },
  };
}
// The order's `total` (LEMPIRAS — what the driver app collects and the cash count sums): food + net envío when active, so
// `total` and `total_cents` stay one number. The reward earn base keeps the FOOD total (callers pass it unchanged there).
const totalLempiras = (dq, foodLempiras) => (ctxOf(dq) ? foodLempiras + P.netDeliveryCents(ctxOf(dq)) / 100 : foodLempiras);
// The fields the hosted path copies onto the pending order (the cash path spreads the whole breakdown).
const orderFields = (b) => (b && b.delivery_snapshot ? { delivery_cents: b.delivery_cents, promo_discount_cents: b.promo_discount_cents, delivery_snapshot: b.delivery_snapshot } : {});

// applyConfirmedNetGate's envío argument (it joins the gate's recompute, so the token is checked against food + envío).
const gateExtra = (dq) => (ctxOf(dq) ? { deliveryContext: ctxOf(dq) } : {});

// An ACTIVE refusal at the gate step: release the hold, answer with the typed refusal. null → run the real gate.
async function refusalGate(dq, releaseHold, orderId) {
  if (!dq || !dq.refusal) return null;
  try { await releaseHold(); } catch (_) { /* best-effort, as the gate's own release */ }
  try { console.warn('delivery_refused', JSON.stringify({ orderId, refusal: dq.refusal })); } catch (_) {}
  return { refuse: { status: dq.httpStatus, body: { error: dq.refusal, ...(dq.httpStatus === 503 ? { retryable: true } : {}), order_id: orderId } }, provenance: null, result: null };
}

/* The QUOTE endpoints' envío: { refuse, httpStatus } when active and refused (a config outage → 503, codex S3a P2-6; a request
   refusal → a fail-soft 200 body), else { ctx, uid } (ctx null when
   dark). Dark costs ONE config read and nothing else — no identity read, no token verify, and uid stays what the caller
   had (quoteOrder: null), so a dark quote is byte-identical. Active: the hub from the restaurant identity, and for
   quoteOrder an OPTIONAL customer ID token (customer:true, not tombstoned) — the promo is account-only.
   `knownUid` (quoteRedemption already verified one) skips the second verify. */
async function quoteDeliveryFor(req, db, rid, body, { getIdentity, getAuth, attributionUid, knownUid, pricingP }) {
  const lp = await (pricingP || loadPricing(db, rid));
  if (lp.failed) return { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 };
  if (!lp.pricing) return { ctx: null, uid: knownUid === undefined ? null : knownUid };
  let uid = knownUid === undefined ? null : knownUid;
  if (knownUid === undefined) {
    const idTok = req.get && req.get('x-firebase-id-token');
    if (idTok) {
      try {
        const dec = await getAuth().verifyIdToken(idTok);
        if (dec && dec.customer === true && dec.uid) uid = attributionUid(dec, (await db.ref('deleted_uids/' + dec.uid).get()).exists());
      } catch (_) { uid = null; }   // malformed/expired/foreign → guest (pays envío)
    }
  }
  let identity = null;
  try { identity = await getIdentity(db, rid); } catch (_) { return { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 }; }
  const q = P.quoteDelivery({ pricing: lp.pricing, hub: identity && { lat: identity.hub_lat, lng: identity.hub_lng }, mode: body && body.mode, pin: quotePin(body), customerUid: uid });
  return q.refusal ? { refuse: { ok: false, error: q.refusal }, httpStatus: REFUSAL_STATUS[q.refusal] === 503 ? 503 : 200 } : { ctx: q.ctx, uid };   // a config outage is a 503; a request refusal stays a fail-soft 200 body
}

// The quote endpoints: { refuse } (fail-soft 200 body) when active and refused; else the ctx (or null when dark).
function quoteOutcome(dq) {
  if (dq && dq.refusal) return { refuse: { ok: false, error: dq.refusal } };
  return { ctx: ctxOf(dq) };
}
// The additive quote response fields (absent when dark → byte-identical response).
const quoteFields = (ctx) => (ctx ? { delivery: { delivery_cents: ctx.delivery_cents, promo_discount_cents: ctx.promo_discount_cents, policy_version: ctx.policy_version, mode: ctx.mode } } : {});

module.exports = { loadPricing, deliveryFor, quoteDeliveryFor, chargeContext, orderPin, quotePin, withDelivery, totalLempiras, orderFields, gateExtra, refusalGate, quoteOutcome, quoteFields, ctxOf };
