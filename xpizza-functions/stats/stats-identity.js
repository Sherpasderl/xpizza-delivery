'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — customer identity (PLAN-stats rev 4, §S1.2 "Customer identity"; codex r3 #3).
//
// Customers are keyed by an HMAC of their phone. No raw phone is ever stored in, returned by, or LOGGED
// by any stats code.
//
// 🔴 THIS NORMALIZER IS DELIBERATELY NOT whatsapp.js's. That helper logs the RAW phone on bad input
// (whatsapp.js:98, `console.warn(\`whatsapp: phone "${raw}" ...\`)`), and a stats job runs it over every
// order in history, so reusing it would write customer phone numbers into Cloud Logging by the thousand.
// This one has the SAME valid-phone behaviour (stats-identity.test.js proves parity on valid inputs) and
// STRICTER validation, and it is SILENT: it returns null and never logs, throws or echoes its input.
//
// THE KEY: HMAC-SHA256(restaurantKey, canonicalPhone), where restaurantKey = HMAC-SHA256(secret,
// 'sherpa-stats-customer/v1/' + rid). Restaurant-scoped, so the same phone has unrelated keys at two
// restaurants and one merchant's stats can never be joined to another's. Versioned (`h1:`), so a
// future change of scheme cannot be confused with this one. Truncated to 128 bits: collision-free at any
// plausible customer count, and half the index bytes of the full digest.
//
// FAILS CLOSED. No secret, or one too short to be a real key → loadStatsSecret() throws, and the job
// aborts rather than hashing with no key (an unkeyed hash of a phone number is reversible by
// enumeration: Honduras mobile numbers are an 8-digit space). Rotating the secret changes every key, so
// it is a coordinated FULL REBUILD (backfill --commit), never an in-place change.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const KEY_VERSION = 'h1';
const SECRET_ENV = 'STATS_HMAC_SECRET';
const MIN_SECRET_LEN = 32;
// Same default country code as whatsapp.js:33 (not exported there); parity is asserted by the test.
const COUNTRY_CODE = '504';
const HMAC_HEX_CHARS = 32;   // 128 bits

// Separators a person types inside a phone number. Anything else (letters, '#', '*', a second '+')
// makes the input invalid — STRICTER than whatsapp.js, which strips every non-digit and so would turn
// "call 9-8888-4444 ext 2" into a plausible number.
const SEPARATORS_RE = /[\s\-().]/g;

function normalizePhoneSilent(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw).replace(SEPARATORS_RE, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+$/.test(s)) return null;
  if (s.length === 8) s = COUNTRY_CODE + s;
  if (s.length < 10 || s.length > 15) return null;
  return s;
}

function loadStatsSecret(env = process.env) {
  const v = env && env[SECRET_ENV];
  if (typeof v !== 'string' || v.trim().length < MIN_SECRET_LEN) {
    // The message names the VARIABLE, never its value.
    throw new Error(`stats_secret_unavailable: ${SECRET_ENV} is missing or shorter than ${MIN_SECRET_LEN} chars`);
  }
  return v.trim();
}

// keyer(rid, phone) → 'h1:<32 hex>' or null (anonymous). Per-restaurant keys are derived once.
function makeCustomerKeyer(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LEN) throw new Error('stats_secret_unavailable: keyer needs a loaded secret');
  const perRid = new Map();
  const keyFor = (rid) => {
    let k = perRid.get(rid);
    if (!k) { k = crypto.createHmac('sha256', secret).update(`sherpa-stats-customer/v1/${rid}`).digest(); perRid.set(rid, k); }
    return k;
  };
  function customerKey(rid, phone) {
    const p = normalizePhoneSilent(phone);
    if (!p) return null;
    const h = crypto.createHmac('sha256', keyFor(rid)).update(p).digest('hex').slice(0, HMAC_HEX_CHARS);
    return `${KEY_VERSION}:${h}`;
  }
  // CSV continuation-cursor authentication (codex build r2, S7'). A DOMAIN-SEPARATED key derived from
  // the same server secret — never the customer key — so a cursor tag can neither be recomputed by a
  // client nor be confused with any other use of the secret. Loaded exactly as lazily (and fails closed
  // exactly as) the keyer it rides on.
  const cursorKey = crypto.createHmac('sha256', secret).update('sherpa-stats-csv-cursor/v1').digest();
  customerKey.cursorTag = (payload) => crypto.createHmac('sha256', cursorKey).update(`csv-cursor-v1|${payload}`).digest('hex').slice(0, 32);
  return customerKey;
}

const CUSTOMER_KEY_RE = /^h1:[0-9a-f]{32}$/;

module.exports = { normalizePhoneSilent, loadStatsSecret, makeCustomerKeyer, CUSTOMER_KEY_RE, SECRET_ENV, KEY_VERSION, COUNTRY_CODE };
