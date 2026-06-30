'use strict';

// Restaurant-aware hosted-checkout return base (B2-server). After paying on PixelPay's hosted page
// the customer returns HERE — so it must be the restaurant's OWN order-site origin (where the
// return/poll page + its localStorage stash live).
//
//   x_pizza → the original global default, byte-for-byte (PIXELPAY_RETURN_URL || the orders site).
//   la_musa → PIXELPAY_RETURN_URL_LA_MUSA, and FAIL-CLOSED if unset (ADR-0002): reject rather than
//             fall back to the x_pizza origin, which would silently mis-route the customer to the
//             wrong site (its localStorage stash isn't there → broken return/retry).
//
// Pure (env injected) so the fail-closed + byte-identical behavior is unit-testable.
function resolveReturnBase(restaurantId, env) {
  const e = env || {};
  if (restaurantId === 'la_musa') {
    const base = e.PIXELPAY_RETURN_URL_LA_MUSA;
    if (!base) {
      return { base: null, error: 'PIXELPAY_RETURN_URL_LA_MUSA not configured' };
    }
    return { base: String(base).replace(/\/+$/, ''), error: null };
  }
  // x_pizza (and any non-la_musa) — identical to the original inline default.
  return {
    base: String(e.PIXELPAY_RETURN_URL || 'https://xpizzaorders.netlify.app').replace(/\/+$/, ''),
    error: null,
  };
}

module.exports = { resolveReturnBase };
