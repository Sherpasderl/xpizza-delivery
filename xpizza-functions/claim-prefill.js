'use strict';

// Track A — profile-claim soft-fill lookup (PURE core; the HTTP wrapper + per-IP throttle live in index.js
// as exports.claimPrefill). Token-gated: returns the order's OWN name+phone ONLY when the public
// order_tracking/{token} node resolves — by STRICT string compare — to exactly the requested order_id. The
// tracking_token is the capability the customer already holds (in their tracker link); it is bound to one
// order. Read-only; returns NO other PII (no address/items/uid). Account creation stays OTP-gated downstream,
// so a leaked token can never hijack — it can at most reveal the customer's own phone.
async function claimPrefillCore(db, orderId, token) {
  orderId = String(orderId || '').trim();
  token = String(token || '').trim();
  // Missing/malformed order_id → 403 (no info leak). Token must be RTDB-path-safe (real tokens are 12
  // alphanumerics) so `order_tracking/{token}` can never be a path injection.
  if (!orderId || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { status: 403, body: { error: 'forbidden' } };
  if (!token || !/^[A-Za-z0-9]{1,64}$/.test(token)) return { status: 403, body: { error: 'forbidden' } };
  const trk = (await db.ref(`order_tracking/${token}`).once('value')).val();
  if (!trk || String(trk.order_id) !== orderId) return { status: 403, body: { error: 'forbidden' } };   // token↔order STRICT bind
  const order = (await db.ref(`orders/${orderId}`).once('value')).val();
  if (!order) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: { ok: true, name: order.customer_name || '', phone: order.customer_phone || '' } };
}

module.exports = { claimPrefillCore };
