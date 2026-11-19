'use strict';
// PLAN-3a-order-owner r0 (advisor APPROVED 2026-11-18; owner §5 = A; rule 6c) — WHO may be answered with an EXISTING order's
// capabilities (createOrder's idempotent tracking_token; the card charge handler's live checkout + poll token). ONE pure predicate, run
// on the order snapshot each handler already read (no I/O):
//   owner        the request's VERIFIED uid is the order's customer_uid                 → today's answer, the token included
//   non_owner    a DIFFERENT verified identity: another uid on a member's order, or any → the constant 409 order_exists (the
//                uid on a verified guest's order (guest_verified, card charge handler)    neutral reason): no state, no token
//   unverifiable no verified identity presented (incl. the forms' 1.5 s token-fetch    → today's answer, WITHOUT createOrder's
//                timeout — rule 27), or a FORM guest's order (none was ever verified)    tracking_token (owner-accepted §5 = A)
// A capp guest's ticket is checked where it already is (checkout-guest-gate chargeGate / boundToGuest): never twice (rule 6c).
const NON_OWNER_REASON = 'conflict';   // order-exists ORDER_EXISTS_REASONS' neutral member

function ownerOf(order, uid) {
  if (typeof uid !== 'string' || !uid) return 'unverifiable';
  const o = order && typeof order === 'object' ? order : {};
  if (typeof o.customer_uid === 'string' && o.customer_uid) return o.customer_uid === uid ? 'owner' : 'non_owner';
  if (o.guest_verified) return 'non_owner';
  return 'unverifiable';
}

module.exports = { ownerOf, NON_OWNER_REASON };
