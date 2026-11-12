'use strict';
// D4 §A2 B1 + B2 (PLAN-sdk-d4-r11) — the SDK intake's request-facing steps, called by chargeOnlineOrder's handler in SDK mode
// (res.locals.sdkMode, set ONLY by placeSdkApp's middleware). Pure over its deps; mutates req.headers / req.body as B1 specifies.
//   authorize(req, deps) ⇒ { ok: true, kind: 'member', uid } | { ok: true, kind: 'guest' } | { refuse: { status, body } }
//   replay(deps, { orderId, attemptId, uid, guestPhoneHash }) ⇒ { status, body } | null (fall through)
const G = require('../../checkout-guest-lib');
const F = require('./flow');
const C = require('./coordinator');
const TICKET_RE = /^ct_[0-9a-f]{32}$/;   // checkout-guest-lib newTicketId
const ATTEMPT_RE = /^[A-Za-z0-9_-]{8,64}$/;
const refuse = (status, error) => ({ refuse: { status, body: { error } } });
const BEARER_RE = /^Bearer\s+(\S+)$/;

async function authorize(req, deps) {
  const h = req.headers || (req.headers = {});
  const body = req.body && typeof req.body === 'object' ? req.body : (req.body = {});
  h['x-client-deployment'] = 'orders-app';                                    // B1.0: FIRST, for both credential kinds
  const m = typeof h.authorization === 'string' ? h.authorization.match(BEARER_RE) : null;
  const bearer = m ? m[1] : null;
  const tHdr = h['x-sherpa-order-ticket']; const tBody = body.checkout_ticket;
  const hasTicket = tHdr != null || tBody != null;
  delete h['x-firebase-id-token'];                                            // B1.2: downstream sees only what B1 puts there
  if (bearer && hasTicket) return refuse(401, 'mixed_credentials');            // B1.1: exactly ONE credential kind
  if (!bearer && !hasTicket) return refuse(401, 'guest_auth_required');
  let out;
  if (bearer) {                                                                // B1.3: the member, NO fail-open
    let dec;
    try {
      dec = await Promise.race([
        (async () => { const d = await deps.verifyIdToken(bearer); return { d, tomb: d && d.uid ? await deps.isTombstoned(d.uid) : false }; })(),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), deps.deadlineMs || 1500)),
      ]);
    } catch (_) { return refuse(401, 'auth_invalid'); }
    if (dec === 'timeout') return refuse(503, 'auth_unavailable');
    const uid = deps.attributionUid(dec.d, dec.tomb);
    if (!uid) return refuse(401, 'auth_invalid');
    h['x-firebase-id-token'] = bearer;                                         // the unchanged downstream re-verification
    out = { ok: true, kind: 'member', uid };
  } else {                                                                     // B1.4: the guest ticket, validated HERE
    if (tHdr != null && tBody != null && tHdr !== tBody) return refuse(401, 'guest_auth_required');   // CONTRACT-Δ C2
    const ticket = tHdr != null ? tHdr : tBody;
    if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return refuse(401, 'guest_ticket_invalid');
    const { restaurantId } = deps.ridOf(body);
    const orderId = typeof body.order_id === 'string' ? body.order_id : null;
    const digits = typeof body.customer_phone === 'string' ? deps.normalizePhone(body.customer_phone) : null;
    const phoneHash = digits ? deps.phoneHash(digits) : null;
    const cartFp = await deps.cartFpFromBody(body);
    const rec = (await deps.db.ref(`checkout_tickets/${G.ticketKey(ticket)}`).once('value')).val();
    if (!restaurantId || !orderId || !G.ticketValid(rec, { now: deps.clock(), rid: restaurantId, orderId, cartFp, phoneHash })) return refuse(401, 'guest_ticket_invalid');
    body.checkout_ticket = ticket;
    out = { ok: true, kind: 'guest' };
  }
  if (body.entry_mode === undefined) body.entry_mode = 'app';                  // B1.6: app semantics, server-side
  else if (body.entry_mode !== 'app') return refuse(400, 'entry_mode');
  if (body.redeem != null) return refuse(400, 'redeem_not_available');          // B1.7: SDK card orders never redeem (§A00)
  return out;
}

async function replay(deps, { orderId, attemptId, uid = null, guestPhoneHash = null } = {}) {
  if (typeof attemptId !== 'string' || !ATTEMPT_RE.test(attemptId)) return null;
  const order = await C.readOrder(deps.db, orderId);
  if (!F.isSdkOrder(order)) return null;
  const owner = uid ? order.customer_uid === uid
    : !order.customer_uid && typeof guestPhoneHash === 'string' && !!order.guest_verified && order.guest_verified.phone_hash === guestPhoneHash;
  if (!owner) return null;
  const rec = await C.readRecord(deps.db, orderId);
  if (!(rec && rec.attempts && rec.attempts[attemptId])) return null;
  return require('./status-endpoint').answerOrder(deps, orderId, order, { attempt_id: attemptId });
}
module.exports = { authorize, replay, TICKET_RE };
