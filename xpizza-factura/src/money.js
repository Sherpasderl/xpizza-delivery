'use strict';

/**
 * Factura money. ISV 15% is tax-INCLUSIVE: the menu price IS what the customer pays.
 * The factura NEVER recomputes the charged amount — it copies the order's cents fields.
 * These helpers exist so a standalone factura record (or the test harness) can derive the
 * SAME breakdown the platform's priceBreakdownCents() produces, and so per-line bases
 * reconcile EXACTLY to the subtotal (no centavo drift on a fiscal document).
 */

// Mirror of xpizza-functions priceBreakdownCents(): break 15% tax out of an inclusive total.
// Invariant guaranteed: subtotal_cents + isv_cents === total_cents.
function priceBreakdown(totalCents) {
  const total_cents = Math.round(totalCents);
  const isv_cents = Math.round(total_cents - total_cents / 1.15);
  const subtotal_cents = total_cents - isv_cents;
  return { subtotal_cents, isv_cents, total_cents };
}

// Per-line tax-exclusive base (for the PRECIO column). Each base ~ gross/1.15, but the SUM
// is forced to equal subtotalCents exactly by absorbing the rounding residual into the last
// line — so the printed column always foots to SUB TOTAL.
function reconcileLineBases(lineGrossCents, subtotalCents) {
  const bases = lineGrossCents.map((g) => Math.round(g / 1.15));
  const sum = bases.reduce((a, b) => a + b, 0);
  const residual = subtotalCents - sum;
  if (bases.length > 0) {
    bases[bases.length - 1] += residual;
  }
  return bases;
}

module.exports = { priceBreakdown, reconcileLineBases };
