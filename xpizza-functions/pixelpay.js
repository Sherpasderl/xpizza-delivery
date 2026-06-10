/**
 * X Pizza — PixelPay server-side crypto helpers.
 *
 * ALL of these use the merchant SECRET and therefore MUST run server-side only
 * (never ship the raw secret to the browser). Per PixelPay docs (Secure Signature
 * + SDK Use Cases, confirmed 2026-06-09):
 *
 *   - x-client-signature  = HMAC-SHA3-512(secret, fields joined by "|")   [request integrity]
 *       doSale / doAuth  → app_key | order_id | app_url
 *       getStatus        → app_key | payment_uuid | app_url
 *       doCapture        → app_key | transaction_approved_amount | payment_uuid | app_url
 *   - payment_hash        = MD5(order_id | key_id | secret)               [verify a sale is genuine]
 *   - void_signature      = SHA-512(auth_user | order_id | secret)        [authorize a void]
 *   - auth_user (x-auth-user / platform user) = SHA-512(merchant_email)
 *
 * Node's crypto supports sha3-512 / sha512 / md5.
 */
const crypto = require('crypto');

// HMAC-SHA3-512 of the pipe-joined fields, keyed by the raw secret → hex.
function clientSignature(secret, fields) {
  return crypto.createHmac('sha3-512', String(secret))
    .update(fields.map(String).join('|'))
    .digest('hex');
}

const saleSignature = (secret, { app_key, order_id, app_url }) =>
  clientSignature(secret, [app_key, order_id, app_url]);

const authSignature = saleSignature; // doAuth signs the same fields as doSale

const statusSignature = (secret, { app_key, payment_uuid, app_url }) =>
  clientSignature(secret, [app_key, payment_uuid, app_url]);

const captureSignature = (secret, { app_key, transaction_approved_amount, payment_uuid, app_url }) =>
  clientSignature(secret, [app_key, transaction_approved_amount, payment_uuid, app_url]);

// payment_hash returned in a successful sale = MD5(order_id | key_id | secret).
function paymentHash(order_id, key_id, secret) {
  return crypto.createHash('md5')
    .update([order_id, key_id, secret].map(String).join('|'))
    .digest('hex');
}

// Verify a sale's payment_hash is genuine (constant-time).
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

// void_signature = SHA-512(auth_user | order_id | secret).
function voidSignature(auth_user, order_id, secret) {
  return crypto.createHash('sha512')
    .update([auth_user, order_id, secret].map(String).join('|'))
    .digest('hex');
}

module.exports = {
  clientSignature, saleSignature, authSignature, statusSignature, captureSignature,
  paymentHash, verifyPaymentHash, platformUser, voidSignature
};
