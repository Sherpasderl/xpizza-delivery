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

function gateConfirmedNet({ token, expectedNetCents = null, submittedCart, reward = null, deliveryContext = null, rid, tables = null, secret, enforce = false, nowMs = Date.now() }) {
  // ── NO TOKEN ────────────────────────────────────────────────────────────────────────────────
  if (!token) {
    /* 🔴 THE DEGRADED FLOOR. A client that cannot produce a signed token can still say what number it
       showed the customer. That is worth strictly more than nothing and strictly less than a token,
       and the accept rule makes the difference precise:

         THE CHARGE IS ALWAYS THE SERVER'S OWN RECOMPUTE. expected_net_cents is only ever a CEILING.

       So a forged-low expected cannot undercharge — the server net exceeds it and the order 409s —
       and a forged-high one cannot overcharge, because the server net is what is charged and it is
       lower. The client's number never becomes money in either direction; it can only refuse a sale.
       WHAT IS ACTUALLY LOST versus a signed token is the cart fingerprint: nothing here attests that
       this cart is the cart that was quoted, so a same-price swap is invisible and there is no
       issuer-side provenance. That is money-neutral — the server reprices whatever was submitted —
       but it is not nothing, so the result is MARKED degraded and settlement can tell the two apart.
       Deliberately NOT a silent fallback for a signed token: this branch is reached only when no token
       was sent at all. A token that fails its signature still refuses, degraded floor or not. */
    /* typeof number, NOT Number(x). Coercion accepts things a client never meant as a price and that
       a careless one can send by accident: '100' (a string from a form field), true (→ 1), [] (→ 0).
       Each of those would become a CEILING of one lempira or zero and refuse a legitimate order. The
       strict type is also the money-safe direction — the worst case is falling to the no-token row,
       which under grace is exactly today's behaviour. */
    const expected = expectedNetCents;
    const haveExpected = typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 0;

    if (haveExpected) {
      const net = computeServerNet({ items: submittedCart, reward, deliveryContext, rid, tables });
      if (net.error) {
        return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: 'bad_cart', quoteId: null, degraded: true };
      }
      if (net.net_total_cents > expected) {
        return { action: 'refuse_increase', chargeNet: net.net_total_cents, confirmedNet: expected, reason: 'price_increased_unsigned', quoteId: null, degraded: true };
      }
      return { action: 'charge', chargeNet: net.net_total_cents, confirmedNet: expected, reason: 'confirmed_unsigned', quoteId: null, degraded: true };
    }

    /* Junk falls through to here ON PURPOSE rather than refusing: a non-integer, negative, or absent
       expected is indistinguishable from a client that never sent one, and inventing a third outcome
       for it would make a malformed field MORE consequential than a missing one. */
    /* Grace is the ENTIRE deployment story for this slice. Clients that have not shipped the token yet —
       and every in-flight checkout at the moment of deploy — must behave exactly as they do today, which
       means charging the server-repriced amount with no gate at all. `chargeNet: null` says "the caller
       keeps what it already computed": the gate declines to have an opinion rather than substituting a
       number, so a grace order is byte-identical to today by construction rather than by carefulness. */
    return enforce
      ? { action: 'refuse_no_token', chargeNet: null, confirmedNet: null, reason: 'no_token', quoteId: null, degraded: false }
      : { action: 'charge', chargeNet: null, confirmedNet: null, reason: 'grace_no_token', quoteId: null, degraded: false };
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
      return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: v.reason, quoteId: null, degraded: false };
    }
    if (enforce) return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: v.reason, quoteId: null, degraded: false };
    return { action: 'charge', chargeNet: null, confirmedNet: null, reason: `grace_${v.reason}`, quoteId: null, degraded: false };
  }

  const payload = v.payload;

  // The server's own number, recomputed now from the cart actually submitted. This is what will be
  // charged in every accepting branch below.
  const net = computeServerNet({ items: submittedCart, reward, deliveryContext, rid, tables });
  if (net.error) {
    return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: 'bad_cart', quoteId: payload.quote_id || null, degraded: false };
  }

  /* 🔴 THE CART MUST BE THE CART THAT WAS QUOTED — through the SAME normalization the issuer used.
     Without this, a token for a cheap cart would authorise an expensive one whose net happened to land
     at or under the ceiling. And it is the ONLY check that can see a swap the amount cannot: Task 1
     measured that a la_musa reward is net-invariant, and two same-priced x_pizza dishes are
     net-identical, so the fingerprint is the sole witness in both cases. */
  const norm = normalizeCartForFingerprint(submittedCart, rid);
  if (!norm) {
    return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: 'unfingerprintable_cart', quoteId: payload.quote_id || null, degraded: false };
  }
  if (cartFingerprint(norm, reward) !== payload.cart_fingerprint) {
    return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: 'cart_mismatch', quoteId: payload.quote_id || null, degraded: false };
  }

  // The restaurant is part of what was confirmed: a token issued for one brand must not authorise a
  // charge on the other, whatever the amounts happen to be.
  if (payload.rid !== rid) {
    return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: 'rid_mismatch', quoteId: payload.quote_id || null, degraded: false };
  }

  const confirmed = Number(payload.net_total_cents);
  if (!Number.isSafeInteger(confirmed)) {
    return { action: 'refuse_invalid', chargeNet: null, confirmedNet: null, reason: 'bad_confirmed_net', quoteId: payload.quote_id || null, degraded: false };
  }

  /* 🔴 THE CEILING IS RETURNED ALONGSIDE THE CHARGE, and they are not the same fact. On a price DROP
     the gate charges the lower number — correctly — but what the customer ACCEPTED is still the higher
     one. Recording the charged amount as "confirmed" would erase the only thing the signed token was
     built to establish: that the server offered X and the customer accepted X. For a settlement
     dispute or a chargeback, "we charged 249" is not the claim that matters; "they confirmed 299 and
     we charged them less" is. Two numbers, because there are two facts. */
  if (net.net_total_cents > confirmed) {
    return { action: 'refuse_increase', chargeNet: net.net_total_cents, confirmedNet: confirmed, reason: 'price_increased', quoteId: payload.quote_id || null, degraded: false };
  }
  return { action: 'charge', chargeNet: net.net_total_cents, confirmedNet: confirmed, reason: 'confirmed', quoteId: payload.quote_id || null, degraded: false };
}

