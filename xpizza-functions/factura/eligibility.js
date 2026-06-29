'use strict';

/**
 * Pure predicates for the two factura DB triggers (ADR-0003). Kept separate from index.js
 * so the eligibility logic is unit-testable without a Functions runtime.
 */

// An order has become a [[Sale]] that still owes a factura. Acts ONLY on factura_status
// 'not_due' so the trigger can't loop (allocate sets issued/failed/cancelled, none of which
// re-qualify; 'failed' is left to the reconciler). Pre-launch orders (no factura_status, or
// created before the cutoff) are never retro-issued. Field-presence is checked in the
// HANDLER, not here, so a fields-missing sale still reaches the failed+alert path.
function facturaSaleEligible(after, cutoffMs) {
  if (!after) return false;
  if (after.factura_status !== 'not_due') return false;
  if (!(Number(after.created_at) >= cutoffMs)) return false;
  if (after.status !== 'new') return false;
  if (after.payment_method === 'online' && after.payment_status !== 'confirmed') return false;
  return true;
}

// Order just transitioned into 'cancelled' (fires once).
function facturaVoidEligible(before, after) {
  if (!after) return false;
  if (after.status !== 'cancelled') return false;
  if (before && before.status === 'cancelled') return false;
  return true;
}

// Restaurants on the PLATFORM factura pipeline (SAR factura issued by THIS system). La Musa is
// deliberately excluded — it issues facturas via its own Soft Restaurant POS, so the allocate/void
// triggers skip it (it has no factura_config and owes no platform number). Future opt-in = add the
// id here. NOT every restaurant owes a platform factura.
const FACTURA_PLATFORM_RESTAURANTS = new Set(['x_pizza']);
function usesPlatformFactura(restaurantId) { return FACTURA_PLATFORM_RESTAURANTS.has(restaurantId); }

module.exports = { facturaSaleEligible, facturaVoidEligible, usesPlatformFactura, FACTURA_PLATFORM_RESTAURANTS };
