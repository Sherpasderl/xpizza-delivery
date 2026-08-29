'use strict';

// Rewards Redemption v2 — shared redemption INTAKE decision for cash createOrder AND online chargeOnlineOrder.
// Extracted (like cancelOrderCore) so the emulator drives the real money-path wiring without the Express stack.
// Enforces the LOCKED authorization precondition, the ≥1-OTHER-PAID-item anti-abuse guard, computes the reward
// SERVER-SIDE, availability-gates every free item, and RESERVES the hold — all before the order is written.
// ALL-OR-NOTHING: any failure returns { ok:false, status, body } and no reserve stands.
//
// v2 is ADD-FREE for both brands and MULTISET-aware for La Musa. On success prepareRedemption returns
// { ok:true, redemption, canonical, priced, itemsText, freeName, freeItems, redemptionFp }:
//   canonical    — stamp onto orders/{id}/redemption (single-item for X. Pizza, multiset for La Musa)
//   priced       — breakdown + factura lines + free_lines[] for the order write (total UNCHANGED)
//   itemsText    — items_text with every free line appended ( ' | ' delimited — KDS rail-count-safe )
//   freeItems    — [{ item_id, qty, price_cents, name, cost_pts? }] for the summary/quote render
//   redemptionFp — canonical-set hash, folded into the order fingerprint (design-gate refinement #2)
const { computeRedemption, redemptionFingerprint } = require('./rewards-redeem');
const { requireTables } = require('./catalog/pricing-tables');   // 1b-1b GRILL-FIX #2 — the hard contract
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
const { reserveRedemption } = require('./rewards-reserve');
const { REDEMPTION_CONFIG_VERSION, redemptionEnabled } = require('./rewards-redeem-config');
const { checkItemAvailability } = require('./availability-gate');
const { orderFingerprint } = require('./pixelpay-charge');
const { computeServerTotal } = require('./menu-pricing');

