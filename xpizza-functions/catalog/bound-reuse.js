'use strict';
// ---------------------------------------------------------------------------
// 1D add-product B (codex PB-1 r1 P1-3; plan §0d.1; advisor conditions 2026-10-10) — THE BOUND-REUSE PROBE.
//
// A reward order's live checkout is resumed from its BOUND snapshot, not re-prepared against today's catalog: a whole-dish
// 86, a reward re-price or an eligibility change after issuance must not turn a customer's in-flight payment into a 409 or
// a "conflict". So, BEFORE prepareRedemption, the card path asks this probe; it answers ONLY when every condition holds:
//   • the request carries a reward and its CHARGE-INPUT fingerprint (catalog/charge-inputs.js — every client-supplied
//     charge input, one canonicalizer) EQUALS the one bound on the order at issuance (orders/{id}.charge_inputs_fp);
//   • the order belongs to this request's VERIFIED customer (customer_uid, decided before this probe runs), is this
//     restaurant's, and is a legacy-format binding (a canonical-format order takes the current path);
//   • the EXISTING classifier, run with the order's own bound payment fingerprint, says `reuse` (a live URL — the same
//     states and the same expiry rule the classifier always used);
//   • the reward hold is still held by THIS order (state 'reserved', bound to the order's payment fingerprint and reward
//     canonical, attached to the live attempt or not yet attached).
// Then it returns the same `acq` acquireHostedAttempt returns for a live reuse, and the caller answers exactly as today's
// reuse does (hosted-charge-flow resolveHostedAttemptAction). Anything else — including ANY error — returns null and the
// request takes the CURRENT path (prepare → classify → reserve → acquire), so a fresh issuance or a rotation always meets
// current enforcement. READ-ONLY: this module performs no write (a placement guard pins it).
// ---------------------------------------------------------------------------
const { chargeInputsFingerprint } = require('./charge-inputs');
const { classifyHostedAttempt } = require('../pixelpay-hosted-charge');
const { canonicalJson } = require('./canonical-json');
const TV = require('./text-version');   // PLAN-A A8a (codex A-1 build r1 P1-1): the probe is provenance-aware

async function probeBoundReuse(db, { orderId, uid, rid, body, now }) {
  try {
    if (!db || !orderId || !uid || !rid || !body || body.redeem == null) return null;
    const inputsFp = chargeInputsFingerprint(body);
    if (!inputsFp) return null;
    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!order || typeof order !== 'object') return null;
    if (order.restaurant_id !== rid || order.customer_uid !== uid) return null;
    if (order.charge_inputs_fp !== inputsFp) return null;
    if (!order.redemption || typeof order.payment_fingerprint !== 'string' || !order.payment_fingerprint || !order.active_attempt_id) return null;
    // PLAN-A A8a: the order's OWN bound fingerprint is the candidate in its OWN text version — a live 'a8' checkout reuses like a
    // legacy one; a malformed order marker never reuses (the classifier would refuse it too)
    const ov = TV.textVersionOf(order, TV.ORDER_FIELD);
    if (!ov.ok) return null;
    const cls = await classifyHostedAttempt(db, orderId, order.payment_fingerprint, now, null, () => order.payment_fingerprint);
    if (!cls || cls.outcome !== 'reuse' || cls.bindingFormat) return null;   // a canonical-format binding (or a malformed tag) never reuses here
    const att = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();
    if (!att || att.hosted_state !== 'created' || !(Number(att.hosted_expires_at) > now) || !att.hosted_checkout_url) return null;
    const hold = (await db.ref(`user_rewards/${uid}/${rid}/reservations/${orderId}`).once('value')).val();
    // the hold is THIS order's: reserved, bound to the order's payment fingerprint AND its reward canonical (rewards-reserve
    // writeReserve: order_fingerprint + canonical); attached to the live attempt, or not yet attached (attach is best-effort)
    if (!hold || hold.state !== 'reserved' || hold.fp_format !== undefined) return null;
    // PLAN-A A8a: the hold's text version is valid AND the order's (a malformed marker such as "bogus" → binding_format_invalid → never reuse)
    const hv = TV.textVersionOf(hold, TV.RESERVATION_FIELD);
    if (!hv.ok || hv.version !== ov.version) return null;
    if (hold.order_fingerprint !== order.payment_fingerprint || canonicalJson(hold.canonical === undefined ? null : hold.canonical) !== canonicalJson(order.redemption)) return null;
    if (hold.attempt_id != null && hold.attempt_id !== order.active_attempt_id) return null;
    return { outcome: 'reuse', attempt_id: order.active_attempt_id, checkout_url: att.hosted_checkout_url, poll_token: att.poll_token };
  } catch (_) {
    return null;
  }
}

module.exports = { probeBoundReuse };
