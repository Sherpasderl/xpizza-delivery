'use strict';
// ── PLAN-guest-checkout-server r4 (FINAL) §1 — S1: the checkout-purpose WhatsApp code (NEW endpoints; requestOtp / verifyOtp are
// untouched, so the forms' wire and the signup inverse are unaffected). Wire: CONTRACT-capp-guest-checkout-wire.md.
//   requestCheckoutCode {phone_e164, restaurant_id, cart_fp}
//     → 200 {ok, resend_in_s} | 429 {error:'rate_limited', retry_in_s} | 502 {error:'send_failed', attempt, max_attempts}
//       | 400 {error:'country_not_allowed'} | 400 {error:'bad_request'} | 405
//   verifyCheckoutCode {phone_e164, restaurant_id, cart_fp, order_id, code}
//     → 200 {ok, checkout_ticket} | 400 {error:'code_wrong'|'code_expired'} | 429 {error:'too_many_attempts', retry_in_s}
//       | 400 {error:'bad_request'} | 405
// Storage (server-only RTDB): checkout_otp/{h} (the live code, its OWN record — a checkout code never verifies a signup and vice
// versa), otp_budget/{h} (the durable checkout send budget), checkout_tickets/{sha256(ticket)} (the order-id-bound ticket),
// and the SHARED otp_ip/{ipHash} per-IP budget. h = OTP.phoneHash (the ONE phone hash, otp-lib.js:6-7).
// The sender is the PLATFORM sender (launch-time config, never hardcoded): ULTRAMSG_INSTANCE_ID_PLATFORM / _TOKEN_PLATFORM and
// the message template CHECKOUT_OTP_TEMPLATE (must contain {code}). Any of them unset ⇒ 502 send_failed — never a silent success.
const crypto = require('crypto');
const G = require('./checkout-guest-lib');
const { parseE164 } = require('./phone-countries');

const HEX64_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^\d{6}$/;
const RESEND_IN_S = 30;

const json = (res, status, body) => res.status(status).json(body);

// The platform sender. env + fetch injected (unit tests); acceptance is the POSITIVE provider signal (isSendConfirmed).
async function sendPlatformOtp(toDigits, code, { env = process.env, fetchImpl = fetch, isSendConfirmed } = {}) {
  const id = env.ULTRAMSG_INSTANCE_ID_PLATFORM, token = env.ULTRAMSG_TOKEN_PLATFORM, tpl = env.CHECKOUT_OTP_TEMPLATE;
  if (!id || !token || typeof tpl !== 'string' || !tpl.includes('{code}')) return { ok: false, reason: 'unconfigured' };
  try {
    const params = new URLSearchParams({ token, to: toDigits, body: tpl.split('{code}').join(code) });
    const resp = await fetchImpl(`https://api.ultramsg.com/${id}/messages/chat`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) return { ok: false, reason: 'provider' };
    return { ok: !!isSendConfirmed(data), reason: isSendConfirmed(data) ? 'ok' : 'unconfirmed' };
  } catch (_) { return { ok: false, reason: 'threw' }; }
}