// Mirrors index.js sanitizeText — the free-item display NAME is client text; price + eligibility are
// server-derived from the id, so the name is display-only.
function sanitizeName(v, maxLen = 80) {
  const s = (v == null ? '' : String(v)).replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// Compose the order-fingerprint `extra` — the scheduled extra AND (design-gate #2) the redemption-set hash, so a
// swapped redeemed set re-fingerprints the payment. Order-stable (redemptionFp derives from the sorted canonical).
function fingerprintExtra(schedExtra, redemptionFp) {
  return [schedExtra || '', redemptionFp ? `rf:${redemptionFp}` : ''].filter(Boolean).join('|');
}

// Build the display-name map from the client redeem request (names are display-only; server owns price/eligibility).
function nameMapFrom(redeem) {
  const m = {};
  if (redeem && Array.isArray(redeem.items)) for (const e of redeem.items) { if (e && e.id) m[e.id] = sanitizeName(e.name || e.id, 80); }
  if (redeem && redeem.item_id) m[redeem.item_id] = sanitizeName(redeem.name || redeem.item_id, 80);   // x_pizza single (name === menu key)
  return m;
}

async function prepareRedemption(db, { redeem, items, restaurantId, itemsText, totalLempiras, customerUid, tables }) {
  requireTables('prepareRedemption', restaurantId, tables);   // GRILL-FIX #2: hard contract — no silent code fallback
  if (!customerUid) return { ok: false, status: 401, body: { error: 'login_required', detail: 'redemption requires a verified account' } };
  if (!(await redemptionEnabled(db, customerUid))) return { ok: false, status: 409, body: { error: 'rewards_disabled' } };

  // Anti-abuse (design-gate #3 / §1c) — BEFORE compute/reserve: a reward applies ONLY if the PAID cart has ≥1
  // item of real value (the free item can never be the whole order). Computed from the server-priced submitted
  // cart only — never client totals, never the reward's free lines. An empty paid cart → needs_paid_item.
  if (!Array.isArray(items) || items.length === 0) return { ok: false, status: 409, body: { error: 'needs_paid_item' } };
  const paid = computeServerTotal(items, restaurantId, tables);
  if (paid.error) return { ok: false, status: 400, body: { error: 'bad_cart' } };                        // malformed / tampered cart
  if (!(Number(paid.total) > 0)) return { ok: false, status: 409, body: { error: 'needs_paid_item' } };

  const redemption = computeRedemption({ redeem, items, restaurantId, tables });                                 // server-computed reward (never trusts client price/cost/id)
  if (!redemption.ok) return { ok: false, status: 409, body: { error: 'redemption_invalid', reason: redemption.reason } };

  // Enrich every free item with a sanitized display name (for items_text / summary / quote).
  const nameMap = nameMapFrom(redeem);
  const freeItems = redemption.freeItems.map((fi) => ({
    item_id: fi.item_id, qty: fi.qty, price_cents: fi.price_cents,
    name: nameMap[fi.item_id] || sanitizeName(fi.item_id, 80),
    ...(fi.cost_pts != null ? { cost_pts: fi.cost_pts } : {}),
  }));

  // 86-gate EVERY free item (x_pizza key = name, la_musa key = id → pass both; itemPricingKey picks per brand).
  const gateItems = freeItems.map((fi) => ({ id: fi.item_id, name: fi.item_id, qty: fi.qty }));
  const freeGate = await checkItemAvailability(db, gateItems, restaurantId);
  if (freeGate.blocked && freeGate.blocked.length > 0) return { ok: false, status: 409, body: { error: 'reward_unavailable', blocked: freeGate.blocked } };

  // Append every free line to items_text ( ' | ' delimiter — rail-count-safe; renders inline on WhatsApp + its
  // own KDS card ). The free items are DISPLAY/kitchen lines only; they NEVER enter order.items (the earn base),
  // so an add-free item earns zero (design-gate refinement #7).
  const appends = freeItems.map((fi) => ` | ${fi.qty}x ${fi.name} (Recompensa)`).join('');
  const outText = `${itemsText}${appends}`;
  const freeName = (freeItems[0] && freeItems[0].name) || null;

  const priced = applyRedemptionToPricing({ items, restaurantId, redemption, totalLempiras, tables });            // fail-closed reconciling lines (total unchanged)
  if (!priced.ok) return { ok: false, status: 409, body: { error: 'redemption_pricing_failed' } };

  return { ok: true, redemption, canonical: redemption.canonical, priced, itemsText: outText, freeName, freeItems,
    redemptionFp: redemptionFingerprint(redemption.canonical) };
}

// Combined intake for the CASH path (createOrder): prepare + reserve (bound to the order fingerprint + set hash).
async function resolveRedemptionForOrder(db, { redeem, items, restaurantId, orderId, customerUid, itemsText, totalLempiras, schedExtra, now, tables }) {
  requireTables('resolveRedemptionForOrder', restaurantId, tables);   // GRILL-FIX #2
  const prep = await prepareRedemption(db, { redeem, items, restaurantId, itemsText, totalLempiras, customerUid, tables });
  if (!prep.ok) return prep;
  const fp = orderFingerprint(orderId, prep.priced.total_cents, prep.itemsText, fingerprintExtra(schedExtra, prep.redemptionFp));   // bind hold to THIS order + redeemed set
  const rr = await reserveRedemption(db, { uid: customerUid, rid: restaurantId, orderId, cost: prep.redemption.cost,
    canonical: prep.canonical, orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now });   // atomic Σ-cost debit, idempotent
  if (!rr.ok) return { ok: false, status: 409, body: { error: 'redemption_reserve_failed', reason: rr.reason } };

  return { ok: true, canonical: prep.canonical, priced: prep.priced, itemsText: prep.itemsText,
    ownsHold: (rr.action === 'created' || rr.action === 're_reserved'), freeName: prep.freeName, freeItems: prep.freeItems };
}

// quoteRedemptionCore (read-only preview for the checkout review) — SAME flow as intake (uid-first gate → priced
// cart → compute / 86 / price / paid-item guard) + a READ-ONLY available projection (balance − reserved ≥ Σcost).
// NO reserve, NO write, NO side effects. Returns the v2 shape: free_items[] + total_cost + remaining + savings.
async function quoteRedemptionCore(db, { redeem, items, restaurantId, customerUid, tables }) {
  requireTables('quoteRedemptionCore', restaurantId, tables);   // GRILL-FIX #2
  if (!customerUid) return { ok: false, status: 401, body: { error: 'login_required' } };
  const { total, error: totalError } = computeServerTotal(items, restaurantId, tables);   // quote↔order parity: same source
  if (totalError) return { ok: false, status: 400, body: { error: 'bad_cart' } };
  const prep = await prepareRedemption(db, { redeem, items, restaurantId, itemsText: '', totalLempiras: total, customerUid, tables });
  if (!prep.ok) return prep;
  const node = (await db.ref(`user_rewards/${customerUid}/${restaurantId}`).get()).val() || {};
  const available = (Number(node.balance) || 0) - (Number(node.reserved) || 0);
  const cost = prep.redemption.cost;
  if (available < cost) return { ok: false, status: 409, body: { error: 'redemption_reserve_failed', reason: 'insufficient' } };
  const p = prep.priced;
  const savings_cents = prep.freeItems.reduce((s, fi) => s + (Number(fi.price_cents) || 0) * (Number(fi.qty) || 1), 0);
  return { ok: true, discount_cents: p.discount_cents, total_cents: p.total_cents, subtotal_cents: p.subtotal_cents, tax_cents: p.tax_cents,
    free_items: prep.freeItems.map((fi) => ({ item_id: fi.item_id, qty: fi.qty, name: fi.name, price_cents: fi.price_cents })),
    free_item: { name: prep.freeName || null },   // back-compat singular (first item)
    total_cost: cost, remaining: available - cost, savings_cents };
}

module.exports = { prepareRedemption, resolveRedemptionForOrder, quoteRedemptionCore, fingerprintExtra };
