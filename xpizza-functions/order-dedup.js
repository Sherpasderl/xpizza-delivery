'use strict';

const crypto = require('crypto');

// PURE. Content key = the order's CONTENT (phone + cart + type + slot), NOT its order_id. Two rapid
// submissions with the same content share a key → the server treats the 2nd as a re-tap (of ONE cart),
// not a distinct order. Phone normalized to its LAST 8 DIGITS (the platform's canonical phone key — same
// as muteKeyFor / order-matching: country-code / formatting insensitive). RTDB-safe hex (no . $ # [ ] /).
// order_id is deliberately EXCLUDED — this identifies the cart content, not the submission.
function orderContentKey({ phone, itemsText, orderType, scheduledFor } = {}) {
  const norm = [
    String(phone == null ? '' : phone).replace(/\D/g, '').slice(-8),
    String(itemsText == null ? '' : itemsText).trim(),
    String(orderType == null ? '' : orderType),
    Number.isFinite(scheduledFor) ? String(scheduledFor) : '',
  ].join('|');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

// A "re-tap" (→ skip the phone rate-limit increment) = the SAME content seen from this phone within the
// window (far edge exclusive). Non-finite / missing stamp → NOT a re-tap → count normally (fail-safe).
function isContentRetap(rec, now, windowMs) {
  return !!rec && Number.isFinite(rec.at) && (now - rec.at) < windowMs;
}

// Hashed bucket key for /rate_limits and /recent_order_content — avoids storing raw IPs/phones and dodges
// forbidden RTDB key chars ('.', ':', '+'). PURE. (Extracted from index.js so require-safe modules — e.g. the
// F3 materialize-side duplicate guard — can resolve the SAME content-stamp path index.js writes.)
function rateLimitKey(raw) {
  return require('crypto').createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);
}

module.exports = { orderContentKey, isContentRetap, rateLimitKey };
