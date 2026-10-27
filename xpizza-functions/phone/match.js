'use strict';
// INTL PHONE S-match (PLAN-intl-phone r2.3 §4 → r1 §5) — full-number phone comparison, replacing the last-8 suffix matches that
// cross countries (+502 9795-0000 and +504 9795-0000 share a suffix). Pure; never logs.
//   storedIdentity(raw)  the CC digits of a STORED / inbound value — byte-for-byte today's whatsapp.normalizePhone (unchanged by
//                        design: a stored '+'+8 stays HN), minus its console.warn (it would log the raw phone). Parity is tested over
//                        the 2,160-shape live corpus. null when it is not a phone.
//   samePhone(a, b)      both identities present AND equal. A null / invalid operand NEVER matches.
//   muteKeyFor(phone)    the auto-mute leaf key: the identity digits ('' when not a phone — the caller skips). Existing last-8 mute
//                        leaves are short-lived (a staff-reply window) and simply EXPIRE; there is NO suffix fallback (plan r1 §5).
const DEFAULT_COUNTRY_CODE = '504';   // whatsapp.js:33 — parity asserted by the corpus test

function storedIdentity(raw) {
  if (!raw) return null;
  let cleaned = String(raw).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (cleaned.length === 8) cleaned = DEFAULT_COUNTRY_CODE + cleaned;
  if (cleaned.length < 10 || cleaned.length > 15) return null;
  return cleaned;
}

function samePhone(a, b) {
  const x = storedIdentity(a), y = storedIdentity(b);
  return x !== null && x === y;
}

function muteKeyFor(phone) {
  return storedIdentity(phone) || '';
}

module.exports = { storedIdentity, samePhone, muteKeyFor };
