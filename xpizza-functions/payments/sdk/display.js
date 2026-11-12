'use strict';
// The card DISPLAY schema (Codex S3 r4 P1) — applied SERVER-side before the first persistence (the attempt journal), again at the
// vault write, and on every listing: exactly { brand ∈ visa|mastercard|amex|other, last4 = 4 digits, exp_month 1–12, exp_year
// 2000–2099 }; unknown keys are DROPPED; anything malformed ⇒ null (the caller refuses / skips). Never a PAN, CVV, name or email.
const BRANDS = Object.freeze(['visa', 'mastercard', 'amex', 'other']);
function sanitizeDisplay(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const { brand, last4, exp_month: m, exp_year: y } = d;
  if (typeof brand !== 'string' || !BRANDS.includes(brand)) return null;
  if (typeof last4 !== 'string' || !/^\d{4}$/.test(last4)) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y < 2000 || y > 2099) return null;
  return { brand, last4, exp_month: m, exp_year: y };
}
module.exports = { sanitizeDisplay, BRANDS };
