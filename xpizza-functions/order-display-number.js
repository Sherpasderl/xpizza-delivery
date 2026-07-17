'use strict';
/**
 * Pure core for the per-restaurant daily order `display_number` (docs/superpowers/specs/
 * 2026-07-16-order-display-number-design.md · Core). A cosmetic, human-speakable label (#47) so staff can
 * reference an order verbally — NEVER a key. SEPARATE from the factura allocator (no money-path entanglement),
 * though it mirrors factura/allocate.js's idempotent seq shape.
 *
 * Counter node: /counters/order_display_seq/{restaurant_id}/{YYYY-MM-DD} = { last:<int>, by_order:{ [orderId]:<int> } }
 * The RTDB transaction runs decideDisplayNumber(node, orderId) and commits `.next` (or aborts on the idempotent
 * no-op). Pure ⇒ idempotency + concurrency are provable without a DB.
 */

// Idempotent per-order allocation within ONE transaction (mirrors factura decideReserve's pending[orderId] shape).
// Pure ALLOCATE decision — used ONLY inside the transaction on the live/Sale transition (F1: the trigger gates
// the call on isTransition, so this only ever mints on a real transition). The HEAL path (re-stamping an
// existing reservation on a later write) is a direct READ in the trigger, NOT this transaction: an RTDB
// transaction that aborts (returns undefined) on its initial null-cache run does not re-fetch the server value,
// so a heal-via-transaction would miss the reservation. Allocate is safe under that null-run because it COMMITS
// (returns .next) → on contention RTDB re-runs with the true server value (idempotent by_order[orderId] then wins).
function decideDisplayNumber(node, orderId){
  const by_order = (node && node.by_order) || {};
  if (by_order[orderId] != null) {
    // Already reserved → return the SAME number, no write (ABORT). Idempotent on any retry / concurrent handler.
    return { number: by_order[orderId], next: undefined };
  }
  const last = node && Number.isFinite(node.last) ? node.last : 0;   // fail-safe: absent/malformed last → 0
  const n = last + 1;
  return { number: n, next: { last: n, by_order: { ...by_order, [orderId]: n } } };
}

// Eligibility — a near-clone of facturaSaleEligible minus the factura-specific factura_status/cutoff. Fires when
// the order is in the live/Sale state ('new'); an ONLINE order must be payment-confirmed. A hidden
// pending_payment order has status='pending_payment' (never 'new'), so failed/abandoned payments burn no number;
// scheduled orders get numbered on RELEASE (when they reach 'new'), not at checkout.
function displayNumberEligible(after){
  if (!after) return false;
  if (after.status !== 'new') return false;
  if (after.payment_method === 'online' && after.payment_status !== 'confirmed') return false;
  return true;
}

module.exports = { decideDisplayNumber, displayNumberEligible };
