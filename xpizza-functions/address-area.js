'use strict';
// ---------------------------------------------------------------------------
// Order colonia (PLAN-colonia-address-area r1, Codex r2 APPROVED; owner ruling 2026-10-24) — the SERVER policy for
// orders/{oid}/address_area: the customer's colonia, derived by the NEW customer app from the confirmed pin's reverse
// geocode, shown to the driver on the offer BEFORE acceptance (ledger R4). The value is client-supplied, so the server keeps
// ONLY a short label with no digits and no street/house token, and omits everything else (simple, fail-closed). This lowers —
// it cannot rule out — an exposing label; the driver sees it pre-accept. Never derived from address_detected / address_details.
//
// addressAreaFrom(v) → the kept label, or '' (the writers then omit the key; RTDB would store an empty string).
// ---------------------------------------------------------------------------

const MAX_LEN = 40;
// whole words, compared case- and accent-folded (`av` / `blvd` = spelling variants of ave / boulevard, advisor-accepted)
const STREET_TOKENS = Object.freeze(['calle', 'ave', 'avenida', 'av', 'casa', 'bloque', 'lote', 'apto', 'km', 'carretera',
  'boulevard', 'bulevar', 'blvd', 'pasaje', 'sendero']);
const TOKEN_SET = new Set(STREET_TOKENS);

function addressAreaFrom(v) {
  if (typeof v !== 'string') return '';                                   // never stringify an object / number / array
  const s = v.normalize('NFKC').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '' || s.length > MAX_LEN) return '';                          // over the cap → DROP, never truncate
  if (/\p{Nd}/u.test(s)) return '';                                       // a digit → a house / street number risk
  if (/[#<>]/.test(s)) return '';                                         // dropped, not stripped
  const words = s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z]+/);
  if (words.some((w) => TOKEN_SET.has(w))) return '';
  return s;
}

module.exports = { addressAreaFrom, STREET_TOKENS, MAX_LEN };
