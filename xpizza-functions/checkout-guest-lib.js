'use strict';
// ── PLAN-guest-checkout-server (r4) — the PURE core of the capp guest checkout. No I/O: the handlers (S1/S2) call these
// inside their reads / RTDB transactions, and the unit tests exercise exactly the same functions.
//   • isCappGuest(clientHdr, uid)            the S2 discriminator — deployment === 'orders-app' && uid === null, nothing else
//   • budgetReserve(cur, now, signupSends)   the durable per-phone checkout send budget (otp_budget/{h}), a txn updater
//   • ticketRecord(...) / ticketValid(...)   the order-id-bound checkout ticket (§1.3 / §2.3) — no state, a READ-ONLY check
//   • signGrant / verifyGrant               the stateless signed SIGNUP GRANT (§2.5): HMAC(order_id ‖ phone_hash ‖ exp)
const crypto = require('crypto');

const CAPP_DEPLOYMENT = 'orders-app';
const TICKET_TTL_MS = 15 * 60e3;
const GRANT_TTL_MS = 15 * 60e3;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // the createOrder body rule (index.js:612)
const HEX64_RE = /^[0-9a-f]{64}$/;
const BUDGET = Object.freeze({ WINDOW: 10 * 60e3, MIN_GAP: 30e3, MAX_PER_WINDOW: 3 });   // the shared per-phone limits (otp-lib LIMITS)

// S2 — keyed ONLY on the stamped deployment + an unresolved identity. An absent / malformed / unknown header is already null
// from client-floor.readClientHeaders ⇒ false ⇒ today's behaviour exactly. Strict `=== null` (a member's uid is a string).
function isCappGuest(clientHdr, uid) {
  return !!clientHdr && clientHdr.deployment === CAPP_DEPLOYMENT && uid === null;
}

// S1 §1.2 — the checkout send budget, a PURE RTDB-transaction updater on otp_budget/{h} = {sends:[ts]}. `signupSends` is the
// signup record's current otp/{h}.sends, read just before the txn (the ADVISOR-ACCEPTED union: non-durable, ≤1 overshoot).
// → { next, ok, retryInMs } ; `next` is undefined when refused (abort the txn: no write).
function budgetReserve(cur, now, signupSends = []) {
  const own = (cur && Array.isArray(cur.sends) ? cur.sends : []).filter((t) => Number.isFinite(t) && now - t < BUDGET.WINDOW);
  const other = (Array.isArray(signupSends) ? signupSends : []).filter((t) => Number.isFinite(t) && now - t < BUDGET.WINDOW);
  const all = own.concat(other).sort((a, b) => a - b);
  const last = all.length ? all[all.length - 1] : -Infinity;
  if (now - last < BUDGET.MIN_GAP) return { next: undefined, ok: false, retryInMs: BUDGET.MIN_GAP - (now - last) };
  if (all.length >= BUDGET.MAX_PER_WINDOW) return { next: undefined, ok: false, retryInMs: Math.max(1, all[all.length - BUDGET.MAX_PER_WINDOW] + BUDGET.WINDOW - now) };
  return { next: { sends: own.concat([now]), last: now }, ok: true, retryInMs: 0 };   // only OWN sends persist; never deleted by a verify; `last` indexes the age prune
}

// S2 §2.2 / §2.3 — the capp-guest gate's BODY refusals, in order (the ticket check is separate: it needs a read). Pure; the
// gate calls it only when isCappGuest(…) is true, BEFORE any write. → a reason code | null.
//   1. payment: anything but 'online' ⇒ guest_cash_not_allowed (guests are card-online only — D4 CLOSED, owner 10-27);
//   2. scheduling requires an account (owner rule, S4 frame G = B): a body CARRYING scheduled_for (any non-empty value,
//      even malformed) ⇒ guest_schedule_requires_account;
//   3. the email (the chargeOnlineOrder rule, index.js:2210) ⇒ guest_email_required.
const GUEST_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function guestBodyRefusal(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.payment_method !== 'online') return 'guest_cash_not_allowed';
  if (b.scheduled_for !== undefined && b.scheduled_for !== null && b.scheduled_for !== '') return 'guest_schedule_requires_account';
  if (typeof b.customer_email !== 'string' || !GUEST_EMAIL_RE.test(b.customer_email.trim())) return 'guest_email_required';
  return null;
}

