'use strict';

// Rewards Phase B1 — redemption config (versioned, static module). Pure data + tiny accessors; the money
// calculator (rewards-redeem.js) and the handlers read ONLY from here. Owner-locked (design-gate approved):
//   • X. Pizza  — punch card_size 8; reward = discount the cheapest pizza already in the cart to free.
//   • La Musa   — points tiers 500/1000/1500/2500/3500; reward = ADD a chosen eligible tier item free.
// REDEMPTION_CONFIG_VERSION stamps every redemption so a config change mid-flight is detectable (a version
// mismatch → non-payable). The spec's "versioned RTDB config" is deferred (plan-gate #11): B1 = code config
// + this constant; B2/later can graduate to RTDB without changing the redemption record shape.
//
// NOTE for downstream tasks: La Musa tier item ids span TWO namespaces — main menu items (soft_0x, beer_0x,
// dimsum_0x, noodle_0x, rice_0x, crudo_0x, special_0x, starter_0x, soup_0x) AND extras/"Acompañamientos"
// (rice_white, rice_chinese, papas_fritas live in EXTRAS_BY_RESTAURANT.la_musa, not MENU_BY_RESTAURANT).
// The free-item price lookup + availability gate (Tasks 2/5/6) must resolve an id against BOTH.
const REDEMPTION_CONFIG_VERSION = 1;

const REDEMPTION_CONFIG = {
  x_pizza: { kind: 'punch', cost: 8, reward: 'discount_cheapest_pizza' },
  la_musa: {
    kind: 'points',
    reward: 'add_free_item',
    tiers: [
      { level: 1, cost: 500,  items: ['soft_01', 'soft_02', 'soft_03', 'soft_04',
                                      'beer_01', 'beer_02', 'beer_03', 'beer_04', 'beer_05', 'beer_06', 'beer_07', 'beer_08',
                                      'rice_white', 'rice_chinese', 'papas_fritas'] },
      { level: 2, cost: 1000, items: ['dimsum_01', 'dimsum_02', 'dimsum_03', 'dimsum_04', 'dimsum_05',
                                      'starter_01', 'starter_02', 'starter_03',
                                      'soup_01', 'soup_02', 'soup_03'] },
      { level: 3, cost: 1500, items: ['noodle_01', 'noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron', 'noodle_03',
                                      'rice_01', 'rice_04', 'crudo_02', 'crudo_03', 'special_05'] },
      { level: 4, cost: 2500, items: ['noodle_02', 'rice_02', 'rice_03',
                                      'starter_04', 'starter_05', 'starter_06', 'crudo_01', 'special_02'] },
      { level: 5, cost: 3500, items: ['special_01', 'special_04'] },
    ],
  },
};

// The tier object for {restaurantId, level}, or null. (La Musa only; other brands have no tiers.)
function getTier(restaurantId, level) {
  const cfg = REDEMPTION_CONFIG[restaurantId];
  if (!cfg || !Array.isArray(cfg.tiers)) return null;
  return cfg.tiers.find((t) => t.level === level) || null;
}

// Is `itemId` an eligible reward in {restaurantId, level}? Pure tier membership — real-id/price/availability
// validation happens at the calculator + intake gate, never here.
function itemInTier(restaurantId, level, itemId) {
  const tier = getTier(restaurantId, level);
  return !!(tier && itemId && tier.items.includes(itemId));
}

// Server flag: is redemption enabled for this request? DEFAULT + fail-safe FALSE — absent, non-true, or
// unreadable ⇒ false. Enabled iff the GLOBAL flag config/redemption_enabled === true, OR (B2 canary) a
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

module.exports = { REDEMPTION_CONFIG_VERSION, REDEMPTION_CONFIG, getTier, itemInTier, redemptionEnabled };
