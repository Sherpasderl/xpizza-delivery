'use strict';

// Rewards Redemption v2 — pure redemption calculator. Given a client redeem REQUEST + the SERVER context
// (restaurant + priced cart), returns the server-computed reward — NEVER trusts a client price / cost / id.
// Both brands are now ADD-FREE (the reward item is added to the order at L0; the paid total is unchanged):
//   • X. Pizza  'free_pizza_choice' → the customer picks ANY eligible 12" `individual` pizza; it is added free.
//     cost = 8 punches (the card cost). canonical is the single-item shape { …, free_item_key:<pizza name> }.
//   • La Musa   'points_ala_carte'  → a MULTISET of non-alcohol dishes, each added free; the points WALLET is
//     debited Σ(cost_pts × qty), cost_pts = round(price_L × REDEEM_POINTS_PER_LEMPIRA). canonical is the
//     multiset shape { …, total_cost, items:[{free_item_key,cost,qty,price_cents}] } — items SORTED + COALESCED
//     by free_item_key so the fingerprint is reorder-/duplicate-stable (design-gate refinements #1/#2).
// Eligibility is server-authoritative (rewards-redeem-config): X. Pizza = the individual allowlist (NY excluded);
// La Musa = any non-alcohol menu dish + the 3 acompañamientos (modifiers/alcohol rejected). Never throws.
const crypto = require('crypto');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, resolvePriceTables } = require('./menu-pricing');
const { REDEMPTION_CONFIG, REDEMPTION_CONFIG_VERSION, REDEEM_POINTS_PER_LEMPIRA, isXPizzaEligible, isLaMusaEligible } = require('./rewards-redeem-config');

const toCents = (lempiras) => Math.round(lempiras * 100);   // menu tables are whole-lempira; ×100 is exact

// Stable hash of the canonical redeemed set (design-gate refinement #2) — folded into the ORDER fingerprint so
// a swapped/reordered redeemed set changes both the cash reserve binding AND the online payment_fingerprint.
// canonical.items (La Musa) is already sorted+coalesced at compute time, so the JSON is reorder-stable.
function redemptionFingerprint(canonical) {
  if (!canonical || typeof canonical !== 'object') return '';
  const sorted = Object.keys(canonical).sort().reduce((o, k) => (o[k] = canonical[k], o), {});
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 24);
}

// Anti-DoS bounds on a La Musa multiset (the atomic balance check is the real money guard; these cap payload size).
const MAX_REDEEM_DISTINCT = 40;
const MAX_REDEEM_UNITS = 40;

// La Musa free-item price in cents, resolved across menu THEN extras. null if the id has no price in either.
function laMusaPriceCents(itemId, tables = null) {
  const t = resolvePriceTables('la_musa', tables);                       // PIN B asserts the tag
  const menu = t.menu || {};
  const extras = t.extraPrices || {};
  let p;
  if (Object.prototype.hasOwnProperty.call(menu, itemId)) p = menu[itemId];
  else if (Object.prototype.hasOwnProperty.call(extras, itemId)) p = extras[itemId];
  else return null;
  return (Number.isFinite(p) && p > 0) ? toCents(p) : null;
}

// La Musa points cost for ONE unit priced at `priceCents` — round(price_L × rate) → ~10% value-back.
function costPtsFor(priceCents) { return Math.round((priceCents / 100) * REDEEM_POINTS_PER_LEMPIRA); }

// X. Pizza — the customer's chosen 12" pizza, added free. redeem = { type:'free_pizza_choice', item_id:<name> }.
// (x_pizza's menu key IS the item name.) The chosen pizza is NOT a paid line; it never enters order.items, so it
// earns zero punches with no adjustment (design-gate refinement #7).
function computeXPizza(redeem, tables = null) {
  if (!redeem || redeem.type !== REDEMPTION_CONFIG.x_pizza.reward) return { ok: false, reason: 'bad_request' };   // fail-closed: type MUST match the brand's reward
  const name = redeem && redeem.item_id;
  if (typeof name !== 'string' || !name) return { ok: false, reason: 'bad_request' };
  if (!isXPizzaEligible(name)) return { ok: false, reason: 'ineligible_item' };   // NY / unknown / non-individual
  const unit = (resolvePriceTables('x_pizza', tables).menu || {})[name];   // PIN B asserts the tag
  const price_cents = toCents(unit);
  if (!(Number.isFinite(price_cents) && price_cents > 0)) return { ok: false, reason: 'ineligible_item' };
  const cfg = REDEMPTION_CONFIG.x_pizza;
  const canonical = { restaurant_id: 'x_pizza', model: 'add_free', type: cfg.reward,
    config_version: REDEMPTION_CONFIG_VERSION, cost: cfg.cost, discount_cents: 0, free_item_key: name };
  return { ok: true, model: 'add_free', cost: cfg.cost, discount_cents: 0,
    freeItems: [{ item_id: name, qty: 1, price_cents, added: true }], canonical };
}

