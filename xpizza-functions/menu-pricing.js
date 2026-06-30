'use strict';

// ---------------------------------------------------------------------------
// Server-side price tables — the SOURCE OF TRUTH for an order's total.
//
// The order TOTAL is recomputed here from these tables, NOT trusted from the
// client. A tampered client (the order-intake secret is, by necessity, public
// in the browser) could otherwise POST total:1 for any order. Each restaurant's
// table MUST be kept in sync with that restaurant's order form (same contract as
// the RESTAURANT coords).
//
// MATCH KEY IS PER-RESTAURANT — deliberately NOT a blanket `id || name`:
//   x_pizza → item.name  (exactly the original contract; any posted `id` is IGNORED,
//             so a forged id cannot reroute an X. Pizza payload — byte-identical)
//   la_musa → item.id    (stable slug; survives Soft Restaurant POS sync / name edits)
//
// Pure + dependency-free so the pricing is unit-testable. The live handlers in
// index.js pass the validated restaurant_id; nothing else is injected.
// ---------------------------------------------------------------------------

// X. Pizza — keyed by the exact item `name` the form sends. In sync with
// MENU in xpizza-orders/index.html. (Unchanged from the original index.js MENU_PRICES.)
const X_PIZZA_MENU = {
  'Sopressatta Chili Honey': 385, 'Carnivora': 340, 'Crispy Bacon': 337,
  'Sweet Corn & Calabrian Chili': 314, 'Mushroom': 323, 'Spinach': 307,
  'Pancetta Vodka Sauce': 328, 'Margherita': 299, 'Pepperoni': 307,
  'Anchovies': 418, 'Shrimp Scampi': 412, 'Pistaccio Mortadella': 409,
  'Prosciutto': 402, 'Potato & Dill Sausage': 299, 'Cacio e Pepe': 297,
  'Ham': 282, 'Nutella': 251,
  'Carnivora NY': 685, 'Margherita NY': 624, 'Cacio e Pepe NY': 641,
  'Mushroom NY': 702, 'Jamon o Pepperoni NY': 641, 'Crispy Bacon NY': 662
};

// La Musa — keyed by stable `id` slug. In sync with the MENU const in the La Musa
// order form (la-musa-orders/index.html), 40 items. Whole-lempira, tax-INCLUSIVE
// prices; the platform stores NO ISV split for La Musa (Soft Restaurant POS issues
// the factura), so no tax rate is encoded here — this is purely the cart price source.
const LA_MUSA_MENU = {
  // dim_sum
  dimsum_01: 223, dimsum_02: 248, dimsum_03: 198, dimsum_04: 237, dimsum_05: 260,
  // starters
  starter_01: 262, starter_02: 252, starter_03: 265, starter_04: 378, starter_05: 413, starter_06: 409,
  // house_specials (no special_03 in the menu)
  special_01: 588, special_02: 478, special_04: 624, special_05: 384,
  // crudo
  crudo_01: 452, crudo_02: 346, crudo_03: 337,
  // noodles
  noodle_01: 414, noodle_02: 492, noodle_03: 340,
  // rice
  rice_01: 270, rice_02: 456, rice_03: 448, rice_04: 392,
  // soups_salads
  soup_01: 255, soup_02: 288, soup_03: 192,
  // bebidas — cervezas (alcohol)
  beer_01: 102, beer_02: 102, beer_03: 102, beer_04: 98, beer_05: 102, beer_06: 102, beer_07: 81, beer_08: 81,
  // bebidas — sodas
  soft_01: 40, soft_02: 40, soft_03: 40, soft_04: 40
};

const MENU_BY_RESTAURANT = { x_pizza: X_PIZZA_MENU, la_musa: LA_MUSA_MENU };

// X. Pizza extras — keyed by NAME (0/1 toggle in the form, each counts once).
const EXTRA_PRICES = {
  'Salsa Roja': 39, 'Salsa Blanca': 39, 'Salsa Calabrian Chili': 49,
  'Mozzarella': 50, 'Whipped Ricotta': 65, 'Salchicha Italiana': 50,
  'Pepperoni': 50, 'Jamón': 39, 'Prosciutto': 94, 'Mortadella': 85,
  'Espinaca': 33, 'Maíz': 45, 'Hongos': 61, 'Basil Pesto': 33
};

