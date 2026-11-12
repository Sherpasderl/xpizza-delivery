'use strict';
// POST recoverOrderAccess (PLAN-sdk-d4-r4 S5, r3 #9, r4) — a guest who lost the checkout ticket finds their order again.
//   { order_id }        ⇒ a WhatsApp code to the ORDER's stored verified phone (never one the caller supplies); the same answer
//                         whether the order exists, is a member's or a guest's (no existence oracle)
//   { order_id, code }  ⇒ { order_ticket }: 30 minutes, status / cancel of THAT order only (order_access_tickets/{sha256});
//                         never a checkout ticket, so never a placement
// Limits: the SHARED otp_ip + otp_budget reservations (checkout's), a 5-minute single-use code, 5 attempts. The sender (one secret,
// SDK_OTP_SENDER) is checked BEFORE any reservation; the send runs the existing sendPlatformOtp with the REAL isSendConfirmed.
// The template is owner-approved copy (OWNER 11-11). Configuration never comes from the plain environment.
const crypto = require('crypto');
const G = require('../../checkout-guest-lib');
const { sendPlatformOtp, platformSenderConfigured } = require('../../checkout-otp');
const RECOVERY_OTP_TEMPLATE = 'El código para ver tu pedido en Sherpa es {code}. Vence en 5 minutos.';
const ORDER_TICKET_TTL_MS = 30 * 60 * 1000;
const CODE_RE = /^\d{6}$/;
const OK = Object.freeze({ ok: true });
// Codex S5 r5: every UNAUTHENTICATED answer is target-independent — the request answers the same 200 for an absent, a member's,
// a claimed or a guest order (a budget hit / an unconfirmed send is recorded internally, never surfaced); the verify answers ONE
// generic failure for wrong / expired / locked / absent / member. Only a CALLER-keyed limit (the IP budget) may answer 429.
const CODE_INVALID = Object.freeze({ status: 400, body: Object.freeze({ error: 'code_invalid' }) });
const suppressed = (reason) => { try { console.warn(`sdk_recovery_suppressed ${JSON.stringify({ reason })}`); } catch (_) { /* never decides */ } };
const ticketKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function senderEnv(cfg) {
  const ok = !!cfg && typeof cfg.instance_id === 'string' && cfg.instance_id && typeof cfg.token === 'string' && cfg.token;
  return ok ? { ULTRAMSG_INSTANCE_ID_PLATFORM: cfg.instance_id, ULTRAMSG_TOKEN_PLATFORM: cfg.token, RECOVERY_OTP_TEMPLATE } : null;
}
// a GUEST target only: an order with customer_uid (a member's, or a guest order a member has CLAIMED) is never guest-recoverable
const guestTarget = (order) => (order && order.payment_flow === 'sdk_auth_v1' && !order.customer_uid && order.guest_verified && typeof order.guest_verified.phone === 'string'
  && typeof order.guest_verified.phone_hash === 'string' ? { digits: order.guest_verified.phone, h: order.guest_verified.phone_hash } : null);

async function recoverOrderAccessCore(deps, { ip, body } = {}) {
  const b = body || {};
  const orderId = b.order_id;
  if (typeof orderId !== 'string' || !G.ORDER_ID_RE.test(orderId)) return { status: 400, body: { error: 'bad_request' } };
  const OTP = deps.OTP || require('../../otp-lib');
  const wa = deps.whatsapp || require('../../whatsapp');
  const db = deps.db;
  const t = deps.clock();
  if (b.code === undefined) {
    // ── request a code ──
    const env = senderEnv(deps.senderConfig ? deps.senderConfig() : null);
    if (!env || !platformSenderConfigured(env, 'RECOVERY_OTP_TEMPLATE')) return { status: 503, body: { error: 'recovery_unavailable' } };   // BEFORE any reservation
    const ipHash = crypto.createHash('sha256').update(String(ip || '')).digest('hex');
    const ipTx = await db.ref('otp_ip/' + ipHash).transaction((v) => OTP.ipReserve(v, t));
    if (!ipTx.committed) return { status: 429, body: { error: 'rate_limited', retry_in_s: 60 } };
    const target = guestTarget((await db.ref(`orders/${orderId}`).once('value')).val());
    if (!target) return { status: 200, body: { ...OK } };   // absent / a member's / not SDK: the same answer, nothing sent
    let signupSends = [];
    try { const s = await db.ref('otp/' + target.h + '/sends').once('value'); const v = s.val(); signupSends = Array.isArray(v) ? v : []; } catch (_) { signupSends = []; }
    let verdict = null;
    const bTx = await db.ref('otp_budget/' + target.h).transaction((cur) => { verdict = G.budgetReserve(cur, t, signupSends); return verdict.next; });
    if (!bTx.committed || !verdict || !verdict.ok) { suppressed('phone_budget'); return { status: 200, body: { ...OK } }; }
    const code = OTP.genCode();
    await db.ref(`order_recovery_otp/${orderId}`).set({ code_hash: OTP.hashCode(code), expires_at: t + OTP.LIMITS.CODE_TTL, attempts: 0, phone_hash: target.h });
    const sent = await sendPlatformOtp(target.digits, code, { env, fetchImpl: deps.fetchImpl, isSendConfirmed: wa.isSendConfirmed, templateKey: 'RECOVERY_OTP_TEMPLATE' });
    if (!sent.ok) suppressed('send_unconfirmed');
    return { status: 200, body: { ...OK } };
  }
  // ── verify the code ⇒ an order ticket ──
  if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) return { status: CODE_INVALID.status, body: { ...CODE_INVALID.body } };
  const target = guestTarget((await db.ref(`orders/${orderId}`).once('value')).val());
  let outcome = null;
  await db.ref(`order_recovery_otp/${orderId}`).transaction((v) => {
    outcome = null;
    if (v === null) { outcome = 'code_expired'; return null; }   // the speculative first pass: null stays null
    if (typeof v !== 'object' || !target || v.phone_hash !== target.h) { outcome = 'code_wrong'; return undefined; }
    if (!(t < v.expires_at)) { outcome = 'code_expired'; return null; }
    if ((v.attempts || 0) >= OTP.LIMITS.MAX_ATTEMPTS) { outcome = 'too_many_attempts'; return undefined; }
    if (!OTP.constEq(v.code_hash, OTP.hashCode(b.code))) {
      const attempts = (v.attempts || 0) + 1;
      outcome = attempts >= OTP.LIMITS.MAX_ATTEMPTS ? 'too_many_attempts' : 'code_wrong';
      return { ...v, attempts };
    }
    outcome = 'ok';
    return null;   // consumed on success (single use)
  });
  if (outcome !== 'ok' || !target) return { status: CODE_INVALID.status, body: { ...CODE_INVALID.body } };   // one generic failure (no retry hint)
  const ticket = 'ot_' + crypto.randomBytes(16).toString('hex');
  await db.ref(`order_access_tickets/${ticketKey(ticket)}`).set({ order_id: orderId, phone_hash: target.h, exp: t + ORDER_TICKET_TTL_MS });
  return { status: 200, body: { order_ticket: ticket } };
}
module.exports = { recoverOrderAccessCore, RECOVERY_OTP_TEMPLATE, ORDER_TICKET_TTL_MS, ticketKey };
