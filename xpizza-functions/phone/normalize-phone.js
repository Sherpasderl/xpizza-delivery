'use strict';
// The SILENT twin of whatsapp.normalizePhone (offer-audience PLAN r2 §6): otp-lib phoneHash runs on every login / guest / audience path and
// must never print a phone, while whatsapp.js (pinned byte-for-byte by older layers) keeps its logging normaliser. A synced copy (rule 4):
// otp-lib.test NORM-SAME pins this core === whatsapp.normalizePhone over the phone corpus — any drift is RED.
// → { digits, cleaned }: digits = full international digits (no '+'), or null when not 10–15 digits; cleaned = what was judged.
const DEFAULT_COUNTRY_CODE = '504';

function normalizePhoneCore(raw) {
  if (!raw) return { digits: null, cleaned: null };
  // Strip everything that isn't a digit or '+'
  let cleaned = String(raw).replace(/[^\d+]/g, '');
  // Drop leading '+'
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  // If it's 8 digits (Honduras local format), prepend country code
  if (cleaned.length === 8) cleaned = DEFAULT_COUNTRY_CODE + cleaned;
  // Validation: must be 10-15 digits to be plausibly an international number
  if (cleaned.length < 10 || cleaned.length > 15) return { digits: null, cleaned };
  return { digits: cleaned, cleaned };
}
const normalizePhoneQuiet = (raw) => normalizePhoneCore(raw).digits;

module.exports = { DEFAULT_COUNTRY_CODE, normalizePhoneCore, normalizePhoneQuiet };
