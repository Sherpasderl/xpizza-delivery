'use strict';

// Rewards Phase B1 — pure two-model redemption calculator. Given the SERVER-priced cart + a client redeem
// REQUEST, returns the server-computed reward (never trusts a client price/cost). Two brand models share one
// result shape; the reservation (rewards-reserve.js) enforces one-per-order — not here. Never throws.
//
//   • X. Pizza  'discount_cheapest_pizza' → model 'discount': free ONE base unit of the cheapest pizza
//     already in the cart. discount_cents = that pizza's BASE UNIT price (extras excluded — they stay paid,
//     Task 4). Requires ≥1 pizza (every x_pizza menu line IS a pizza — same premise as Phase A computeEarn;
//     a non-pizza can't be in an x_pizza cart because computeServerTotal rejects any non-menu line).
//   • La Musa   'add_free_item' → model 'add_free': ADD a chosen eligible tier item at price 0 (total
//     unchanged; discount_cents = 0). The item need NOT be in the cart. Its price is resolved across BOTH
//     namespaces — MENU_BY_RESTAURANT.la_musa AND EXTRAS_BY_RESTAURANT.la_musa (the L1 acompañamientos
//     rice_white/rice_chinese/papas_fritas live in the extras table; a menu-only lookup would mis-fail them).
//
// canonical = the fingerprint-stable server identity of the reward { restaurant_id, model, type,
// config_version, cost, discount_cents, free_item_key } — bound into payment_fingerprint + the reservation.
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, itemPricingKey } = require('./menu-pricing');
const { REDEMPTION_CONFIG, REDEMPTION_CONFIG_VERSION, getTier, itemInTier } = require('./rewards-redeem-config');

const toCents = (lempiras) => Math.round(lempiras * 100);   // menu tables are whole-lempira; ×100 is exact

// La Musa free-item price in cents, resolved across menu THEN extras. null if the id has no price in either.
function laMusaPriceCents(itemId) {
  const menu = MENU_BY_RESTAURANT.la_musa || {};
  const extras = EXTRAS_BY_RESTAURANT.la_musa || {};
  let p;
  if (Object.prototype.hasOwnProperty.call(menu, itemId)) p = menu[itemId];
  else if (Object.prototype.hasOwnProperty.call(extras, itemId)) p = extras[itemId];
  else return null;
  return (Number.isFinite(p) && p > 0) ? toCents(p) : null;
}

// X. Pizza — pick the cheapest BASE UNIT among the pizza lines (first-wins on a tie → deterministic).
function computeXPizza(items) {
  const menu = MENU_BY_RESTAURANT.x_pizza;
  let best = null;                                            // { price, name, index }
  items.forEach((it, i) => {
    const name = itemPricingKey(it, 'x_pizza');
    const qty = Number(it && it.qty);
    if (!name || !Object.prototype.hasOwnProperty.call(menu, name)) return;   // not a priceable pizza line
    if (!Number.isInteger(qty) || qty < 1) return;
    const unit = menu[name];
    if (!(Number.isFinite(unit) && unit > 0)) return;
    if (best === null || unit < best.price) best = { price: unit, name, index: i };
  });
  if (!best) return { ok: false, reason: 'no_eligible_item' };
  const cfg = REDEMPTION_CONFIG.x_pizza;
  const discount_cents = toCents(best.price);
  const canonical = { restaurant_id: 'x_pizza', model: 'discount', type: cfg.reward,
    config_version: REDEMPTION_CONFIG_VERSION, cost: cfg.cost, discount_cents, free_item_key: best.name };
  // line_index carries the exact line for Task 4's split; it is NOT part of canonical (cart order must not
  // perturb the fingerprint — free_item_key + discount_cents are the stable identity).
  return { ok: true, model: 'discount', cost: cfg.cost, discount_cents,
    freeItem: { line_key: best.name, line_index: best.index, unit: true }, canonical };
}

// La Musa — validate {level, item_id} against the tier table, price the added item across both namespaces.
function computeLaMusa(redeem) {
  const level = Number(redeem && redeem.level);
  const itemId = redeem && redeem.item_id;
  if (!Number.isInteger(level) || typeof itemId !== 'string' || !itemId) return { ok: false, reason: 'bad_request' };
  const tier = getTier('la_musa', level);
  if (!tier || !itemInTier('la_musa', level, itemId)) return { ok: false, reason: 'ineligible_item' };
  const price_cents = laMusaPriceCents(itemId);
  if (price_cents === null) return { ok: false, reason: 'ineligible_item' };   // tier-listed but unpriceable (config/menu drift)
  const cfg = REDEMPTION_CONFIG.la_musa;
  const canonical = { restaurant_id: 'la_musa', model: 'add_free', type: cfg.reward,
    config_version: REDEMPTION_CONFIG_VERSION, cost: tier.cost, discount_cents: 0, free_item_key: itemId };
  return { ok: true, model: 'add_free', cost: tier.cost, discount_cents: 0,
    freeItem: { item_id: itemId, price_cents, added: true }, canonical };
}

// computeRedemption({ redeem, items, restaurantId }) — `items` is the SERVER-priced cart (validated upstream
// by computeServerTotal). Malformed input → { ok:false, reason:'bad_request' } (never throws).
function computeRedemption({ redeem, items, restaurantId } = {}) {
  try {
    if (!redeem || typeof redeem !== 'object') return { ok: false, reason: 'bad_request' };
    const cfg = REDEMPTION_CONFIG[restaurantId];
    if (!cfg) return { ok: false, reason: 'bad_request' };
    if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: 'bad_request' };
    if (cfg.reward === 'discount_cheapest_pizza') return computeXPizza(items);
    if (cfg.reward === 'add_free_item') return computeLaMusa(redeem);
    return { ok: false, reason: 'bad_request' };
  } catch (e) {
    console.warn('computeRedemption: unexpected —', e && e.message);
    return { ok: false, reason: 'bad_request' };
  }
}

module.exports = { computeRedemption, laMusaPriceCents };
