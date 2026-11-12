'use strict';
// C2 / C3 for calls on an EXISTING order (status, cancel) — PLAN-sdk-d4-r5 §1. Fail-closed:
//   member: `Authorization: Bearer <Firebase ID token>`, verified; the uid must equal the order's customer_uid, else 404 —
//           identical for a foreign and an absent order (no existence leak); an invalid token ⇒ 401, NEVER a guest fallback.
//   guest:  `X-Sherpa-Order-Ticket` — the checkout ticket record (checkout_tickets/{sha256(ticket)}): unexpired, bound to THIS
//           order_id, and its phone hash equal to the ORDER's stored guest_verified.phone_hash; anything else ⇒ 401.
const { ticketKey } = require('../../checkout-guest-lib');
const NOT_FOUND = Object.freeze({ ok: false, status: 404 });
const GUEST_REQUIRED = Object.freeze({ ok: false, status: 401, error: 'guest_auth_required' });

async function authorizeExistingOrder(deps, { authorization, ticket } = {}, orderId) {
  const bearer = typeof authorization === 'string' && /^Bearer\s+\S+$/.test(authorization) ? authorization.replace(/^Bearer\s+/, '') : null;
  const order = (await deps.db.ref(`orders/${orderId}`).once('value')).val();
  if (bearer) {
    let uid = null;
    try { const d = await deps.verifyIdToken(bearer); uid = d && typeof d.uid === 'string' ? d.uid : null; } catch (_) { uid = null; }
    if (!uid) return { ok: false, status: 401, error: 'auth_invalid' };
    if (!order || order.customer_uid !== uid) return { ...NOT_FOUND };
    return { ok: true, uid };
  }
  if (typeof ticket !== 'string' || !ticket) return { ...GUEST_REQUIRED };
  // the checkout ticket, or (S5) a recovery-issued ORDER ticket (order_access_tickets) — both bound to this order + its phone hash.
  // Codex S5 r5: an order with customer_uid (a member's, or CLAIMED by a member) is NEVER guest-authorizable — checked on the
  // CURRENT order, so a ticket minted before the claim is refused too.
  if (order && order.customer_uid) return { ...GUEST_REQUIRED };
  const gv = order && order.guest_verified;
  const valid = (rec) => !!rec && Number.isFinite(rec.exp) && deps.clock() < rec.exp && rec.order_id === orderId && !!gv && typeof gv.phone_hash === 'string' && rec.phone_hash === gv.phone_hash;
  const key = ticketKey(ticket);
  if (valid((await deps.db.ref(`checkout_tickets/${key}`).once('value')).val())) return { ok: true, guest: true };
  if (valid((await deps.db.ref(`order_access_tickets/${key}`).once('value')).val())) return { ok: true, guest: true };
  return { ...GUEST_REQUIRED };
}
module.exports = { authorizeExistingOrder };
