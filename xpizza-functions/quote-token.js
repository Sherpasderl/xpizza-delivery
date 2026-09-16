'use strict';
// ---------------------------------------------------------------------------
// Portal 1C Task 2 — THE SIGNED QUOTE TOKEN.
//
// The confirmed-quote gate rests on one question the server must be able to answer at charge time:
// "is this net total one I issued, for THIS cart, recently?" — without trusting anything the client
// sends. The token is how it answers: the server signs the net it computed, the client carries the
// token back, and the charge path verifies the signature and re-derives the cart fingerprint. A client
// that edits the amount invalidates the signature; a client that changes the cart invalidates the
// fingerprint. Neither needs the client to be honest.
//
// Pure and dependency-free on purpose: no network, no clock, no config. `nowMs` is passed in rather
// than read, so expiry is testable at the boundary instead of approximately.
//
// 🔴 THE SECRET IS SERVER-ONLY. It is passed in (env-managed by the caller) and never leaves this
// process. A token is not a capability the client may mint — it is one the server hands out.
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/* THE CART FINGERPRINT — what makes a token specific to one cart rather than to one amount.
 *
 * 🔴 IT BINDS THE REWARD, AND THAT IS NOT A DETAIL. Task 1 established that a la_musa reward is
 * NET-INVARIANT: add_free adds a free line rather than discounting, and la_musa has no ISV split, so a
 * reward-active cart and its no-reward twin produce the SAME net_total_cents. If the fingerprint
 * ignored the reward those two carts would be indistinguishable to the gate — a token issued for the
 * plain cart would verify for the reward-active one, and the customer would collect a free item the
 * quote never priced. The amount cannot carry that difference, so the fingerprint must.
 *
 * CANONICALISED BY STRUCTURE, NOT BY STRING-JOINING. The obvious implementation — join the fields with
 * a separator and hash the string — collides the moment a separator can appear inside a field: an item
 * named "a|b" hashes identically to two items "a" and "b". JSON of a normalised structure has no such
 * ambiguity, because the delimiters are outside the values rather than between them.
 *
 * Order-independent by construction (both items and their extras are sorted), because the same cart
 * assembled in a different order is the same cart — and a fingerprint that disagreed would refuse
 * honest customers at the charge, which is the failure nobody reports as a bug.
 */
function cartFingerprint(normItems, reward) {
  const keyOf = (o) => (o && o.id !== undefined && o.id !== null ? String(o.id) : String(o && o.name));
  const cmp = (a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.q - b.q);

  const items = (Array.isArray(normItems) ? normItems : []).map((it) => ({
    k: keyOf(it),
    q: Number(it && it.qty) || 0,
    x: (Array.isArray(it && it.extras) ? it.extras : [])
      .map((e) => ({ k: keyOf(e), q: Number(e && e.qty) || 1 }))
      .sort(cmp),
  })).sort(cmp);

  // The reward's IDENTITY, not its value: which model, which items, how many of each. The price is
  // included because the reward path validates it against the live menu, so a reward priced against a
  // different menu is a different reward.
  const r = reward ? {
    m: String(reward.model || ''),
    f: (Array.isArray(reward.freeItems) ? reward.freeItems : [])
      .map((fi) => ({ k: String(fi && fi.item_id), q: Number(fi && fi.qty) || 1, p: Number(fi && fi.price_cents) || 0 }))
      .sort(cmp),
  } : null;

  return crypto.createHash('sha256').update(JSON.stringify({ i: items, r })).digest('hex');
}

/* SIGN — base64url(json).base64url(HMAC-SHA256(json, secret)).
 * The HMAC covers the EXACT BYTES that are transmitted, not a re-serialisation of the parsed payload:
 * verify hashes the decoded body buffer as received, so a payload that re-serialises differently
 * (key order, number formatting) can never verify against a signature computed over a different
 * encoding of "the same" object. */
function signQuoteToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return `${b64u(body)}.${b64u(sig)}`;
}

/* VERIFY — { ok, reason, payload }, reason ∈ {ok, bad_format, bad_signature, expired}.
 *
 * 🔴 THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY. `expires_at` lives INSIDE the payload, which
 * means it is the attacker's field right up until the signature is verified. Checking expiry first
 * would be reading an untrusted number to decide whether to trust the token — and a forged token with
 * a far-future expiry would be reported as anything other than a forgery. Signature first, always;
 * the payload is not believed until it is.
 *
 * NEVER THROWS. The caller is an endpoint holding whatever the client sent, so garbage must be a typed
 * refusal rather than an exception — a verifier that throws is a denial of service on the charge path.
 */
function verifyQuoteToken(token, secret, nowMs) {
  const bad = (reason) => ({ ok: false, reason, payload: null });
  try {
    if (typeof token !== 'string' || !token) return bad('bad_format');
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return bad('bad_format');
    if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return bad('bad_format');

    const body = Buffer.from(parts[0], 'base64url');
    const given = Buffer.from(parts[1], 'base64url');
    const expected = crypto.createHmac('sha256', secret).update(body).digest();

    /* Constant-time compare. The length check in front of it is NOT constant-time and cannot be —
       timingSafeEqual throws on a length mismatch — but a length is not a secret: it is fixed at 32
       bytes for every genuine token, so learning it tells an attacker nothing they could not read from
       this file. What must not leak is WHERE two same-length digests first differ, because that turns
       forgery into 32 guesses instead of 2^256, and that is exactly what timingSafeEqual prevents. */
    if (given.length !== expected.length) return bad('bad_signature');
    if (!crypto.timingSafeEqual(given, expected)) return bad('bad_signature');

    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch (_) { return bad('bad_format'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return bad('bad_format');

    // Signed, therefore believable — and only now is expires_at worth reading. `>=` so a token is dead
    // AT its expiry rather than one millisecond later: the boundary belongs to the closed side.
    if (!Number.isFinite(Number(payload.expires_at)) || Number(nowMs) >= Number(payload.expires_at)) {
      return { ok: false, reason: 'expired', payload: null };
    }
    return { ok: true, reason: 'ok', payload };
  } catch (_) {
    return bad('bad_format');
  }
}

module.exports = { cartFingerprint, signQuoteToken, verifyQuoteToken };
