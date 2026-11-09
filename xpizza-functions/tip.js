'use strict';
// S2-srv-tip — THE TIP, PURE (PLAN-capp-S2-r4 §3.1/§3.2/§3.5).
//
// An optional body field `tip_cents` on the quote, cash-order and card-charge endpoints. The tip goes to the driver: it
// joins the charged total exactly once (it rides the SERVER's envío context, delivery/delivery-pricing.js withTip) and
// is excluded from the restaurant's factura and revenue (pass-through, like envío).
//
// NORMALIZATION — the only reader of the raw field:
//   absent / undefined / the number 0  → 0, the NO-TIP case: every body, payload, record and fingerprint is
//                                         byte-identical to before S2
//   a safe integer in 1..TIP_MAX_CENTS  → that integer
//   anything else (a string such as "0", null, a negative, a fraction, over the max) → NaN, which the handlers refuse
//                                         as 400 tip_invalid before anything else happens

const TIP_MAX_CENTS = 200000;   // L 2,000 — OWNER-RULED 2026-10-25 (Q7)

function normTip(v) {
  if (v === undefined || v === 0) return 0;
  return Number.isSafeInteger(v) && v >= 1 && v <= TIP_MAX_CENTS ? v : NaN;
}
const ofBody = (body) => normTip(body && typeof body === 'object' ? body.tip_cents : undefined);

// PLAN-capp-tip-step r6 D0: the payment method exactly as intake will see it — index.js validateOrderPayload's
// sanitizeText(v, 30) then its ALLOWED_PAYMENT_METHODS (s2tip.test.js reads both from index.js: parity, never a drifting copy).
// An omitted / empty / unknown method becomes '' at intake, so a POSITIVE tip on it would be neither kept by the driver's
// cuadre (cash) nor accrued by the ledger (card methods): it is refused before any WRITE, in the same seam (and with the same
// precedence) as tip_invalid / tip_reward_unsupported — after the handler's floor / registry / pricing reads (a below-floor client
// still gets its 426 first; Codex slice-C r1, advisor ruling: the seam is not moved).
const PAYMENT_METHODS = ['cash', 'card_delivery', 'online'];
function paymentMethodOf(v) {
  let s = (v == null ? '' : String(v));
  s = s.replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (s.length > 30) s = s.slice(0, 30);
  return PAYMENT_METHODS.includes(s) ? s : '';
}

// The order paths' early refusal, BEFORE any classification, reserve or write: a malformed tip, or a tip on a reward
// order (tip + reward is not supported in S2, §3.5 — so a reward reservation can never carry a tip). null → proceed.
function orderRefusal(body) {
  const t = ofBody(body);
  if (Number.isNaN(t)) return { status: 400, error: 'tip_invalid' };
  if (t > 0 && body.redeem != null) return { status: 409, error: 'tip_reward_unsupported' };
  if (t > 0 && !paymentMethodOf(body.payment_method)) return { status: 400, error: 'tip_payment_method_invalid' };   // D0
  return null;
}

// The order handlers' one-line seam: answers the refusal on `res` and returns true, or returns false (proceed). Kept here so
// the handlers' index.js hunks read no response status themselves (the R3 census numbers those sites).
function refuse(res, body) {
  const r = orderRefusal(body);
  if (!r) return false;
  res.status(r.status).json({ error: r.error });
  return true;
}

// The fingerprint component: appended to the extras list every orderFingerprint call already filters with
// `.filter(Boolean).join('|')`, so no tip → '' → filtered → byte-identical (§3.2).
const tipExtra = (n) => (n > 0 ? `tp:${n}` : '');
const extraOf = (body) => tipExtra(ofBody(body));

// The direct stored-tip compare, independent of any fingerprint (a null cash recompute and a record with no
// payment_fingerprint both skip the fingerprint compare). No tip vs no tip never conflicts.
function tipBindingConflict(record, incomingTip) {
  if (!record) return null;
  return normTip(record.tip_cents) !== normTip(incomingTip) ? { reason: 'tip' } : null;
}

module.exports = { TIP_MAX_CENTS, PAYMENT_METHODS, paymentMethodOf, normTip, ofBody, orderRefusal, refuse, tipExtra, extraOf, tipBindingConflict };
