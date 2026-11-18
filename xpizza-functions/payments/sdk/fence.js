'use strict';
// THE SDK cancel fence (PLAN-sdk-fence-r1, APPROVED 2026-11-13) — sdk_fence/{sha256(order_id + "\n" + owner)} = { order_id, owner, at },
// owner = the C6 subject key (u_<uid> | p_<phone_hash>). Written create-once by cancelSdkPending when the caller's order is ABSENT (or
// foreign: absent ≡ foreign), BEFORE its re-read of the order; read by finishSdk before its first write and again right after its
// create-once order (store-then-check on both sides ⇒ whichever side reads second sees the other). PERMANENT (Codex plan r1 P1): never
// pruned, so no later request under (order_id, owner) — a same-attempt resend, a second device, a re-issued ticket — ever authorizes.
// Owner-keyed: another caller's fence never refuses this owner's order. Server-only node (rules-clauses D4_SERVER_ONLY).
const crypto = require('crypto');
const { subjectKey } = require('./subject');
const { ticketKey } = require('../../checkout-guest-lib');

const fenceKey = (orderId, owner) => crypto.createHash('sha256').update(`${orderId}\n${owner}`).digest('hex');
const ownerOf = ({ uid = null, phoneHash = null } = {}) => subjectKey({ uid, phoneHash });

// create-once; a re-fence is a no-op. A failed write THROWS (the caller answers 503, never safe_to_switch:true unfenced)
async function writeFence(deps, orderId, owner) {
  if (typeof owner !== 'string' || !owner) throw new Error('writeFence: owner is required');
  const at = deps.clock();
  await deps.db.ref(`sdk_fence/${fenceKey(orderId, owner)}`).transaction((cur) => (cur == null ? { order_id: orderId, owner, at } : undefined));
}
// no owner ⇒ no fence can exist for the caller (every fence write names one)
async function isFenced(db, orderId, owner) {
  if (typeof owner !== 'string' || !owner) return false;
  return (await db.ref(`sdk_fence/${fenceKey(orderId, owner)}`).once('value')).val() != null;
}
// the guest extension: an ABSENT order + the header's checkout ticket, unexpired and bound to THIS order id ⇒ that phone's owner; else null
async function guestOwnerForAbsent(deps, ticket, orderId) {
  if (typeof ticket !== 'string' || !ticket) return null;
  const rec = (await deps.db.ref(`checkout_tickets/${ticketKey(ticket)}`).once('value')).val();
  if (!rec || !Number.isFinite(rec.exp) || !(deps.clock() < rec.exp) || rec.order_id !== orderId || typeof rec.phone_hash !== 'string' || !rec.phone_hash) return null;
  return ownerOf({ phoneHash: rec.phone_hash });
}
// the order belongs to the fenced owner key — the SAME identity rule as C6 / authorizeExistingOrder (a member's customer_uid; a guest
// order — never a member's / claimed one — whose verified phone hash is the key's)
function ownedByKey(order, owner) {
  if (!order || typeof owner !== 'string') return false;
  if (owner.startsWith('u_')) return order.customer_uid === owner.slice(2);
  if (owner.startsWith('p_')) return !order.customer_uid && !!order.guest_verified && order.guest_verified.phone_hash === owner.slice(2);
  return false;
}
module.exports = { fenceKey, ownerOf, writeFence, isFenced, guestOwnerForAbsent, ownedByKey };
