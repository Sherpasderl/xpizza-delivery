'use strict';
// INTL PHONE S-core (PLAN-intl-phone r2.3 §2/§2A/§3/§3A) — the server's ONE wire-contract parser for a SUBMITTED customer phone.
// Pure, no I/O, never logs its input.
//   SUPPORTED              the supported set (mirrors the capp picker, customer-app/capp-phone.js) — parsing support, NOT login
//                          enablement (that is the per-sender gate, plan §5)
//   parseSubmitted(raw)    → {cc, national, canonical '+CCnational', identity 'CCnational'} | null
//                            QUALIFIED: a LEADING '+' (or '00') + a supported CC + exactly that country's national length;
//                            BARE (versionless legacy client): exactly 8 digits ⇒ +504; any other bare length → null (never guessed).
//                            Separators allowed: ASCII space, '-', '(', ')', '.'. Anything else (a second '+', letters, '#',
//                            non-ASCII digits or spaces, a non-string) → null. No fallback, ever.
//   legacyRawForms(canon)  → the raw strings an older server stored for the SAME number (sanitizePhone kept an optional '+' and
//                            digits): [canonical, the no-'+' digits, and — for +504 only — the bare 8]. [] unless `canon` is canonical.
const SUPPORTED = Object.freeze([
  ['504', 8], ['1', 10], ['52', 10], ['502', 8], ['503', 8], ['505', 8], ['506', 8], ['507', 8], ['501', 7], ['34', 9],
].map(([cc, len]) => Object.freeze({ cc, len })));
const BY_LONGEST = [...SUPPORTED].sort((a, b) => b.cc.length - a.cc.length);
const SEPARATORS_RE = /[ \-().]/g;
const DEFAULT_CC = '504';

function fromDigits(d) {
  // the longest supported code that prefixes it AND leaves exactly that country's national length
  for (const c of BY_LONGEST) {
    if (d.startsWith(c.cc) && d.length - c.cc.length === c.len) {
      const national = d.slice(c.cc.length);
      return { cc: c.cc, national, canonical: `+${c.cc}${national}`, identity: `${c.cc}${national}` };
    }
  }
  return null;
}

// codex r1 #5: the qualifier must LEAD the trimmed input — '+' or the '00' international prefix — and is read BEFORE separators
// are stripped, so '(+504) 9795-0000' is NOT qualified (it takes the bare rule). → {qualified, digits} | null (non-digits left).
function splitSubmitted(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  const q = t.startsWith('+') ? t.slice(1) : t.startsWith('00') ? t.slice(2) : null;
  const d = (q === null ? t : q).replace(SEPARATORS_RE, '');
  return /^\d+$/.test(d) ? { qualified: q !== null, digits: d } : null;
}

function parseSubmitted(raw) {
  const x = splitSubmitted(raw);
  if (!x) return null;
  if (x.qualified) return fromDigits(x.digits);
  return x.digits.length === 8 ? fromDigits(DEFAULT_CC + x.digits) : null;
}

function legacyRawForms(canonical) {
  if (typeof canonical !== 'string' || !/^\+\d+$/.test(canonical)) return [];
  const p = fromDigits(canonical.slice(1));
  if (!p || p.canonical !== canonical) return [];
  return p.cc === DEFAULT_CC ? [p.canonical, p.identity, p.national] : [p.canonical, p.identity];
}

module.exports = { SUPPORTED, parseSubmitted, splitSubmitted, legacyRawForms };
