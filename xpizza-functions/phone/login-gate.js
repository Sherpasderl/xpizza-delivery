'use strict';
// INTL PHONE S-core step 4 (PLAN-intl-phone r2.3 §5; advisor rulings 2026-10-27) — the LOGIN-ENABLED gate for requestOtp, per SENDER.
//   senderInstanceId(rid)        the UltraMsg instance that actually delivers this restaurant's code: the last path segment of
//                                whatsapp.resolveWhatsappConfig(rid).apiBase — the SAME resolver sendMessage uses — or null
//   loginCountryOf(phone, strict) strict (config/phone_wire_strict ON) → phone/intl.js parseSubmitted's cc;
//                                OFF → the cc of today's UNCHANGED normalizePhone digits (a stored '+'+8 stays HN, as today) | null
//   allowedCountries(db, id, now) RTDB config/phone_login/{instanceId} (owner-written): a list of supported CCs, cached 30 s per
//                                instance; '504' is ALWAYS included (the delivery country — an owner typo can never stop HN logins);
//                                absent / malformed (any non-supported entry) / read error / 500 ms timeout → ['504'] (fail closed)
//   otpLoginAllowed({...})       HN (today's reading) → true with NO read and NO flag evaluation (zero added latency); another country → true only if THAT
//                                sender's list has it; unparseable / unsupported / no sender → false.
// A refusal is answered by requestOtp with its existing uniform response (no enumeration). verifyOtp is NOT gated: a code already
// issued is honoured until it expires (plan §5). Never logs a phone.
const { parseSubmitted, SUPPORTED } = require('./intl');
const W = require('../whatsapp');
const HN = '504';
const TTL_MS = 30_000, TIMEOUT_MS = 500;
const CCS = new Set(SUPPORTED.map((c) => c.cc));
const BY_LONGEST = [...SUPPORTED].sort((a, b) => b.cc.length - a.cc.length);
let _cache = new Map();

function senderInstanceId(restaurantId, resolve = W.resolveWhatsappConfig) {
  const cfg = resolve(restaurantId);
  const base = cfg && typeof cfg.apiBase === 'string' ? cfg.apiBase : '';
  const id = base.slice(base.lastIndexOf('/') + 1);
  return /^instance\d+$/.test(id) ? id : null;
}

function loginCountryOf(phone, strict) {
  if (strict === true) { const p = parseSubmitted(phone); return p ? p.cc : null; }
  const d = W.normalizePhone(phone);
  if (!d) return null;
  const c = BY_LONGEST.find((x) => d.startsWith(x.cc) && d.length - x.cc.length === x.len);
  return c ? c.cc : null;
}

function normalizeList(v) {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && CCS.has(x))) return [HN];
  return [HN, ...v.filter((x) => x !== HN)].filter((x, i, a) => a.indexOf(x) === i);
}

async function allowedCountries(db, instanceId, now = Date.now()) {
  if (!instanceId) return [HN];
  const hit = _cache.get(instanceId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let timer;
  try {
    const v = await Promise.race([
      db.ref(`config/phone_login/${instanceId}`).once('value').then((s) => s.val()),
      new Promise((res) => { timer = setTimeout(() => res(undefined), TIMEOUT_MS); }),
    ]);
    if (v === undefined) return [HN];   // timeout: not cached, fail closed
    const value = normalizeList(v);
    _cache.set(instanceId, { value, at: now });
    return value;
  } catch (e) {
    console.error('phone-login-gate: config read failed → [504]', e && e.message);
    return [HN];
  } finally { clearTimeout(timer); }
}

// codex r1 #2: the HN fast path runs FIRST — on today's unchanged identity reading — before ANY flag evaluation or read. `strict` may
// be a boolean or a lazy () => boolean (requestOtp passes phoneWireStrictNow), evaluated at most once, and only for a non-HN number.
async function otpLoginAllowed({ db, phone, restaurantId, strict, now = Date.now(), resolve = W.resolveWhatsappConfig }) {
  const today = loginCountryOf(phone, false);
  if (today === HN) return true;
  const isStrict = (typeof strict === 'function' ? strict() : strict) === true;
  const cc = isStrict ? loginCountryOf(phone, true) : today;
  if (!cc) return false;
  if (cc === HN) return true;
  return (await allowedCountries(db, senderInstanceId(restaurantId, resolve), now)).includes(cc);
}

function _resetForTest() { _cache = new Map(); }
module.exports = { senderInstanceId, loginCountryOf, allowedCountries, otpLoginAllowed, _resetForTest };