// La Musa — a MULTISET of chosen non-alcohol dishes, each added free; wallet debited Σ(cost_pts × qty).
// redeem = { type:'points_ala_carte', items:[{ id, qty }, …] }. Duplicates coalesced; ids sorted for a stable
// fingerprint; each priced + eligibility-checked server-side.
function computeLaMusa(redeem, tables = null) {
  if (!redeem || redeem.type !== REDEMPTION_CONFIG.la_musa.reward) return { ok: false, reason: 'bad_request' };   // fail-closed: type MUST match the brand's reward
  const raw = redeem && redeem.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REDEEM_DISTINCT) return { ok: false, reason: 'bad_request' };
  const qtyById = new Map();
  let totalUnits = 0;
  for (const entry of raw) {
    const id = entry && entry.id;
    const qty = Number(entry && entry.qty);
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'bad_request' };
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, reason: 'bad_request' };
    qtyById.set(id, (qtyById.get(id) || 0) + qty);           // coalesce duplicate ids
    totalUnits += qty;
    if (totalUnits > MAX_REDEEM_UNITS) return { ok: false, reason: 'bad_request' };
  }
  const ids = Array.from(qtyById.keys()).sort();             // sorted → reorder-stable canonical/fingerprint
  const canonItems = [];
  const freeItems = [];
  let total_cost = 0;
  for (const id of ids) {
    if (!isLaMusaEligible(id, tables)) return { ok: false, reason: 'ineligible_item' };   // alcohol / modifier / unknown
    const price_cents = laMusaPriceCents(id, tables);
    if (price_cents === null) return { ok: false, reason: 'ineligible_item' };
    const qty = qtyById.get(id);
    const cost_pts = costPtsFor(price_cents);
    total_cost += cost_pts * qty;
    canonItems.push({ free_item_key: id, cost: cost_pts, qty, price_cents });
    freeItems.push({ item_id: id, qty, price_cents, cost_pts, added: true });
  }
  const cfg = REDEMPTION_CONFIG.la_musa;
  const canonical = { restaurant_id: 'la_musa', model: 'add_free', type: cfg.reward,
    config_version: REDEMPTION_CONFIG_VERSION, discount_cents: 0, total_cost, items: canonItems };
  return { ok: true, model: 'add_free', cost: total_cost, discount_cents: 0, freeItems, canonical };
}

// computeRedemption({ redeem, items, restaurantId }) — `items` is the SERVER-priced cart (must be non-empty;
// the ≥1-OTHER-PAID-item anti-abuse guard is enforced at intake, not here). Malformed → { ok:false, reason }.
// 1b-1b: `tables` are the guarded catalog tables for THIS restaurant; they supply the redemption prices
// AND the eligible key set. Omitted → the in-code tables (legacy pure tests only — production seams throw).
function computeRedemption({ redeem, items, restaurantId, tables = null } = {}) {
  try {
    if (!redeem || typeof redeem !== 'object') return { ok: false, reason: 'bad_request' };
    const cfg = REDEMPTION_CONFIG[restaurantId];
    if (!cfg) return { ok: false, reason: 'bad_request' };
    if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: 'bad_request' };
    if (cfg.reward === 'free_pizza_choice') return computeXPizza(redeem, tables);
    if (cfg.reward === 'points_ala_carte') return computeLaMusa(redeem, tables);
    return { ok: false, reason: 'bad_request' };
  } catch (e) {
    console.warn('computeRedemption: unexpected —', e && e.message);
    return { ok: false, reason: 'bad_request' };
  }
}

module.exports = { computeRedemption, laMusaPriceCents, costPtsFor, redemptionFingerprint };
