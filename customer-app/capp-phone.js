// Customer app S-picker (PLAN-intl-phone r2.3 §2A/§6; MOCKUP-intl-phone-picker-APPROVED-2026-10-27) — the WhatsApp number's
// country: the SUPPORTED set, each country's national length and local format, and the E.164 the wire carries. Pure, UMD,
// brand-agnostic. DARK: used only when the app runtime carries intlPhone.
//
//   Supported ≠ login-enabled (plan §2B): this list is what the client can WRITE; whether a country may sign in / receive a code
//   is the server's per-sender allowlist, refused there with the existing copy. Delivery stays Honduras-only — only the PHONE is
//   international.
//   COUNTRIES                 the mockup's table, in its order (Honduras first = the default)
//   byCc(cc)                  the row for a calling code ('504'), or null
//   digits(s)                 the digits typed, nothing else
//   national(cc, s)           the digits capped at the country's national length (the input never holds more)
//   format(cc, s)             the national digits in the country's local format (the placeholder's shape), partial while typing
//   valid(cc, s)              exactly the national length
//   toE164(cc, s)             '+' + cc + national — the wire form; '' unless valid
//   parseE164(s)              { cc, national } for a qualified '+CC…' of a supported country with a valid length; null otherwise
//                             (an unsupported code — e.g. +44 — or a wrong length is never guessed into another country)
//   display(cc, s)            '+cc ' + format — how a number is shown back (the sheet's «Te lo enviamos al …», the member row)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappPhone = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // groups: the local format as digit-group sizes + the separators BEFORE each group (the mockup's placeholders)
  const COUNTRIES = [
    { cc: '504', name: 'Honduras', len: 8, ph: '9999-9999', groups: [4, 4], seps: ['', '-'] },
    { cc: '1', name: 'Estados Unidos', len: 10, ph: '(555) 123-4567', groups: [3, 3, 4], seps: ['(', ') ', '-'] },
    { cc: '52', name: 'México', len: 10, ph: '55 1234 5678', groups: [2, 4, 4], seps: ['', ' ', ' '] },
    { cc: '502', name: 'Guatemala', len: 8, ph: '9999-9999', groups: [4, 4], seps: ['', '-'] },
    { cc: '503', name: 'El Salvador', len: 8, ph: '9999-9999', groups: [4, 4], seps: ['', '-'] },
    { cc: '505', name: 'Nicaragua', len: 8, ph: '9999-9999', groups: [4, 4], seps: ['', '-'] },
    { cc: '506', name: 'Costa Rica', len: 8, ph: '9999-9999', groups: [4, 4], seps: ['', '-'] },
    { cc: '507', name: 'Panamá', len: 8, ph: '6999-9999', groups: [4, 4], seps: ['', '-'] },
    { cc: '501', name: 'Belice', len: 7, ph: '622-1234', groups: [3, 4], seps: ['', '-'] },
    { cc: '34', name: 'España', len: 9, ph: '612 34 56 78', groups: [3, 2, 2, 2], seps: ['', ' ', ' ', ' '] },
  ];
  const DEFAULT_CC = '504';
  const BY = new Map(COUNTRIES.map((c) => [c.cc, c]));
  const byCc = (cc) => BY.get(String(cc || '')) || null;
  const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
  const national = (cc, s) => { const c = byCc(cc); const d = digits(s); return c ? d.slice(0, c.len) : d; };
  function format(cc, s) {
    const c = byCc(cc); const d = national(cc, s); if (!c || !d) return d;
    let out = '', i = 0;
    for (let g = 0; g < c.groups.length && i < d.length; g++) { out += c.seps[g] + d.slice(i, i + c.groups[g]); i += c.groups[g]; }
    return out;
  }
  const valid = (cc, s) => { const c = byCc(cc); return !!c && digits(s).length === c.len; };
  const toE164 = (cc, s) => (valid(cc, s) ? '+' + cc + digits(s) : '');
  function parseE164(s) {
    const t = String(s == null ? '' : s).trim();
    if (!/^\+\d+$/.test(t.replace(/[\s().-]/g, ''))) return null;   // qualified only: a leading '+', digits and the usual punctuation
    const d = digits(t);
    // the longest supported code that prefixes it AND leaves exactly that country's national length (no code is a prefix of
    // another's valid number in this set; the length check makes a mismatch a reject, never a guess)
    for (const c of [...COUNTRIES].sort((a, b) => b.cc.length - a.cc.length)) if (d.startsWith(c.cc) && d.length - c.cc.length === c.len) return { cc: c.cc, national: d.slice(c.cc.length) };
    return null;
  }
  const display = (cc, s) => { const f = format(cc, s); return f ? `+${cc} ${f}` : ''; };

  return { COUNTRIES, DEFAULT_CC, byCc, digits, national, format, valid, toE164, parseE164, display };
});
