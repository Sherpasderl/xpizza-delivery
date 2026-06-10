/**
 * X Pizza — PixelPay server-side crypto helpers.
 *
 * These use the merchant SECRET and MUST run server-side only (never ship the raw
 * secret to the browser). Per PixelPay's SDK auth model (key+hash; no x-client-
 * signature), the only secret-bearing operations we need are:
 *
 *   - payment_hash   = MD5(order_id | key_id | secret)   — verify a capture is genuine
 *                      (order_id here is the pixelpay_order_id; key_id is the app/auth key)
 *   - auth_user      = SHA-512(merchant_email)            — the x-auth-user HEADER for void
 *   - void_signature = SHA-512(merchant_email | order_id | secret)
 *                      ⚠ the signature uses the RAW EMAIL (NOT the hashed auth_user), per
 *                      PixelPay's "Cancelling Payments" doc; order_id = pixelpay_order_id.
 *
 * (The SDK authenticates the sale/capture/status with x-auth-key + x-auth-hash only —
 * there is NO request signature — so the former HMAC-SHA3 helpers were removed.)
 */
const crypto = require('crypto');

// payment_hash returned in a successful sale/capture = MD5(order_id | key_id | secret).
function paymentHash(order_id, key_id, secret) {
  return crypto.createHash('md5')
    .update([order_id, key_id, secret].map(String).join('|'))
    .digest('hex');
}

// Verify a capture's payment_hash is genuine (constant-time).
function verifyPaymentHash(received, order_id, key_id, secret) {
  const expected = paymentHash(order_id, key_id, secret);
  const a = Buffer.from(String(received || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}

// auth_user / x-auth-user = SHA-512 of the authorized merchant user's email.
const platformUser = (email) =>
  crypto.createHash('sha512').update(String(email).trim().toLowerCase()).digest('hex');

// void_signature = SHA-512(merchant_email | order_id | secret), '|'-joined.
// NOTE: the first element is the RAW merchant email — NOT SHA-512(email). (SHA-512(email)
// is only the x-auth-user header.) order_id = the PixelPay-facing id (pixelpay_order_id).
function voidSignature(email, order_id, secret) {
  return crypto.createHash('sha512')
    .update([email, order_id, secret].map(String).join('|'))
    .digest('hex');
}

module.exports = { paymentHash, verifyPaymentHash, platformUser, voidSignature };