/* ── APPLYING THE GATE: THE DECISION *AND ITS CONSEQUENCES* ─────────────────────────────────────
 * 🔴 EXTRACTED BECAUSE INLINE MEANT UNTESTED. The decision (gateConfirmedNet) was unit-tested from the
 * first commit; the CONSEQUENCES — release the reward hold on every refusal, refuse when the gated net
 * and the recorded net disagree, stamp the provenance — lived inline in a 450-line request handler
 * where no unit test could reach them. Deleting the hold-release or defeating the divergence check
 * made no test fail. Both were correct and asserted by nothing, which on a live money endpoint is one
 * refactor away from silently gone.
 *
 * So the consequences move here, behind injected effects: `releaseHold` is a function, and whether it
 * was called is the assertion. The handler keeps five lines it cannot get wrong.
 *
 * 🔴 THE HOLD IS RELEASED ON EVERY REFUSAL AND ONLY ON REFUSALS. An order that never exists must not
 * strand a customer's loyalty points; an order that IS created must keep the hold, because completion
 * is what consumes it. Those are opposite mistakes and both are tested.
 */
async function applyConfirmedNetGate({ gateInput, recordedTotalCents, releaseHold, orderId, log = console }) {
  const result = gateConfirmedNet(gateInput);
  const refuse = async (status, body, event, detail) => {
    await releaseHold();
    try { log.warn(event, JSON.stringify({ orderId, ...detail })); } catch (_) {}
    return { refuse: { status, body: { ...body, order_id: orderId } }, provenance: null, result };
  };

  if (result.action === 'refuse_increase') {
    return refuse(409, { error: 'price_increased', net_total_cents: result.chargeNet },
      'quote_gate_price_increased', { rid: gateInput.rid, quote_id: result.quoteId, net_total_cents: result.chargeNet, confirmation: result.degraded ? 'unsigned' : 'signed' });
  }
  if (result.action === 'refuse_no_token') {
    return refuse(409, { error: 'quote_required' }, 'quote_gate_refused', { rid: gateInput.rid, action: result.action, reason: result.reason });
  }
  if (result.action === 'refuse_invalid') {
    return refuse(409, { error: 'quote_invalid' }, 'quote_gate_refused', { rid: gateInput.rid, action: result.action, reason: result.reason });
  }

  // GRACE: the gate declined to have an opinion, so nothing changes and nothing is stamped — which is
  // how a grace order is told from a gated one afterwards.
  if (result.chargeNet === null) {
    try { log.log('quote_gate_confirmed', JSON.stringify({ orderId, rid: gateInput.rid, confirmation: 'none', reason: result.reason })); } catch (_) {}
    return { refuse: null, provenance: null, result };
  }

  /* 🔴 APPROVED == RECORDED. recordedTotalCents is what the order stores, the driver collects and the
     factura shows. If the number the gate approved is not that number, the safe answer is to refuse —
     recording an amount the gate never approved is exactly the divergence this whole slice exists to
     make impossible, and discovering it later means discovering it in a settlement. */
  if (result.chargeNet !== recordedTotalCents) {
    await releaseHold();
    try { log.error('quote_gate_net_divergence', JSON.stringify({ orderId, rid: gateInput.rid, gated: result.chargeNet, recorded: recordedTotalCents })); } catch (_) {}
    return { refuse: { status: 409, body: { error: 'quote_invalid', order_id: orderId } }, provenance: null, result };
  }

  /* The rollout's own instrument: the flip from grace to enforce is safe only once no-token
     confirmations have fallen to ~0, and that is a thing to MEASURE, not to assume from a deploy date.
     Typed so signed / unsigned / grace are countable separately. */
  try { log.log('quote_gate_confirmed', JSON.stringify({ orderId, rid: gateInput.rid, confirmation: result.degraded ? 'unsigned' : 'signed', reason: result.reason, quote_id: result.quoteId })); } catch (_) {}

  return {
    refuse: null,
    /* `confirmation` is stamped on every accepted order, never omitted. A signed confirmation is an
       issuer-side proof that this server offered this exact cart at this exact number; an unsigned one
       is the client's word for what it displayed, checked only as a ceiling. Both are safe to charge
       against — the amount is the server's recompute either way — but they are not the same evidence,
       and a settlement or chargeback needs to know which it is holding. An absent field would make
       "unsigned" and "stamped before this shipped" the same value, so it is always present. */
    provenance: {
      quote_id: result.quoteId,
      confirmed_net_cents: result.confirmedNet,
      charged_net_cents: result.chargeNet,
      confirmation: result.degraded ? 'unsigned' : 'signed',
    },
    result,
  };
}

/* ── THE ENFORCE FLAG ────────────────────────────────────────────────────────────────────────────
   Mirrors redemptionEnabled (rewards-redeem-config.js): a top-level config read, try/catch, one
   default. The DIRECTION of the default is the whole point and it is the opposite of redemption's.
   redemptionEnabled fails safe to FALSE because a flag-read outage must not hand out rewards nobody
   authorised. Here FALSE means GRACE — charge exactly as today — so the same fail-safe-false shape
   also happens to be the non-breaking direction: an RTDB blip degrades the gate to the behaviour that
   shipped before it existed, rather than starting to 409 every order in both restaurants.
   Read ONCE per request and passed down; a flag that could change between the cash and card gate
   within one request would be a way to get two different answers about the same order. */
async function tokenEnforceEnabled(db) {
  try {
    return (await db.ref('config/token_enforce').get()).val() === true;
  } catch (e) {
    console.warn('tokenEnforceEnabled: read failed — fail-safe GRACE', e && e.message);
    return false;                        // fail-safe to grace on ANY read error
  }
}

module.exports = { gateConfirmedNet, applyConfirmedNetGate, tokenEnforceEnabled };