// deps: { getDatabase, registry (() => the restaurant registry) | knownRid (async (rid) => boolean, tests), now?, env?, fetchImpl?, OTP?, whatsapp? }
function makeCheckoutOtp(deps) {
  // a KNOWN rid only, never defaulted: the registry is warmed first (a cold instance must not refuse a real merchant)
  const knownRid = deps.knownRid || (async (rid) => { const r = deps.registry(); await r.ready(); return r.known().has(rid); });
  const now = deps.now || (() => Date.now());
  const loadOtp = () => deps.OTP || require('./otp-lib');            // lazy: otp-lib fails closed on a short OTP_SALT (500)
  const wa = () => deps.whatsapp || require('./whatsapp');

  // shared input checks → { e164, digits, rid, cartFp } | { err: [status, body] }
  async function common(body) {
    const b = body || {};
    if (typeof b.phone_e164 !== 'string' || !/^\+\d{8,15}$/.test(b.phone_e164.trim())) return { err: [400, { error: 'bad_request' }] };
    const p = parseE164(b.phone_e164);
    if (!p) return { err: [400, { error: 'country_not_allowed' }] };
    if (typeof b.restaurant_id !== 'string' || !(await knownRid(b.restaurant_id))) return { err: [400, { error: 'bad_request' }] };   // known, never defaulted
    if (typeof b.cart_fp !== 'string' || !HEX64_RE.test(b.cart_fp)) return { err: [400, { error: 'bad_request' }] };
    const digits = wa().normalizePhone(p.e164);
    if (!digits) return { err: [400, { error: 'bad_request' }] };
    return { e164: p.e164, digits, rid: b.restaurant_id, cartFp: b.cart_fp };
  }

  async function requestCheckoutCode(req, res) {
    let OTP;
    try { OTP = loadOtp(); } catch (e) { console.error('requestCheckoutCode: OTP_SALT misconfigured — failing closed', e.message); return json(res, 500, { ok: false }); }
    try {
      if (req.method !== 'POST') return json(res, 405, { ok: false });
      const c = await common(req.body);
      if (c.err) return json(res, ...c.err);
      const h = OTP.phoneHash(c.digits);
      if (!h) return json(res, 400, { error: 'bad_request' });
      const t = now();
      const db = deps.getDatabase();
      // per-IP: the SHARED otp_ip budget (the same transaction updater requestOtp uses)
      const ipHash = crypto.createHash('sha256').update(String(req.ip || '')).digest('hex');
      const ipTx = await db.ref('otp_ip/' + ipHash).transaction((v) => OTP.ipReserve(v, t));
      if (!ipTx.committed) return json(res, 429, { error: 'rate_limited', retry_in_s: 60 });
      // per-phone: the DURABLE checkout budget, atomically; signup's (non-durable) sends counted (advisor-accepted union)
      let signupSends = [];
      try { const s = await db.ref('otp/' + h + '/sends').get(); signupSends = s.exists() && Array.isArray(s.val()) ? s.val() : []; } catch (_) { signupSends = []; }
      let verdict = null;
      const bTx = await db.ref('otp_budget/' + h).transaction((cur) => { verdict = G.budgetReserve(cur, t, signupSends); return verdict.next; });
      if (!bTx.committed || !verdict || !verdict.ok) return json(res, 429, { error: 'rate_limited', retry_in_s: Math.max(1, Math.ceil(((verdict && verdict.retryInMs) || 1000) / 1000)) });
      const attempt = (bTx.snapshot.val() && Array.isArray(bTx.snapshot.val().sends)) ? bTx.snapshot.val().sends.filter((x) => t - x < G.BUDGET.WINDOW).length : 1;
      // the code: its OWN record, bound to rid + cart_fp (a new request replaces the previous code)
      const code = OTP.genCode();
      await db.ref('checkout_otp/' + h).set({ code_hash: OTP.hashCode(code), expires_at: t + OTP.LIMITS.CODE_TTL, attempts: 0, rid: c.rid, cart_fp: c.cartFp, phone: c.digits });
      const sent = await sendPlatformOtp(c.digits, code, { env: deps.env, fetchImpl: deps.fetchImpl, isSendConfirmed: wa().isSendConfirmed });
      if (!sent.ok) {
        if (sent.reason === 'unconfigured') console.error('requestCheckoutCode: platform sender unconfigured (ULTRAMSG_*_PLATFORM / CHECKOUT_OTP_TEMPLATE) — failing closed');
        return json(res, 502, { error: 'send_failed', attempt, max_attempts: G.BUDGET.MAX_PER_WINDOW });
      }
      return json(res, 200, { ok: true, resend_in_s: RESEND_IN_S });
    } catch (e) {
      console.error('requestCheckoutCode', e);
      return json(res, 502, { error: 'send_failed', attempt: 1, max_attempts: G.BUDGET.MAX_PER_WINDOW });
    }
  }

  async function verifyCheckoutCode(req, res) {
    let OTP;
    try { OTP = loadOtp(); } catch (e) { console.error('verifyCheckoutCode: OTP_SALT misconfigured — failing closed', e.message); return json(res, 500, { ok: false }); }
    try {
      if (req.method !== 'POST') return json(res, 405, { ok: false });
      const c = await common(req.body);
      if (c.err) return json(res, ...c.err);
      const b = req.body;
      if (typeof b.order_id !== 'string' || !G.ORDER_ID_RE.test(b.order_id)) return json(res, 400, { error: 'bad_request' });
      if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) return json(res, 400, { error: 'code_wrong' });
      const h = OTP.phoneHash(c.digits);
      if (!h) return json(res, 400, { error: 'bad_request' });
      const t = now();
      const db = deps.getDatabase();
      // ONE transaction decides. The closure may re-run; only the FINAL run's outcome is used.
      let outcome = null, expiresAt = 0;
      await db.ref('checkout_otp/' + h).transaction((v) => {
        outcome = null;
        if (!v || typeof v !== 'object') { outcome = 'code_expired'; return undefined; }                 // nothing live
        expiresAt = v.expires_at;
        if (v.rid !== c.rid || v.cart_fp !== c.cartFp) { outcome = 'code_wrong'; return undefined; }      // a code for another attempt: no oracle
        if (!(t < v.expires_at)) { outcome = 'code_expired'; return null; }                               // expired ⇒ cleared
        if ((v.attempts || 0) >= OTP.LIMITS.MAX_ATTEMPTS) { outcome = 'too_many_attempts'; return undefined; }
        if (!OTP.constEq(v.code_hash, OTP.hashCode(b.code))) {
          const attempts = (v.attempts || 0) + 1;
          outcome = attempts >= OTP.LIMITS.MAX_ATTEMPTS ? 'too_many_attempts' : 'code_wrong';
          return { ...v, attempts };
        }
        outcome = 'ok';
        return null;                                                                                    // consumed on success
      });
      if (outcome === 'too_many_attempts') return json(res, 429, { error: 'too_many_attempts', retry_in_s: Math.max(1, Math.ceil((expiresAt - t) / 1000)) });
      if (outcome !== 'ok') return json(res, 400, { error: outcome || 'code_wrong' });
      // the order-id-bound ticket (§1.3): no state; single use = the order id itself
      const ticket = G.newTicketId();
      const rec = G.ticketRecord({ phone: c.digits, phoneHash: h, rid: c.rid, cartFp: c.cartFp, orderId: b.order_id, now: t });
      await db.ref('checkout_tickets/' + G.ticketKey(ticket)).set(rec);
      return json(res, 200, { ok: true, checkout_ticket: ticket });
    } catch (e) {
      console.error('verifyCheckoutCode', e);
      return json(res, 400, { error: 'code_wrong' });
    }
  }

  return { requestCheckoutCode, verifyCheckoutCode };
}

// The periodic sweep (the pruneExpired pattern, signup-core.js:269): every expired row is removed in a transaction that
// RE-CHECKS it is still expired (a fresh write since the query is never removed). Tickets after exp; live codes after
// expires_at; a send budget once its newest send has left the window (it holds nothing a new request would count).
async function pruneCheckoutState(db, now) {
  const out = { tickets: 0, codes: 0, budgets: 0 };
  const sweep = async (node, field, cutoff, key) => {
    const rows = (await db.ref(node).orderByChild(field).endAt(cutoff).once('value')).val() || {};
    for (const [id, row] of Object.entries(rows)) {
      if (!row || !(row[field] <= cutoff)) continue;
      const tx = await db.ref(`${node}/${id}`).transaction((cur) => (cur === null ? null : (cur[field] <= cutoff ? null : undefined)));
      if (tx.committed) out[key] += 1;
    }
  };
  await sweep('checkout_tickets', 'exp', now, 'tickets');
  await sweep('checkout_otp', 'expires_at', now, 'codes');
  await sweep('otp_budget', 'last', now - G.BUDGET.WINDOW, 'budgets');
  return out;
}

module.exports = { makeCheckoutOtp, sendPlatformOtp, pruneCheckoutState };