// La Musa extras — keyed by stable `id` slug, in sync with the EXTRAS array in the La Musa order
// form (la-musa-orders/index.html), 14 add-ons. Standalone + qty-aware (summed by their own qty,
// independent of the parent dish qty — see buildOrder's extrasTotal). Whole-lempira prices.
const LA_MUSA_EXTRAS = {
  // Acompañamientos
  rice_white: 50, rice_chinese: 85, papas_fritas: 75,
  // Salsas
  sauce_chili_oil: 30, sauce_aioli: 30, sauce_chipotle: 30, sauce_dumpling: 30,
  sauce_wonton: 30, sauce_pad_thai: 30, sauce_spicy_mayo: 30, sauce_tuna_tartar: 30,
  // Proteínas
  protein_chicken: 65, protein_beef: 155, protein_shrimp: 135
};
const EXTRAS_BY_RESTAURANT = { x_pizza: EXTRA_PRICES, la_musa: LA_MUSA_EXTRAS };

// Recompute the order total from the server price tables for `restaurantId`.
// Returns { total, error }. Rejects unknown item/extra keys (= tampering) and absurd quantities.
// Extras model is per-restaurant: x_pizza is name-keyed and counts each once (0/1 toggle);
// la_musa is id-keyed and qty-aware/standalone with anti-tamper guards (non-array/unknown/qty/dup).
// restaurantId defaults to 'x_pizza' so existing x_pizza callers are byte-identical.
function computeServerTotal(items, restaurantId = 'x_pizza') {
  const menu = MENU_BY_RESTAURANT[restaurantId];
  const extraPrices = EXTRAS_BY_RESTAURANT[restaurantId] || {};
  if (!menu) {
    return { total: NaN, error: `unknown restaurant: ${String(restaurantId).slice(0, 40)}` };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { total: NaN, error: 'items must be a non-empty array' };
  }
  const byId = restaurantId === 'la_musa';
  let total = 0;
  for (const it of items) {
    const key = byId ? (it && it.id) : (it && it.name);
    const qty = Number(it && it.qty);
    if (!key || !Object.prototype.hasOwnProperty.call(menu, key)) {
      return { total: NaN, error: `unknown menu item: ${String(key).slice(0, 40)}` };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      return { total: NaN, error: `invalid quantity for ${key}` };
    }
    total += menu[key] * qty;
    // la_musa: a non-array `extras` is malformed = tampered (the form always emits an array).
    // x_pizza stays on the silent-coerce path below — the SHARED line is untouched (byte-identical).
    if (byId && it.extras != null && !Array.isArray(it.extras)) {
      return { total: NaN, error: `invalid extras for ${key}` };
    }
    const extras = Array.isArray(it.extras) ? it.extras : [];
    const seenExtraIds = byId ? new Set() : null;
    for (const ex of extras) {
      if (byId) {  // la_musa — id-keyed, qty-aware, standalone (independent of dish qty)
        const eid = ex && ex.id;
        if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) {
          return { total: NaN, error: `unknown extra: ${String(eid).slice(0, 40)}` };
        }
        if (seenExtraIds.has(eid)) {
          return { total: NaN, error: `duplicate extra ${eid}` };
        }
        seenExtraIds.add(eid);
        const eqty = Number(ex && ex.qty);
        if (!Number.isInteger(eqty) || eqty < 1 || eqty > 50) {
          return { total: NaN, error: `invalid quantity for extra ${eid}` };
        }
        total += extraPrices[eid] * eqty;  // server table only — client ex.price ignored
      } else {  // x_pizza — original name-keyed / count-once logic, verbatim
        const ename = ex && ex.name;
        if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) {
          return { total: NaN, error: `unknown extra: ${String(ename).slice(0, 40)}` };
        }
        total += extraPrices[ename];
      }
    }
  }
  return { total, error: null };
}

module.exports = {
  MENU_BY_RESTAURANT, EXTRA_PRICES, EXTRAS_BY_RESTAURANT, computeServerTotal,
};
