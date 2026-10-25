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
const TIP = require('../tip');   // S2-srv-tip (PLAN-capp-S2-r4 §3)

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
/* S2 (§3.1): `tip` is the request's raw tip_cents (already validated by the handler's early TIP.orderRefusal). A tip needs an
   ACTIVE restaurant (dark + tip → 409 tip_not_enabled) and a delivery (pickup + tip → 400 tip_pickup); otherwise it rides the
   server ctx (P.withTip), so the breakdown, the gate's recompute and the record all carry it. No tip → byte-identical. */
async function deliveryFor(db, { rid, mode, pin, customerUid, getIdentity, pricingP, tip }) {
  const t = TIP.normTip(tip);
  if (Number.isNaN(t)) return { refusal: 'tip_invalid', httpStatus: 400 };
  const lp = await (pricingP || loadPricing(db, rid));   // pricingP: the handler started the read in parallel with its first reads
  if (lp.failed) return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 };
  if (!lp.pricing) return t > 0 ? { refusal: 'tip_not_enabled', httpStatus: 409 } : null;
  let identity = null;
  try { identity = await getIdentity(db, rid); } catch (_) { return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 }; }
  const hub = identity && { lat: identity.hub_lat, lng: identity.hub_lng };
  const q = P.quoteDelivery({ pricing: lp.pricing, hub, mode, pin, customerUid });
  if (q.refusal) return { refusal: q.refusal, httpStatus: REFUSAL_STATUS[q.refusal] || 409 };
  if (t > 0 && q.ctx.mode === 'pickup') return { refusal: 'tip_pickup', httpStatus: 400 };
  return t > 0 ? { ctx: P.withTip(q.ctx, t) } : q;
}

/* The CHARGE path, against the STORED order (codex S3a P1-1 / P1-2). Only when activated: dark (dq null) reads nothing.
   One read of orders/{id}; absent → this request's dq (a fresh order). Present:
     · already paid → this request's dq (the acquire answers already_paid, as today)
     · a LIVE issued checkout (its active attempt 'created', unexpired) is GRANDFATHERED: priced at its STORED economics
       (storedCtx, or food-only when issued dark) so the acquire reuses it (§3.3); a FRESH issuance instead → re-quote
     · otherwise a different fulfilment or pin than the stored order's → refused order_context_changed: the client starts a
       fresh order; mixed contexts are never re-priced
   A refusal dq is answered by the handler BEFORE any pending order or hold exists. */
async function chargeContext(db, orderId, dq, body, now) {
  if (!dq) return dq;
  const order = (await db.ref(`orders/${orderId}`).get()).val();
  if (!order || order.payment_status === 'confirmed') return dq;   // fresh, or already paid (the acquire answers already_paid as today)
  let at = null;
  if (typeof order.active_attempt_id === 'string' && order.active_attempt_id) {
    at = (await db.ref(`payment_attempts/${order.active_attempt_id}`).get()).val();
    // LIVE now → GRANDFATHERED: priced at its STORED economics so the acquire can REUSE it. Whether it IS reused is decided
    // by the acquire, not by this clock read (codex S3a r2 P1): if the checkout expires before the acquire and a FRESH one
    // would be issued instead, the gate step refuses it (refusalGate → re-quote) — a fresh checkout is always priced now.
    if (at && at.hosted_state === 'created' && Number(at.hosted_expires_at) > now) { const c = P.storedCtx(order); return c ? { ctx: c, grandfathered: true } : { grandfathered: true }; }
  }
  const pin = orderPin(body);
  const same = order.order_type === (body && body.order_type)
    && (order.order_type !== 'delivery' || (Number(order.lat) === pin.lat && Number(order.lng) === pin.lng));
  if (same) return dq;
  // reward holds are NOT touched here (advisor ruling 2026-10-22, codex S3a r3: a release raced a concurrent reuse) — an interrupted reward order retried in another context keeps its punches reserved (no money lost; recoverable manually)
  return { refusal: 'order_context_changed', httpStatus: 409 };
}

// The order body's pin: lat/lng are the existing top-level fields; `pin_confirmed: true` is the new client's assertion.
const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
const orderPin = (body) => ({ lat: num(body && body.lat), lng: num(body && body.lng), confirmed: !!(body && body.pin_confirmed === true) });
// The quote body's pin: { pin: { lat, lng, confirmed } } (plan §10.2 fixture).
const quotePin = (body) => (body && body.pin && typeof body.pin === 'object' ? { lat: num(body.pin.lat), lng: num(body.pin.lng), confirmed: body.pin.confirmed === true } : null);

