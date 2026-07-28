'use strict';

// Rewards Phase B1 — shared redemption INTAKE decision for cash createOrder (Task 5) AND online
// chargeOnlineOrder (Task 6). Extracted (like cancelOrderCore / resolve-manual) so the emulator drives the
// real money-path wiring without the Express stack. Enforces the LOCKED authorization precondition, computes
// the reward SERVER-SIDE, availability-gates a La Musa free item, and RESERVES the hold — all before the
// order is written. ALL-OR-NOTHING: any failure returns { ok:false, status, body } and no reserve stands.
//
// On success returns { ok:true, canonical, priced, itemsText, ownsHold, freeName }:
//   canonical  — stamp onto orders/{id}/redemption
//   priced     — discounted breakdown + factura lines (Task 4) for the order write
//   itemsText  — items_text with the La Musa free item appended (KDS/driver/WhatsApp/history)
//   ownsHold   — true iff THIS call took the debit → the caller releases it on write failure (reserveRedemption
//                'reused' = a pre-existing hold → never release)
const { computeRedemption } = require('./rewards-redeem');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
const { reserveRedemption } = require('./rewards-reserve');
const { REDEMPTION_CONFIG_VERSION, redemptionEnabled } = require('./rewards-redeem-config');
const { checkItemAvailability } = require('./availability-gate');
const { orderFingerprint } = require('./pixelpay-charge');

// Mirrors index.js sanitizeText (strip <>, control chars, trim, cap) — the free-item display NAME is
// client text; price + eligibility are server-derived from item_id + tier, so the name is display-only.
function sanitizeName(v, maxLen = 80) {
  const s = (v == null ? '' : String(v)).replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function resolveRedemptionForOrder(db, { redeem, items, restaurantId, orderId, customerUid, itemsText, totalLempiras, schedExtra, now }) {
  if (!(await redemptionEnabled(db))) return { ok: false, status: 409, body: { error: 'rewards_disabled' } };   // flag OFF → non-payable, no silent full-price order
  if (!customerUid) return { ok: false, status: 401, body: { error: 'login_required', detail: 'redemption requires a verified account' } };   // NOT guest fail-open
  const redemption = computeRedemption({ redeem, items, restaurantId });                                         // server-computed reward (never trusts client price/cost)
  if (!redemption.ok) return { ok: false, status: 409, body: { error: 'redemption_invalid', reason: redemption.reason } };

  let outText = itemsText;
  let freeName = null;
  if (redemption.model === 'add_free') {
    const freeGate = await checkItemAvailability(db, [{ id: redemption.freeItem.item_id, qty: 1 }], restaurantId);   // same 86 gate as the cart
    if (freeGate.blocked.length > 0) return { ok: false, status: 409, body: { error: 'reward_unavailable', blocked: freeGate.blocked } };
    freeName = sanitizeName((redeem && redeem.name) || redemption.freeItem.item_id, 80);
    outText = `${itemsText}\n1x ${freeName} (Recompensa)`;                                                       // trusted server-rendered 0-price display line
  }

  const priced = applyRedemptionToPricing({ items, restaurantId, redemption, totalLempiras });                   // discounted, fail-closed reconciling lines
  if (!priced.ok) return { ok: false, status: 409, body: { error: 'redemption_pricing_failed' } };

  const fp = orderFingerprint(orderId, priced.total_cents, outText, schedExtra || '');                           // bind the hold to THIS order (discounted total + final items_text)
  const rr = await reserveRedemption(db, { uid: customerUid, rid: restaurantId, orderId, cost: redemption.cost,
    canonical: redemption.canonical, orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now });     // debit-first, idempotent
  if (!rr.ok) return { ok: false, status: 409, body: { error: 'redemption_reserve_failed', reason: rr.reason } };

  return { ok: true, canonical: redemption.canonical, priced, itemsText: outText,
    ownsHold: (rr.action === 'created' || rr.action === 're_reserved'), freeName };
}

module.exports = { resolveRedemptionForOrder };
