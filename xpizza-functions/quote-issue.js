'use strict';
// ---------------------------------------------------------------------------
// Portal 1C Task 3 — ISSUING THE SIGNED QUOTE.
//
// 🔴 ONE ISSUER, TWO ENDPOINTS. quoteOrder (no reward) and quoteRedemptionCore (reward-active) both
// hand a customer a number to confirm, and Tasks 4/5 will recompute that number at the charge. If the
// two endpoints assembled their own payloads, the two would agree right up until one of them was
// edited — which is the entire failure mode 1C exists to remove, reintroduced one layer up. So the
// net, the fingerprint, the payload and the signature are assembled HERE, once, and each endpoint
// contributes only what it alone knows: its cart, its reward, its customer.
//
// FAIL-SOFT BY CONSTRUCTION. A quote is a display. Every failure below returns the PRICE without a
// token rather than an error: an unfingerprintable cart, an absent secret, a signing failure. The
// client then falls back to the unsigned floor (Task 6) and checkout is never blocked by the thing
// that was supposed to make checkout safer. The money is not at risk either way — the server reprices
// at the charge regardless of what any token says.
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const { computeServerNet } = require('./compute-server-net');
const { cartFingerprint, normalizeCartForFingerprint, signQuoteToken } = require('./quote-token');

/* Generous on purpose. The expiry is not a money control — the server reprices at the charge, so an
   old token buys an attacker nothing — it is a bound on how long a quote is worth honouring. Fifteen
   minutes is longer than any checkout and short enough that a token is not a durable artefact; the
   customer must never meet it, which is the hard rule this number is chosen against. */
const EXPIRY_MS = 15 * 60 * 1000;

/* 🔴 A STRINGIFY THAT CANNOT ITSELF THROW — and this is not hypothetical pedantry: it was a hole in
   the "the issuer never throws" guarantee, inside the very catch that exists to uphold it. `String(e)`
   raises TypeError on a value with no prototype (`Object.create(null)` has no toString), so a thrown
   object of that shape turned a handled failure into an unhandled one — the catch block became the
   thing that crashed the quote.
   Used at EVERY catch-path log in this module rather than only where it was found: the next catch
   someone adds here will reach for the same coercion, and a fix applied to one site is a fix that has
   to be remembered at the others. */
function describeError(e) {
  try {
    /* 🔴 READ ONCE. Reading `e.message` three times — to test it, to truthiness-check it, to slice it —
       let a GETTER return a different type on each read: a string on the first, an object with a
       `slice` returning a BigInt on a later one, and describeError returned that BigInt. The throw then
       landed at the CALL SITE, in JSON.stringify, outside this helper's guard entirely.
       With one read into a local, this function provably always returns a string: the message branch
       slices a value already proven to be a primitive string, String(e) is inside the try, and the
       fallback is a constant. That is what makes this the LAST fix of the class rather than one more
       instance of it — there is no remaining path by which a thrown value can make the logging throw. */
    const m = e && e.message;
    if (typeof m === 'string' && m) return m.slice(0, 200);
    return String(e).slice(0, 200);
  } catch (_) {
    return 'unstringifiable';
  }
}

let warnedNoSecret = false;
function quoteSecret() {
  const s = process.env.QUOTE_TOKEN_SECRET;
  if (!s) {
    // Once per process: a missing secret is a deploy-config fact, not a per-request event, and logging
    // it per request would bury the quotes that actually failed.
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn('quote_token_secret_missing', JSON.stringify({ effect: 'quotes issue without a token; the client falls back to the unsigned floor' }));
    }
    return null;
  }
  return s;
}

/* reward: the RESOLVED redemption (what applyRedemptionToPricing consumes), or null.
 * redemptionRef: the caller's stable reference to that same resolved reward — for the redemption path
 *   this is prepareRedemption's redemptionFp, which is derived from the canonical the CHARGE path also
 *   builds. Passed in rather than recomputed here: reconstructing the reward's identity independently
 *   would be a second source of the one fact Task 1 showed the net cannot carry.
 */
function issueQuote(args) {
  /* 🔴 THE ISSUER ITSELF NEVER THROWS. Guarding the normalization was not enough: the first thing this
     function does is PRICE the cart, and computeServerTotal reads `it.qty` directly — a throwing
     property accessor escapes from there, before any of this module's own guards are reached. Both
     callers are request handlers, so an exception is a 500 on a quote; a quote is a display and must
     degrade to a typed refusal instead. (A cart that throws on being read cannot be priced at all, so
     "return the price anyway" is not available here — what is available is not crashing.) */
  try { return issueQuoteInner(args); }
  catch (e) {
    console.warn('quote_issue_failed', JSON.stringify({ error: describeError(e) }));
    return { ok: false, error: 'error' };
  }
}

function issueQuoteInner({ items, reward = null, redemptionRef = null, rid, tables = null, customerId = null, nowMs = Date.now() }) {
  const net = computeServerNet({ items, reward, rid, tables });
  if (net.error) return { ok: false, error: net.error };

  const result = { ok: true, net_total_cents: net.net_total_cents, components: net.components, quote_token: null };

  // 🔴 THE FINGERPRINT BINDS THE REWARD — Task 1 proved the net cannot. A la_musa reward is
  // net-invariant, so a token whose fingerprint ignored the reward would verify for the cart WITHOUT
  // it. The reward's identity comes from the resolved object, the same one the charge path resolves.
  const secret = quoteSecret();
  if (!secret) return result;                    // unprovisioned → price without a token

  try {
    // Inside the try: normalization promises not to throw, and this is the belt for that braces — a
    // residual throw here must still return the PRICE without a token, never a 500 on a quote.
    const norm = normalizeCartForFingerprint(items, rid);
    if (!norm) return result;                    // unfingerprintable → price without a token
    const payload = {
      rid,
      customer_id: customerId || null,           // guests quote too; null is a value, not a gap
      cart_fingerprint: cartFingerprint(norm, reward),
      net_total_cents: net.net_total_cents,
      components: net.components,
      redemption_ref: redemptionRef || null,
      issued_at: nowMs,
      expires_at: nowMs + EXPIRY_MS,
      quote_id: crypto.randomUUID(),             // a nonce, so two identical quotes are still two quotes
    };
    result.quote_token = signQuoteToken(payload, secret);
  } catch (e) {
    console.warn('quote_token_sign_failed', JSON.stringify({ error: describeError(e) }));
  }
  return result;
}

module.exports = { issueQuote, EXPIRY_MS };
