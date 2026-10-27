// INTL PHONE — dispatch-lane ESM copy of the server's ONE wire-contract parser (xpizza-functions/phone/intl.js
// @ feat/intl-phone-core 8f24b269). Behavior is byte-identical (dispatch-intl-parity.test.mjs proves it against
// the vendored canonical intl.ref.cjs). Pure, no I/O, never logs its input. Used by the dispatch comms grouping
// (index.html) to key a conversation by IDENTITY digits, not a last-8 suffix.
//   parseSubmitted(raw)    → {cc, national, canonical '+CCnational', identity 'CCnational'} | null
//   legacyRawForms(canon)  → the raw strings an older server stored for the SAME number | []
export const SUPPORTED = Object.freeze([
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

export function parseSubmitted(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(SEPARATORS_RE, '');
  if (/^\+\d+$/.test(s)) return fromDigits(s.slice(1));
  if (/^\d{8}$/.test(s)) return fromDigits(DEFAULT_CC + s);
  return null;
}

export function legacyRawForms(canonical) {
  if (typeof canonical !== 'string' || !/^\+\d+$/.test(canonical)) return [];
  const p = fromDigits(canonical.slice(1));
  if (!p || p.canonical !== canonical) return [];
  return p.cc === DEFAULT_CC ? [p.canonical, p.identity, p.national] : [p.canonical, p.identity];
}
