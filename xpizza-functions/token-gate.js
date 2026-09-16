'use strict';
// ---------------------------------------------------------------------------
// Portal 1C Task 4 — THE CONFIRMED-NET GATE.
//
// The question this answers, at the moment money is about to move: "is the amount I am about to charge
// one this customer actually confirmed?" 1B proved the server never takes a price FROM the client; 1C
// adds the other half — the server does not charge MORE than the number it showed.
//
// 🔴 THE CHARGE IS ALWAYS THE SERVER'S NET. The token never supplies an amount; it supplies a CEILING
// and an identity. `chargeNet` is always the freshly recomputed server net — never a number read out
// of the token — so a forged or replayed token cannot lower a price, only fail to raise the ceiling.
// The worst a token can do is stop an order.
//
// ASYMMETRIC BY DESIGN, and the asymmetry is the point:
//   server net ≤ confirmed  → CHARGE, silently. A price that DROPPED between quote and charge is not a
//       surprise worth interrupting a checkout for; the customer pays less than they agreed.
//   server net >  confirmed → REFUSE. They agreed to one number and would be billed a larger one. This
//       is the only visible friction 1C introduces, and it exists precisely so that it is visible.
//
// Shared by T4 (cash), T5 (card) and T6 (enforcement), so there is ONE decision procedure rather than
// three that agree until one is edited.
// ---------------------------------------------------------------------------
const { computeServerNet } = require('./compute-server-net');
const { verifyQuoteToken, cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');

function gateConfirmedNet({ token, submittedCart, reward = null, deliveryContext = null, rid, tables = null, secret, enforce = false, nowMs = Date.now() }) {
  // ── NO TOKEN ────────────────────────────────────────────────────────────────────────────────
  /* Grace is the ENTIRE deployment story for this slice. Clients that have not shipped the token yet —
     and every in-flight checkout at the moment of deploy — must behave exactly as they do today, which
     means charging the server-repriced amount with no gate at all. `chargeNet: null` says "the caller
     keeps what it already computed": the gate declines to have an opinion rather than substituting a
     number, so a grace order is byte-identical to today by construction rather than by carefulness. */
  if (!token) {
    return enforce
      ? { action: 'refuse_no_token', chargeNet: null, reason: 'no_token', quoteId: null }
      : { action: 'charge', chargeNet: null, reason: 'grace_no_token', quoteId: null };
  }

  const v = verifyQuoteToken(token, secret, nowMs);
  if (!v.ok) {
    /* 🔴 A BAD SIGNATURE IS REFUSED EVEN UNDER GRACE, and expiry is not. The asymmetry is deliberate:
       a signature that does not verify is the only outcome here that indicates TAMPERING — someone
       sent a token that was not issued by this server — and honouring the order anyway would mean the
       one signal of an attack is the one we ignore during the grace window.
       An EXPIRED or unclocked token is ordinary: a customer left checkout open, or a clock is wrong.
       Under grace that must not block an order that would succeed today, so it falls through to the
       same path a token-less request takes. Under enforcement it refuses, and the client re-quotes. */
    if (v.reason === 'bad_signature' || v.reason === 'bad_format') {
      return { action: 'refuse_invalid', chargeNet: null, reason: v.reason, quoteId: null };
    }
    if (enforce) return { action: 'refuse_invalid', chargeNet: null, reason: v.reason, quoteId: null };
    return { action: 'charge', chargeNet: null, reason: `grace_${v.reason}`, quoteId: null };
  }

  const payload = v.payload;

  // The server's own number, recomputed now from the cart actually submitted. This is what will be
  // charged in every accepting branch below.
  const net = computeServerNet({ items: submittedCart, reward, deliveryContext, rid, tables });
  if (net.error) {
    return { action: 'refuse_invalid', chargeNet: null, reason: 'bad_cart', quoteId: payload.quote_id || null };
  }

  /* 🔴 THE CART MUST BE THE CART THAT WAS QUOTED — through the SAME normalization the issuer used.
     Without this, a token for a cheap cart would authorise an expensive one whose net happened to land
     at or under the ceiling. And it is the ONLY check that can see a swap the amount cannot: Task 1
     measured that a la_musa reward is net-invariant, and two same-priced x_pizza dishes are
     net-identical, so the fingerprint is the sole witness in both cases. */
  const norm = normalizeCartForFingerprint(submittedCart, rid);
  if (!norm) {
    return { action: 'refuse_invalid', chargeNet: null, reason: 'unfingerprintable_cart', quoteId: payload.quote_id || null };
  }
  if (cartFingerprint(norm, reward) !== payload.cart_fingerprint) {
    return { action: 'refuse_invalid', chargeNet: null, reason: 'cart_mismatch', quoteId: payload.quote_id || null };
  }

  // The restaurant is part of what was confirmed: a token issued for one brand must not authorise a
  // charge on the other, whatever the amounts happen to be.
  if (payload.rid !== rid) {
    return { action: 'refuse_invalid', chargeNet: null, reason: 'rid_mismatch', quoteId: payload.quote_id || null };
  }

  const confirmed = Number(payload.net_total_cents);
  if (!Number.isSafeInteger(confirmed)) {
    return { action: 'refuse_invalid', chargeNet: null, reason: 'bad_confirmed_net', quoteId: payload.quote_id || null };
  }

  if (net.net_total_cents > confirmed) {
    return { action: 'refuse_increase', chargeNet: net.net_total_cents, reason: 'price_increased', quoteId: payload.quote_id || null };
  }
  return { action: 'charge', chargeNet: net.net_total_cents, reason: 'confirmed', quoteId: payload.quote_id || null };
}

module.exports = { gateConfirmedNet };