// S1 §1.3 — the ticket record (stored at checkout_tickets/{sha256(ticket)}); NO state field (r3: single use = the order id).
function ticketRecord({ phone, phoneHash, rid, cartFp, orderId, now }) {
  if (typeof phone !== 'string' || !phone || typeof phoneHash !== 'string' || !HEX64_RE.test(phoneHash)) throw new Error('ticketRecord: bad phone');
  if (typeof rid !== 'string' || !rid) throw new Error('ticketRecord: bad rid');
  if (typeof cartFp !== 'string' || !HEX64_RE.test(cartFp)) throw new Error('ticketRecord: bad cart_fp');
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) throw new Error('ticketRecord: bad order_id');
  return { phone, phone_hash: phoneHash, rid, cart_fp: cartFp, order_id: orderId, exp: now + TICKET_TTL_MS };
}
const newTicketId = () => 'ct_' + crypto.randomBytes(16).toString('hex');
const ticketKey = (ticket) => crypto.createHash('sha256').update(String(ticket)).digest('hex');

// S2 §2.3 — the READ-ONLY gate check. ONE boolean (the caller answers one reason, guest_ticket_invalid: no oracle).
// `phoneHash` = OTP.phoneHash(body.customer_phone); `cartFp` = the server's recompute of the capp's cartSig (§1.4).
function ticketValid(rec, { now, rid, orderId, cartFp, phoneHash }) {
  if (!rec || typeof rec !== 'object') return false;
  if (!Number.isFinite(rec.exp) || !(now < rec.exp)) return false;
  return rec.rid === rid && rec.order_id === orderId && typeof cartFp === 'string' && rec.cart_fp === cartFp
    && typeof phoneHash === 'string' && rec.phone_hash === phoneHash;
}

// S2 §2.5 / S3b §3.2 — the stateless SIGNUP GRANT. The quote-token design (quote-token.js:171): the HMAC covers the EXACT
// transmitted payload bytes; the signature is checked BEFORE any payload field is believed; the verifier NEVER throws.
// The payload is deterministic from the order (order_id, phone_hash, exp = created_at + 15 min), so a replay recomputes the
// SAME bytes — no publication record, no TTL reset.
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function grantPayload(orderId, phoneHash, createdAtMs) {
  return { order_id: String(orderId), phone_hash: String(phoneHash), exp: createdAtMs + GRANT_TTL_MS };
}
function signGrant(payload, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('signGrant: SIGNUP_GRANT_SECRET missing or too short (fail-closed)');
  // fixed key order ⇒ the same order yields the same bytes on every replay
  const body = Buffer.from(JSON.stringify({ order_id: payload.order_id, phone_hash: payload.phone_hash, exp: payload.exp }));
  return 'sg.' + b64u(body) + '.' + b64u(crypto.createHmac('sha256', secret).update(body).digest());
}
// → { ok, reason, payload } ; reason ∈ { ok, bad_format, bad_signature, expired }. Never throws.
function verifyGrant(token, secret, nowMs) {
  const bad = (reason) => ({ ok: false, reason, payload: null });
  try {
    if (typeof secret !== 'string' || secret.length < 32) return bad('bad_signature');
    if (typeof token !== 'string' || !token.startsWith('sg.')) return bad('bad_format');
    const parts = token.slice(3).split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return bad('bad_format');
    const body = unb64u(parts[0]), sig = unb64u(parts[1]);
    const want = crypto.createHmac('sha256', secret).update(body).digest();
    if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return bad('bad_signature');   // signature FIRST
    const p = JSON.parse(body.toString('utf8'));
    if (!p || typeof p.order_id !== 'string' || !ORDER_ID_RE.test(p.order_id) || typeof p.phone_hash !== 'string' || !HEX64_RE.test(p.phone_hash) || !Number.isFinite(p.exp)) return bad('bad_format');
    if (!(nowMs < p.exp)) return bad('expired');
    return { ok: true, reason: 'ok', payload: p };
  } catch (_) { return bad('bad_format'); }
}

module.exports = { CAPP_DEPLOYMENT, TICKET_TTL_MS, GRANT_TTL_MS, BUDGET, ORDER_ID_RE, isCappGuest, guestBodyRefusal, budgetReserve,
  ticketRecord, newTicketId, ticketKey, ticketValid, grantPayload, signGrant, verifyGrant };
