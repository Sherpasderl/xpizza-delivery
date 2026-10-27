'use strict';
// INTL PHONE S-core step 2 — a DETERMINISTIC corpus of every live phone shape (seeded; no real numbers). Test support only.
//   forms   xpizza-orders/la-musa-orders fullPhone(): '+'+cc+' '+fmtPhoneLocal(cc, digits) — incl. PARTIAL / over-length typing
//   capp    '+504 XXXX-XXXX' (capp-checkout fullPhone) and E.164 '+CCnational' (capp-phone toE164)
//   otp     the account overlay's 'XXXX-XXXX' / 8 bare digits
//   stored  profile 'CCnational'; old sanitizePhone '+digits' / 'digits'; inbound UltraMsg CC digits
const { SUPPORTED } = require('./intl');
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
// the forms' fmtPhoneLocal (xpizza-orders/index.html:6085-6089), with its len taken from the given country
function fmtPhoneLocal(cc, len, d) {
  if (cc === '1') { if (d.length > 6) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6); if (d.length > 3) return '(' + d.slice(0, 3) + ') ' + d.slice(3); return d; }
  if (len === 8) return d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d;
  return d.replace(/(\d{2,3})(?=\d)/g, '$1 ').trim();
}
function buildCorpus(perCountry = 40, seed = 0x504) {
  const r = rng(seed); const out = [];
  const digits = (k) => { let s = String(1 + Math.floor(r() * 9)); while (s.length < k) s += String(Math.floor(r() * 10)); return s; };
  for (const { cc, len } of SUPPORTED) {
    for (let i = 0; i < perCountry; i++) {
      const nat = digits(len);
      out.push('+' + cc + ' ' + fmtPhoneLocal(cc, len, nat));            // forms, valid
      out.push('+' + cc + nat);                                          // capp E.164 / old sanitizePhone with '+'
      out.push(cc + nat);                                                // stored profile / inbound / old sanitizePhone bare
      const k = 1 + Math.floor(r() * (len - 1));
      out.push('+' + cc + ' ' + fmtPhoneLocal(cc, len, nat.slice(0, k))); // forms, PARTIAL typing (restore path)
      out.push('+' + cc + ' ' + fmtPhoneLocal(cc, len, nat + digits(1 + Math.floor(r() * 3))));   // over-length
      if (cc === '504') {
        out.push(nat, nat.slice(0, 4) + '-' + nat.slice(4), '+' + nat);  // otp overlay, bare-8, the stored '+'+8
        out.push('+504 ' + fmtPhoneLocal('504', 8, ('12' + nat).slice(0, 11)));   // capp member non-HN under +504 (finding #3 shape)
      }
    }
  }
  return out;
}
module.exports = { buildCorpus, fmtPhoneLocal };
