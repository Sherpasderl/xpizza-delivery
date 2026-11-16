'use strict';
// Q-D (PLAN-directory-promo-basis-r0, advisor GO 11-13; owner rule 10) — the directory's production pricingView: the fee, the promo and the
// coverage of one restaurant, read through the QUOTE's own effective pricing read (delivery-wire.loadPricing: one read of
// platform_config/delivery_pricing, free delivery forced off platform-wide, owner 11-10). So the directory can never promise a free
// delivery the quote will not grant: its promo is that read's free_delivery, marked basis:'pricing' (capp configFor claims only such a
// promo). An unreadable config throws (the directory's fee-unavailable, partial path) — never free.
//   makePricingView({ rtdb, now }) → async (rid, identity) → { fee, promo, coverage_km }
//     fee:   { state: 'priced', from_cents: the lowest band } | { state: 'invalid' } | { state: 'none' } (dark: no active config)
//     promo: { free_delivery, label: null, basis: 'pricing' } when priced; null otherwise
//     coverage_km: P.effectiveMaxKm (the quote's own maxKm), null when it is not a number
// One read serves one directory build: the read is shared for READ_TTL_MS (a build lists every restaurant within it).
const DW = require('../delivery/delivery-wire');
const P = require('../delivery/delivery-pricing');

const READ_TTL_MS = 2000;

function makePricingView({ rtdb, now = Date.now }) {
  let held = null;   // { at, p }
  const read = () => {
    const t = now();
    if (!held || t - held.at >= READ_TTL_MS) held = { at: t, p: DW.loadPricing(rtdb, 'app') };
    return held.p;
  };
  return async function pricingView(rid) {
    const lp = await read();
    if (!lp || lp.failed) throw new Error('delivery_pricing_unavailable');
    const pr = lp.pricing;
    if (!pr) return { fee: { state: 'none' }, promo: null, coverage_km: null };
    if (pr.invalid) return { fee: { state: 'invalid' }, promo: null, coverage_km: null };
    const max = P.effectiveMaxKm(pr, rid);
    // Codex #104 P2: the SAME refusals the quote applies (delivery-pricing quoteDelivery — a malformed branch limit ⇒ delivery_pricing_invalid,
    // invalid stored zones ⇒ delivery_zones_invalid): no fee, no promo, never a «desde» or a basis-pricing claim for a refused delivery
    if (max === P.LIMIT_INVALID || pr.zonesInvalid) return { fee: { state: 'invalid' }, promo: null, coverage_km: null };
    return {
      fee: { state: 'priced', from_cents: Math.min(...pr.bands.map((b) => b.cents)) },
      promo: { free_delivery: pr.free_delivery === true, label: null, basis: 'pricing' },
      coverage_km: typeof max === 'number' && Number.isFinite(max) ? max : null,
    };
  };
}

module.exports = { makePricingView, READ_TTL_MS };
