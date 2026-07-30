'use strict';

const { MENU_BY_RESTAURANT } = require('./menu-pricing');

// Rewards Redemption v2 — redemption config (versioned, static module). Pure data + tiny accessors; the money
// calculator (rewards-redeem.js) and the handlers read ONLY from here. Owner-locked (design-gate approved):
//   • X. Pizza — punch card_size 8; reward = customer picks ANY 12" `individual` pizza, ADDED free (L0 line).
//                The order total is unchanged (the pizza is added at 0). Was discount_cheapest_pizza (v1).
//   • La Musa  — points WALLET; redeem one or more non-alcohol dishes à la carte, each ADDED free (L0 line);
//                the balance decrements per item. cost_pts = round(price_L × 10/3) → ~10% value-back. Was tiers (v1).
// REDEMPTION_CONFIG_VERSION stamps every redemption so a config change mid-flight is detectable (a version
// mismatch → non-payable). Bumped 1 → 2 for the v2 model. Safe while redemption is gated OFF
// (config/redemption_enabled !== true → zero reservations ever stamped → no migration hazard).
const REDEMPTION_CONFIG_VERSION = 2;

// La Musa points↔lempira rate: cost_pts = round(price_L × REDEEM_POINTS_PER_LEMPIRA) → ~10% value-back
// (each point is worth L0.30). This is the ONE place the rate is defined; the calculator reads ONLY from here.
const REDEEM_POINTS_PER_LEMPIRA = 10 / 3;

const REDEMPTION_CONFIG = {
  x_pizza: { kind: 'punch', cost: 8, reward: 'free_pizza_choice' },
  la_musa: { kind: 'points', reward: 'points_ala_carte', rate: REDEEM_POINTS_PER_LEMPIRA, exclude: ['beer_*', 'sauce_*', 'protein_*'] },
};

// ── X. Pizza eligible set — the canonical, server-authoritative list of 12" `individual` pizzas a punch card
// may redeem free. The 18" NY pies (cat:'ny', L624–702) are EXCLUDED. This is an explicit fail-closed ALLOWLIST
// (matched by exact name, NEVER a substring heuristic): an unknown / new / NY name is simply not redeemable, so
// a forged name can never free an expensive pie. Keep in sync with cat:'individual' in xpizza-orders/index.html
// (a new 12" pizza must be ADDED here to become redeemable; the failure mode is "not redeemable", never "over-freed").
const X_PIZZA_REDEEM_ELIGIBLE = new Set([
  'Sopressatta Chili Honey', 'Carnivora', 'Crispy Bacon', 'Sweet Corn & Calabrian Chili', 'Mushroom',
  'Spinach', 'Pancetta Vodka Sauce', 'Margherita', 'Pepperoni', 'Anchovies', 'Shrimp Scampi',
  'Pistaccio Mortadella', 'Prosciutto', 'Potato & Dill Sausage', 'Cacio e Pepe', 'Ham', 'Nutella',
]);

// ── La Musa eligible set — every la_musa MENU dish EXCEPT alcohol (`beer_*`; softs allowed), PLUS the three
// standalone acompañamientos from EXTRAS (rice_white / rice_chinese / papas_fritas). Modifiers (`sauce_*` /
// `protein_*`) are NOT redeemable. Alcohol still EARNS points — it is only hidden from the redeem picker.
// Non-alcohol dishes derive from the menu table (a new dish is auto-eligible); the EXTRAS acompañamientos are
// an explicit allowlist (so no other extra ever becomes redeemable).
const LA_MUSA_ACOMP = new Set(['rice_white', 'rice_chinese', 'papas_fritas']);

function isXPizzaEligible(name) { return !!(name && X_PIZZA_REDEEM_ELIGIBLE.has(name)); }

function isLaMusaEligible(id) {
  if (!id || typeof id !== 'string') return false;
  if (LA_MUSA_ACOMP.has(id)) return true;                                                 // acompañamientos (EXTRAS namespace)
  if (id.startsWith('beer_')) return false;                                               // alcohol — excluded from the picker
  return Object.prototype.hasOwnProperty.call(MENU_BY_RESTAURANT.la_musa || {}, id);      // any non-alcohol MENU dish
}

// Is `key` (x_pizza → pizza NAME, la_musa → item id) redeem-eligible for this brand? Server-authoritative.
function isRedeemEligible(restaurantId, key) {
  return restaurantId === 'x_pizza' ? isXPizzaEligible(key)
    : restaurantId === 'la_musa' ? isLaMusaEligible(key)
      : false;
}

// The full eligible key list for a brand (for validation / a server-driven picker if ever needed).
function eligibleKeys(restaurantId) {
  if (restaurantId === 'x_pizza') return Array.from(X_PIZZA_REDEEM_ELIGIBLE);
  if (restaurantId === 'la_musa') {
    const menu = MENU_BY_RESTAURANT.la_musa || {};
    return Object.keys(menu).filter((id) => !id.startsWith('beer_')).concat(Array.from(LA_MUSA_ACOMP));
  }
  return [];
}

// Server flag: is redemption enabled for this request? DEFAULT + fail-safe FALSE — absent, non-true, or
// unreadable ⇒ false. Enabled iff the GLOBAL flag config/redemption_enabled === true, OR (canary) a
// server-verified `uid` is present AND config/redemption_allowlist/{uid} === true (staff-set, staff-only-read).
// The uid is ALWAYS the server-verified token uid — never client-supplied — so the allowlist can only ever
// enable the allowlisted verified account, never broaden. Back-compatible: `uid` absent ⇒ global-flag-only.
async function redemptionEnabled(db, uid) {
  try {
    if ((await db.ref('config/redemption_enabled').get()).val() === true) return true;   // global flag (the atomic go-live)
    if (uid && (await db.ref(`config/redemption_allowlist/${uid}`).get()).val() === true) return true;   // canary allowlist
    return false;
  } catch (e) {
    console.warn('redemptionEnabled: read failed — fail-safe OFF', e && e.message);
    return false;                         // fail-closed on ANY read error
  }
}

module.exports = {
  REDEMPTION_CONFIG_VERSION, REDEMPTION_CONFIG, REDEEM_POINTS_PER_LEMPIRA,
  X_PIZZA_REDEEM_ELIGIBLE, isXPizzaEligible, isLaMusaEligible, isRedeemEligible, eligibleKeys, redemptionEnabled,
};