const ctxOf = (dq) => (dq && dq.ctx ? dq.ctx : null);

// The breakdown the order RECORDS and CHARGES: unchanged when dark/refused; else total + net envío and the envío facts.
// subtotal/tax stay the FOOD split (envío is pass-through to Sherpa, outside the restaurant's revenue and factura).
// S2: + the tip (once) on total_cents, and `tip_cents` on the record only when > 0 (subtotal/tax stay the FOOD split — the tip,
// like envío, is pass-through: never restaurant revenue, never on the factura).
function withDelivery(dq, breakdown) {
  const c = ctxOf(dq);
  if (!c) return breakdown;
  const tip = P.tipCentsOf(c);
  return {
    ...breakdown,
    total_cents: breakdown.total_cents + P.netDeliveryCents(c) + tip,
    delivery_cents: c.delivery_cents,
    promo_discount_cents: c.promo_discount_cents,
    delivery_snapshot: { mode: c.mode, policy_version: c.policy_version, ...(c.mode === 'delivery' ? { km: c.km, band: c.band, promo: c.promo || null } : {}) },
    ...(tip > 0 ? { tip_cents: tip } : {}),
  };
}
// The order's `total` (LEMPIRAS — what the driver app collects and the cash count sums): food + net envío when active, so
// `total` and `total_cents` stay one number. The reward earn base keeps the FOOD total (callers pass it unchanged there).
const totalLempiras = (dq, foodLempiras) => (ctxOf(dq) ? foodLempiras + (P.netDeliveryCents(ctxOf(dq)) + P.tipCentsOf(ctxOf(dq))) / 100 : foodLempiras);   // S2: + the tip
// S3c: the WhatsApp «Envío» argument from a breakdown / an order record (delivery_cents > 0 only — absent → nothing).
const waEnvio = (o) => ({ ...(o && Number.isSafeInteger(o.delivery_cents) && o.delivery_cents > 0 ? { envio: { cents: o.delivery_cents, promo_cents: Number.isSafeInteger(o.promo_discount_cents) ? o.promo_discount_cents : 0 } } : {}),
  ...(o && Number.isSafeInteger(o.tip_cents) && o.tip_cents > 0 ? { propina: { cents: o.tip_cents } } : {}) });   // S2: + the «Propina» line
// The fields the hosted path copies onto the pending order (the cash path spreads the whole breakdown).
const orderFields = (b) => (b && b.delivery_snapshot ? { delivery_cents: b.delivery_cents, promo_discount_cents: b.promo_discount_cents, delivery_snapshot: b.delivery_snapshot, ...(b.tip_cents > 0 ? { tip_cents: b.tip_cents } : {}) } : {});   // S2: + tip_cents (> 0 only)

// applyConfirmedNetGate's envío argument (it joins the gate's recompute, so the token is checked against food + envío).
const gateExtra = (dq) => (ctxOf(dq) ? { deliveryContext: ctxOf(dq) } : {});

// An ACTIVE refusal at the gate step: release the hold, answer with the typed refusal. null → run the real gate.
async function refusalGate(dq, releaseHold, orderId) {
  // a GRANDFATHERED request reaching the gate means the acquire is issuing a FRESH checkout (the live one expired since the
  // probe): never at the stored economics — refused, the client re-quotes and is priced now (codex S3a r2 P1)
  if (dq && dq.grandfathered) dq = { refusal: 'quote_invalid', httpStatus: 409, reason: 'checkout_expired' };
  if (!dq || !dq.refusal) return null;
  try { await releaseHold(); } catch (_) { /* best-effort, as the gate's own release */ }
  try { console.warn('delivery_refused', JSON.stringify({ orderId, refusal: dq.refusal })); } catch (_) {}
  return { refuse: { status: dq.httpStatus, body: { error: dq.refusal, ...(dq.reason ? { reason: dq.reason } : {}), ...(dq.httpStatus === 503 ? { retryable: true } : {}), order_id: orderId } }, provenance: null, result: null };
}

