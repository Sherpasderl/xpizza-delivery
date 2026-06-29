'use strict';

const { usesPlatformFactura } = require('./factura/eligibility');

// ---------------------------------------------------------------------------
// Canonical money. `total_cents` (integer HNL centavos) is the source of truth
// for charges + comparisons. ISV 15% is tax-INCLUSIVE: the menu price IS what
// the customer pays, so we break the tax OUT of the total with a fixed rounding
// rule that guarantees subtotal_cents + tax_cents === total_cents exactly.
// (Stored on EVERY order — cash too — so the factura/SAR system has the breakdown.)
//
// Pure + dependency-free (besides the eligibility predicate) so the breakdown is
// unit-testable. Extracted from index.js with priceBreakdownCents unchanged.
// ---------------------------------------------------------------------------
function priceBreakdownCents(totalLempiras) {
  const total_cents = Math.round(Number(totalLempiras) * 100);
  const tax_cents = Math.round(total_cents - total_cents / 1.15);
  const subtotal_cents = total_cents - tax_cents;
  return { total_cents, subtotal_cents, tax_cents };
}

// Per-restaurant order money breakdown.
//   PLATFORM-factura restaurants (x_pizza) → the ISV 15% tax-inclusive split above.
//   NON-platform restaurants (la_musa — SAR factura issued by its own Soft Restaurant POS) →
//     NO ISV split: subtotal_cents == total_cents, tax_cents == 0. The platform is not the fiscal
//     authority for them, so it stores no breakdown (Soft Restaurant POS owns it).
// subtotal_cents + tax_cents === total_cents holds either way. usesPlatformFactura is the SAME
// flag that gates allocateFacturaOnSale/voidFacturaOnCancel, so factura + tax stay consistent.
function orderBreakdownCents(totalLempiras, restaurantId) {
  if (usesPlatformFactura(restaurantId)) return priceBreakdownCents(totalLempiras);
  const total_cents = Math.round(Number(totalLempiras) * 100);
  return { total_cents, subtotal_cents: total_cents, tax_cents: 0 };
}

module.exports = { priceBreakdownCents, orderBreakdownCents };
