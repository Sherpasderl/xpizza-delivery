'use strict';
// ── PLAN-guest-checkout-server §1.2 — the SERVER-side phone country allowlist (the login-country allowlist of PLAN-intl-phone) ──
// The order forms' client list is PHONE_COUNTRIES (xpizza-orders/index.html:6073, la-musa-orders/index.html:6413); until now
// the server had NO allowlist (intl phone was client-only). This is the one server source; 5f's intl S-core owns it next.
// A wire phone is QUALIFIED E.164: '+' then the country code then exactly that country's national length.
const COUNTRIES = Object.freeze([
  { cc: '504', len: 8 },   // Honduras
  { cc: '1', len: 10 },    // Estados Unidos
  { cc: '502', len: 8 },   // Guatemala
  { cc: '503', len: 8 },   // El Salvador
  { cc: '505', len: 8 },   // Nicaragua
  { cc: '506', len: 8 },   // Costa Rica
  { cc: '52', len: 10 },   // México
  { cc: '34', len: 9 },    // España
]);

// → { e164: '+50499990000', cc: '504', national: '99990000' } | null. Never throws; anything not exactly an allow-listed
// qualified number is null (the caller answers 400 country_not_allowed / bad_request).
function parseE164(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\+\d{8,15}$/.test(s)) return null;
  const digits = s.slice(1);
  // longest country-code match first (no allow-listed code is a prefix of another today, but the rule must not depend on that)
  for (const c of [...COUNTRIES].sort((a, b) => b.cc.length - a.cc.length)) {
    if (digits.startsWith(c.cc) && digits.length === c.cc.length + c.len) return { e164: s, cc: c.cc, national: digits.slice(c.cc.length) };
  }
  return null;
}

module.exports = { COUNTRIES, parseE164 };
