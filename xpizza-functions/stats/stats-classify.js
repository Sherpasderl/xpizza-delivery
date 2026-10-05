'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — order classification (PLAN-stats rev 4, §S1.1; owner Q4).
//
// SALE IS THE PLATFORM'S [[Sale]] (CONTEXT.md:88-96, ADR-0003, factura/eligibility.js:13), NOT an
// invented rule:
//   • a non-online order (cash / card_delivery) is a Sale from CREATION;
//   • an `online` order only once its card capture is CONFIRMED — never while `pending_payment`, but
//     including the confirmed → `scheduled` hold and `releasing` before release materializes it;
//   • a CANCELLED order is never consummated (a paid online order is refunded).
// isSale() implements the glossary over the order's WHOLE LIFE. facturaSaleEligible is the factura
// ISSUANCE trigger: it fires only at ENTRY into Sale state (`status === 'new'`) and rejects every later
// status, so it cannot judge a historical order. The tests check agreement with it at entry only, then
// persistence through the lifecycle independently.
//
// classifyOrder() is an ORDERED decision table over (payment_method, status, payment_status — including
// ABSENT). The FIRST matching row wins. Every reachable combination is enumerated in
// stats-classify.test.js (sourced from the writers, file:line); an uncovered one fails that test, and
// in production lands in UNRESOLVED (shown, never silently counted as a sale).
// ---------------------------------------------------------------------------

const CLASS = Object.freeze({
  SALE: 'sale',
  REFUNDED: 'refunded',
  REFUND_PENDING: 'refund_pending',
  UNRESOLVED: 'unresolved',
  EXCLUDED: 'excluded',
  CANCELLED: 'cancelled',
});

// payment_status values meaning "a human or a recovery must still decide what happened to the money".
// Row 3. `resolving_*` is written dynamically ('resolving_' + action, manual-resolve.js:49; actions at
// :21), so it is matched by prefix rather than listed.
const UNRESOLVED_PAYMENT = new Set(['manual_reconciliation', 'manual_review']);
const isResolving = (ps) => typeof ps === 'string' && ps.startsWith('resolving_');

// Row 2. `refunding_paid_after_close` (materialize-guard.js:149) is a PAID order whose refund is in
// flight; its only exits are refunded / refund_pending. ADVISOR RULING Q-C (2026-10-05).
const REFUND_PENDING_PAYMENT = new Set(['refund_pending', 'refunding_paid_after_close']);

// Never-paid online states. Row 4.
const NEVER_PAID_ONLINE = new Set(['pending', 'failed']);

// Statuses that are "live or terminal-fulfilled" — a Sale persists through all of them.
const SALE_LIFE_STATUSES = new Set(['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed', 'scheduled', 'releasing']);
const FULFILLED_STATUSES = new Set(['delivered', 'completed']);

const isOnline = (o) => o && o.payment_method === 'online';
const hasPs = (o) => o && o.payment_status != null && o.payment_status !== '';

/**
 * isSale(order) — the glossary, over the order's life. True while the order is in Sale state; false
 * once cancelled/refunded, and false while an online capture is unconfirmed.
 * Non-online: any status in the Sale life (from creation). ADVISOR RULING Q-A (2026-10-05): ANY non-online
 * method — incl. '' (index.js:524-525) and legacy strings like 'card' — follows the cash rule, matching
 * facturaSaleEligible at entry (it special-cases only online); counted under by_payment.other.
 * Online: payment_status === 'confirmed' AND status ∉ {pending_payment, cancelled}.
 */
function isSale(order) {
  if (!order || typeof order !== 'object') return false;
  const st = order.status;
  if (isOnline(order)) {
    return order.payment_status === 'confirmed' && SALE_LIFE_STATUSES.has(st);
  }
  if (hasPs(order)) return false;     // a non-online order never carries payment_status (cancel passes null, cancel-order.js:123)
  return SALE_LIFE_STATUSES.has(st);
}

const isFulfilled = (order) => !!order && FULFILLED_STATUSES.has(order.status);

// THE ORDERED DECISION TABLE. Each row returns a class or null (fall through). Exported so the test can
// assert precedence row by row.
const ROWS = [
  ['1 refunded', (o) => (o.payment_status === 'refunded' ? CLASS.REFUNDED : null)],
  ['2 refund pending', (o) => (REFUND_PENDING_PAYMENT.has(o.payment_status) ? CLASS.REFUND_PENDING : null)],
  ['3 manual/resolving/review', (o) => ((UNRESOLVED_PAYMENT.has(o.payment_status) || isResolving(o.payment_status)) ? CLASS.UNRESOLVED : null)],
  ['4 abandoned / never paid pending_payment', (o) => {
    if (o.status === 'cancelled' && o.payment_status === 'abandoned') return CLASS.EXCLUDED;            // resolve-manual.js:146
    if (o.status === 'pending_payment' && (o.payment_status == null || NEVER_PAID_ONLINE.has(o.payment_status) || o.payment_status === 'confirmed')) {
      // incl. the transient confirmed + pending_payment window (pixelpay-confirm.js:244) before
      // materialize — it becomes a Sale once it LEAVES pending_payment.
      return CLASS.EXCLUDED;
    }
    return null;
  }],
  // ADVISOR RULING Q-B (2026-10-05): an online order cancelled while NEVER PAID (dispatcher cancel of a
  // pending_payment order; finalize leaves payment_status untouched, cancel-order-core.js:48) was never
  // a Sale and took no money — EXCLUDED, BEFORE the generic cancelled row.
  ['4b cancelled never-paid online', (o) => ((o.status === 'cancelled' && isOnline(o) && NEVER_PAID_ONLINE.has(o.payment_status)) ? CLASS.EXCLUDED : null)],
  ['5 cancelled', (o) => (o.status === 'cancelled' ? CLASS.CANCELLED : null)],
  ['6 sale', (o) => (isSale(o) ? CLASS.SALE : null)],
];

function classifyOrder(order) {
  if (!order || typeof order !== 'object') return CLASS.UNRESOLVED;
  for (const [, row] of ROWS) {
    const c = row(order);
    if (c) return c;
  }
  return CLASS.UNRESOLVED;   // fall-through (plan row 7)
}

// Which row decided, by label (for the test and diagnostics). 'fallthrough' = the UNRESOLVED catch-all.
function decidingRow(order) {
  for (const [label, row] of ROWS) if (row(order)) return label;
  return 'fallthrough';
}

module.exports = { CLASS, ROWS, isSale, isFulfilled, classifyOrder, decidingRow, SALE_LIFE_STATUSES, FULFILLED_STATUSES };
