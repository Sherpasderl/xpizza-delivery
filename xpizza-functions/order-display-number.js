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

// The label is a NON-SEQUENTIAL 3-digit number (100–999). It was `last + 1` — a running daily count — which
// leaked the restaurant's order VOLUME to the customer ("Pedido #2" reads as "they've sold almost nothing
// today"). It is a human-speakable reference only (staff ↔ customer), so it must be UNIQUE within the day for
// an unambiguous call-out, but it must NOT be an ordinal. Nothing internal counts by it (verified: no cuadre/
// report/sort/dedup consumer), and it is on NEITHER factura number, so a random label is safe. Brand-agnostic:
// both restaurants get the obscured number from the same core.
const DISPLAY_LO = 100, DISPLAY_HI = 999;   // inclusive 3-digit range (900 slots per restaurant-day)

// Idempotent per-order allocation within ONE transaction (mirrors factura decideReserve's pending[orderId] shape).
// Pure ALLOCATE decision — used ONLY inside the transaction on the live/Sale transition (F1: the trigger gates
// the call on isTransition, so this only ever mints on a real transition). The HEAL path (re-stamping an
// existing reservation on a later write) is a direct READ in the trigger, NOT this transaction: an RTDB
// transaction that aborts (returns undefined) on its initial null-cache run does not re-fetch the server value,
// so a heal-via-transaction would miss the reservation. Allocate is safe under that null-run because it COMMITS
// (returns .next) → on contention RTDB re-runs with the true server value: either by_order[orderId] now wins
// idempotently, or a fresh random is drawn against the UPDATED used-set (serialized txn ⇒ no collision).
//
// `randInt(lo, hi)` → uniform integer in [lo, hi] inclusive (injected for determinism in tests; the trigger
// passes a crypto source). Collision handling: draw randoms avoiding the day's used numbers; on a dense day
// where randoms keep colliding, fall back to the lowest unused number (still scattered among the randoms, never
// an order-count); if all 900 are taken (>900 orders in one restaurant-day) return number:null → the trigger
// fails open and the order simply shows its order_id, exactly as when the counter is unavailable.
function decideDisplayNumber(node, orderId, randInt){
  const by_order = (node && node.by_order) || {};
  if (by_order[orderId] != null) {
    // Already reserved → return the SAME number, no write (ABORT). Idempotent on any retry / concurrent handler.
    return { number: by_order[orderId], next: undefined };
  }
  const used = new Set(Object.values(by_order).map(Number));
  const ri = typeof randInt === 'function'
    ? randInt
    : (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));   // fail-safe default (cosmetic label, not a secret)
  let n = null;
  for (let i = 0; i < 40 && n === null; i++) {
    const c = ri(DISPLAY_LO, DISPLAY_HI);
    if (Number.isInteger(c) && c >= DISPLAY_LO && c <= DISPLAY_HI && !used.has(c)) n = c;   // reject out-of-range/dup draws
  }
  if (n === null) {   // dense day: deterministic lowest-unused (serialized txn keeps concurrent handlers distinct)
    for (let c = DISPLAY_LO; c <= DISPLAY_HI && n === null; c++) if (!used.has(c)) n = c;
  }
  if (n === null) return { number: null, next: undefined };   // exhausted (>900/day) → fail-open, no number
  return { number: n, next: { last: n, by_order: { ...by_order, [orderId]: n } } };   // `last` = last-assigned (record only)
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

module.exports = { decideDisplayNumber, displayNumberEligible, DISPLAY_LO, DISPLAY_HI };