/* The QUOTE endpoints' envío: { refuse, httpStatus } when active and refused (a config outage → 503, codex S3a P2-6; a request
   refusal → a fail-soft 200 body), else { ctx, uid } (ctx null when
   dark). Dark costs ONE config read and nothing else — no identity read, no token verify, and uid stays what the caller
   had (quoteOrder: null), so a dark quote is byte-identical. Active: the hub from the restaurant identity, and for
   quoteOrder an OPTIONAL customer ID token (customer:true, not tombstoned) — the promo is account-only.
   `knownUid` (quoteRedemption already verified one) skips the second verify. */
/* S2 (§3.1/§3.5/§3.6): the tip is validated here for BOTH quote endpoints (they pass the raw body) — malformed → 400
   tip_invalid; a tip with a reward (`redeem`) → 409 tip_reward_unsupported; dark + tip → 409 tip_not_enabled; pickup + tip →
   400 tip_pickup. An APP quote (`entry_mode:'app'`) is refused beyond min(last band, identity.delivery_radius_km), so it never
   prices a pin the order's radius check refuses. Active quotes carry the public { from_cents, max_km } (quoteFields). */
async function quoteDeliveryFor(req, db, rid, body, { getIdentity, getAuth, attributionUid, knownUid, pricingP }) {
  const t = TIP.normTip(body && typeof body === 'object' ? body.tip_cents : undefined);
  if (Number.isNaN(t)) return { refuse: { ok: false, error: 'tip_invalid' }, httpStatus: 400 };
  if (t > 0 && body.redeem != null) return { refuse: { ok: false, error: 'tip_reward_unsupported' }, httpStatus: 409 };
  const lp = await (pricingP || loadPricing(db, rid));
  if (lp.failed) return { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 };
  if (!lp.pricing) return t > 0 ? { refuse: { ok: false, error: 'tip_not_enabled' }, httpStatus: 409 } : { ctx: null, uid: knownUid === undefined ? null : knownUid };
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
  const maxKm = coverageKm(lp.pricing, identity, body);
  const q = P.quoteDelivery({ pricing: lp.pricing, hub: identity && { lat: identity.hub_lat, lng: identity.hub_lng }, mode: body && body.mode, pin: quotePin(body), customerUid: uid, ...(isApp(body) ? { maxKm } : {}) });
  if (q.refusal) return { refuse: { ok: false, error: q.refusal }, httpStatus: REFUSAL_STATUS[q.refusal] === 503 ? 503 : 200 };   // a config outage is a 503; a request refusal stays a fail-soft 200 body
  if (t > 0 && q.ctx.mode === 'pickup') return { refuse: { ok: false, error: 'tip_pickup' }, httpStatus: 400 };
  const ctx = P.withTip(q.ctx, t);
  PUBLIC.set(ctx, { from_cents: lp.pricing.bands[0].cents, max_km: maxKm });
  return { ctx, uid };
}

// S2 §3.6: an APP request (the only entry_mode value besides 'direct' — never priced, charge-inputs.js NON_CHARGE_FIELDS).
const isApp = (body) => !!body && body.entry_mode === 'app';
// The coverage a quote reports and (for the app) enforces: the last band's max_km; for the app, also no further than the
// restaurant's own delivery radius (the identity read just above — no new read). A missing/invalid radius → the bands.
function coverageKm(pricing, identity, body) {
  const last = pricing.bands[pricing.bands.length - 1].max_km;
  const r = identity && identity.delivery_radius_km;
  return isApp(body) && typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.min(last, r) : last;
}
// The public delivery facts of an ACTIVE quote ctx (WeakMap: never a field on the money ctx, never signed or recorded).
const PUBLIC = new WeakMap();

// The quote endpoints: { refuse } (fail-soft 200 body) when active and refused; else the ctx (or null when dark).
function quoteOutcome(dq) {
  if (dq && dq.refusal) return { refuse: { ok: false, error: dq.refusal } };
  return { ctx: ctxOf(dq) };
}
// The additive quote response fields (absent when dark → byte-identical response).
const quoteFields = (ctx) => (ctx ? { delivery: { delivery_cents: ctx.delivery_cents, promo_discount_cents: ctx.promo_discount_cents, policy_version: ctx.policy_version, mode: ctx.mode, ...(PUBLIC.get(ctx) || {}) } } : {});   // S2 §3.6: + { from_cents, max_km }

module.exports = { loadPricing, deliveryFor, quoteDeliveryFor, chargeContext, orderPin, quotePin, withDelivery, totalLempiras, waEnvio, orderFields, gateExtra, refusalGate, quoteOutcome, quoteFields, ctxOf };
