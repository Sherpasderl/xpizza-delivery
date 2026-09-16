'use strict';
// ---------------------------------------------------------------------------
// Portal 1C Task 1 — computeServerNet: THE SINGLE NET COMPUTATION.
//
// The quote-issuer, createOrder and chargeOnlineOrder will all call this (Tasks 3/4/5), so that the
// number a customer CONFIRMS and the number they are CHARGED come from one place rather than from
// three compositions that agree until one of them is edited. 1B proved the server never takes a price
// from the client; 1C is about the server agreeing with itself.
//
// 🔴 THIS CHANGES NO CHARGED VALUE. It consolidates; it does not re-price. Everything below either
// calls the existing money code or arranges its output — there is no new arithmetic on the money path,
// and compute-server-net.test.js holds it to that against real carts on both brands.
//
// THE THREE THINGS THAT WERE VERIFIED AGAINST THE SOURCE RATHER THAN ASSUMED, because each would have
// been a plausible-looking wrong answer:
//
//   1. THE UNIT. computeServerTotal returns LEMPIRA (`total += price * qty` over table prices,
//      menu-pricing.js). orderBreakdownCents is what multiplies by 100. A net that returned lempira
//      while calling itself `_cents` would be 100x wrong in a way that does not look absurd in a log,
//      because L680 and 68000 centavos are both ordinary numbers.
//
//   2. FISCAL IS NOT AN ADDEND. ISV 15% is tax-INCLUSIVE (order-money.js): the menu price IS what the
//      customer pays, and the tax is broken OUT of the total. The task described the net as
//      "base − reward + delivery + fiscal"; adding fiscal_cents would double-charge the tax on every
//      x_pizza order. It is reported as a COMPONENT OF the net, never added to it.
//
//   3. add_free DOES NOT DISCOUNT. Today's only redemption model adds a free line and carries a fiscal
//      rebaja; `discount_cents: 0` in rewards-redeem-pricing.js, and the customer-facing quote shows
//      savings separately. So a reward-active net today EQUALS the paid-cart net, and
//      reward_discount_cents is 0. That 0 is DERIVED from the reward path's own total rather than
//      assumed, so if a discounting model is ever added the discount flows through here with no edit.
//
// ONE REWARD COMPUTATION. The discount is not re-derived: applyRedemptionToPricing is called and its
// total_cents is used. `reward` is the RESOLVED redemption (what that function consumes — `{ok, model,
// freeItems}`), not the raw client payload; turning a client payload into a resolved redemption is a
// separate server-side step that already exists upstream, and duplicating it here would be the second
// source of truth this task exists to prevent.
// ---------------------------------------------------------------------------
const { computeServerTotal } = require('./menu-pricing');
const { orderBreakdownCents } = require('./order-money');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');

/* The delivery slot. Zero today — delivery is free — but it is computed HERE, from server-side
   context, so the 2-tier distance pricing lands with no rework and no call-site change. The client
   never supplies a fee: `deliveryContext` describes the delivery (what it will eventually carry is
   distance/zone), and a caller that passes an amount would be ignored, which is the point. */
function deliveryCentsFor(deliveryContext /* , rid */) {
  if (!deliveryContext) return 0;
  return 0;
}

function computeServerNet({ items, reward = null, deliveryContext = null, rid, tables = null }) {
  // BASE — the same recompute createOrder does, from the same tables. An unpriceable cart stops here
  // and returns an error with NO total: pricing an unknown item as free would make a tampered name the
  // cheapest possible attack, which is the 1B charge-boundary lesson.
  const base = computeServerTotal(items, rid, tables);
  if (base.error) return { error: base.error };
  if (!Number.isFinite(Number(base.total))) return { error: 'bad_total' };

  const baseBreakdown = orderBreakdownCents(base.total, rid);
  const base_cents = baseBreakdown.total_cents;

  // REWARD — routed, never re-derived. A redemption the reward path refuses is an ERROR rather than a
  // silent full-price charge: a customer who believes a reward is attached and is billed as though it
  // is not has been surprised in the direction that costs them money.
  let netAfterReward = base_cents;
  let fiscal_cents = baseBreakdown.tax_cents;
  if (reward) {
    const priced = applyRedemptionToPricing({ items, restaurantId: rid, redemption: reward, totalLempiras: base.total, tables });
    if (!priced || priced.ok !== true) return { error: (priced && priced.error) || 'reward_unpriceable' };
    netAfterReward = priced.total_cents;
    fiscal_cents = priced.tax_cents;
  }
  const reward_discount_cents = base_cents - netAfterReward;

  const delivery_cents = deliveryCentsFor(deliveryContext, rid);
  const net_total_cents = netAfterReward + delivery_cents;

  /* The provenance breakdown for the quote token. Deliberately NOT split into items vs extras:
     computeServerTotal returns one total and does not separate them, so a split would have to be
     recomputed here — a second arithmetic path over the same money, which is exactly what this
     function exists to remove. base_cents is the honest granularity. */
  return {
    net_total_cents,
    components: { base_cents, reward_discount_cents, delivery_cents, fiscal_cents },
  };
}

module.exports = { computeServerNet };
