'use strict';
// LEDGER S1 (PLAN-5f-ledger-shadow-s1-r3 §1, APPROVED 11-16) — the FROZEN allocation snapshot. The shadow ledger never reads money
// from orders/{id} (dispatchers can write it: database.rules.json orders/$order_id .write); it reads this private, create-once copy,
// which RIDES a write that already happens (no new await, read or round trip):
//   cash ASAP / held   → ledger_alloc/{orderId}, a path in the order's own multi-path update (index.js) — so the stored snapshot and the
//                         stored order always come from the same request (concurrent creates = the known, demoted cash create-once item)
//   hosted card        → `ledger` inside the exclusive payment_attempts/{aid} claim (pixelpay-hosted-charge.js)
//   SDK card           → `ledger` inside the payment_sdk/{orderId} record create (payments/sdk/coordinator.js)
// PURE and NON-THROWING: every value is normalized (required money → a safe integer or 0; optional → a safe integer or null; strings
// bounded and key-safe or null), the result is validated, and any throw yields the fixed valid FALLBACK (⇒ the ledger quarantines it),
// so an order write can never fail because of the snapshot. MODE is the server's own pricing decision — never called a channel:
//   'sdk' (placeSdkOrder forces the app marker server-side: trusted) | 'app' (entry_mode:'app' priced) | 'direct' (forms pricing).
// The client headers are kept only as EVIDENCE; a contradiction between them and the mode marks `mismatch` (only a hand-made request
// produces one) and the ledger quarantines the order.
const FALLBACK = Object.freeze({ v: 1, mode: 'unknown' });
const KEY_SAFE = /^[A-Za-z0-9._:-]{1,64}$/;
const APP_DEPLOYMENT = 'orders-app';

const keySafe = (x) => (typeof x === 'string' && KEY_SAFE.test(x) ? x : null);
const text = (x, max) => (typeof x === 'string' && x.length <= max ? x : null);
const req = (x) => (Number.isSafeInteger(x) ? x : 0);
const opt = (x) => (Number.isSafeInteger(x) ? x : null);

function modeOf({ sdk = false, body, clientHdr } = {}) {
  const h = clientHdr && typeof clientHdr === 'object' ? clientHdr : {};
  const evidence = { client_app: keySafe(h.app), client_deployment: keySafe(h.deployment) };
  if (sdk) return { mode: 'sdk', mismatch: false, evidence };
  const mode = require('../delivery/delivery-wire').isApp(body) ? 'app' : 'direct';
  const dep = evidence.client_deployment;
  const mismatch = mode === 'app' ? (dep !== null && dep !== APP_DEPLOYMENT) : dep === APP_DEPLOYMENT;
  return { mode, mismatch, evidence };
}

// the frozen offer — exactly marketing/offer-price.js frozenOf's keys (+ the audience keys when present), nothing else
function offerOf(o) {
  if (!o || typeof o !== 'object') return null;
  const out = { offer_id: keySafe(o.offer_id), rev: req(o.rev), type: keySafe(o.type), name: text(o.name, 80),
    discount_cents: req(o.discount_cents), waived_envio_cents: req(o.waived_envio_cents), funded_by: keySafe(o.funded_by) };
  if (o.audience !== undefined) out.audience = keySafe(o.audience);
  if (o.audience_kind !== undefined) out.audience_kind = keySafe(o.audience_kind);
  return out;
}

function validate(v, at = 'snapshot') {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`ledger snapshot: ${at} is not finite`); return; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`ledger snapshot: ${at} is ${Array.isArray(v) ? 'an array' : typeof v}`);
  for (const [k, x] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error(`ledger snapshot: bad key ${at}.${k}`);
    validate(x, `${at}.${k}`);
  }
}

// record = the order record this request is writing (or the pending order record a card checkout charges); m = modeOf(...)
function snapshotOf(record, m) {
  try {
    if (!record || typeof record !== 'object' || !m || typeof m !== 'object') return FALLBACK;
    const snap = {
      v: 1, mode: m.mode === 'sdk' || m.mode === 'app' || m.mode === 'direct' ? m.mode : 'unknown', mismatch: m.mismatch === true,
      evidence: { client_app: keySafe(m.evidence && m.evidence.client_app), client_deployment: keySafe(m.evidence && m.evidence.client_deployment) },
      rid: keySafe(record.restaurant_id), created_at: req(record.created_at), payment_method: keySafe(record.payment_method),
      order_type: keySafe(record.order_type), total_cents: req(record.total_cents),
      food: { subtotal_cents: req(record.subtotal_cents), tax_cents: req(record.tax_cents), desc_rebaja_cents: opt(record.desc_rebaja_cents) },
      envio: { delivery_cents: opt(record.delivery_cents), promo_discount_cents: opt(record.promo_discount_cents), delivery_discount_funder: keySafe(record.delivery_discount_funder) },
      tip_cents: opt(record.tip_cents),
      offer: offerOf(record.offer),
      reward_discount_cents: record.redemption && typeof record.redemption === 'object' ? opt(record.redemption.discount_cents) : null,
    };
    validate(snap);
    return snap;
  } catch (_) {
    return FALLBACK;
  }
}

const allocPath = (orderId) => `ledger_alloc/${orderId}`;

module.exports = { modeOf, snapshotOf, validate, allocPath, FALLBACK };
