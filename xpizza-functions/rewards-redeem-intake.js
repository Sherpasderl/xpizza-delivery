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
const { computeServerTotal } = require('./menu-pricing');   // B2 quote: server-priced cart (same as intake)

// Mirrors index.js sanitizeText (strip <>, control chars, trim, cap) — the free-item display NAME is
// client text; price + eligibility are server-derived from item_id + tier, so the name is display-only.
function sanitizeName(v, maxLen = 80) {
  const s = (v == null ? '' : String(v)).replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// prepareRedemption — the gate/compute/price/append phase with NO reserve. Online (chargeOnlineOrder) calls
// this BEFORE its two fingerprint sites (so both fingerprints + the pending order carry the discounted total),
// then reserves separately right before acquireHostedAttempt (so it can release on abandoned acquire outcomes).
// Cash uses the combined resolveRedemptionForOrder below. Returns { ok:false, status, body } or
// { ok:true, redemption, canonical, priced, itemsText, freeName }.
async function prepareRedemption(db, { redeem, items, restaurantId, itemsText, totalLempiras, customerUid }) {
  // B2: uid FIRST — the flag now keys on the verified uid (redemptionEnabled(db, uid) checks the canary
  // allowlist for this account). A flag-OFF guest returns login_required (was rewards_disabled); both are
  // non-payable and a guest never sends `redeem`, so this reorder is inert for guests.
  if (!customerUid) return { ok: false, status: 401, body: { error: 'login_required', detail: 'redemption requires a verified account' } };   // NOT guest fail-open
  if (!(await redemptionEnabled(db, customerUid))) return { ok: false, status: 409, body: { error: 'rewards_disabled' } };   // global flag OR this uid's canary allowlist
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

  return { ok: true, redemption, canonical: redemption.canonical, priced, itemsText: outText, freeName };
}

// Combined intake for the CASH path (createOrder): prepare + reserve (bound to the order fingerprint).
async function resolveRedemptionForOrder(db, { redeem, items, restaurantId, orderId, customerUid, itemsText, totalLempiras, schedExtra, now }) {
  const prep = await prepareRedemption(db, { redeem, items, restaurantId, itemsText, totalLempiras, customerUid });
  if (!prep.ok) return prep;
  const fp = orderFingerprint(orderId, prep.priced.total_cents, prep.itemsText, schedExtra || '');               // bind the hold to THIS order (discounted total + final items_text)
  const rr = await reserveRedemption(db, { uid: customerUid, rid: restaurantId, orderId, cost: prep.redemption.cost,
    canonical: prep.canonical, orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now });           // debit-first, idempotent
  if (!rr.ok) return { ok: false, status: 409, body: { error: 'redemption_reserve_failed', reason: rr.reason } };

  return { ok: true, canonical: prep.canonical, priced: prep.priced, itemsText: prep.itemsText,
    ownsHold: (rr.action === 'created' || rr.action === 're_reserved'), freeName: prep.freeName };
}

// quoteRedemptionCore (B2) — the READ-ONLY redemption preview for the checkout review (screen 5). Runs the
// SAME redemption flow as intake (uid-first gate/allowlist → server-priced cart → compute/La-Musa-86/price)
// + a READ-ONLY available projection (balance − reserved ≥ cost, mirroring the reserve's insufficient check)
// — NO reserve, NO order, NO DB write, NO side effects. `customerUid` is the SERVER-verified token uid the
// HTTP handler resolved. Returns { ok:true, discount_cents, total_cents, subtotal_cents, tax_cents,
// free_item:{name} } or { ok:false, status, body } (the SAME typed errors as intake, plus bad_cart).
//
// GUARANTEE (narrowed, plan-gate #1): the quoted discount === the discount submit applies, GIVEN submit
// reaches redemption. It does NOT run submit-only gates (cash placeability, online regular-cart availability),
// so a passing quote can still be rejected by submit as item_unavailable/closed — those are NON-redemption
// rejections the UI routes to the existing cart error paths, never the redemption fallback.
async function quoteRedemptionCore(db, { redeem, items, restaurantId, customerUid }) {
  if (!customerUid) return { ok: false, status: 401, body: { error: 'login_required' } };   // uid-first (matches prepareRedemption)
  const { total, error: totalError } = computeServerTotal(items, restaurantId);             // server-priced — never trust a client total
  if (totalError) return { ok: false, status: 400, body: { error: 'bad_cart' } };           // malformed/tampered cart → fail-closed (matches submit's payload validation)
  const prep = await prepareRedemption(db, { redeem, items, restaurantId, itemsText: '', totalLempiras: total, customerUid });
  if (!prep.ok) return prep;                                                                 // same typed errors as intake (rewards_disabled / redemption_invalid / reward_unavailable / …)
  const node = (await db.ref(`user_rewards/${customerUid}/${restaurantId}`).get()).val() || {};
  const available = (Number(node.balance) || 0) - (Number(node.reserved) || 0);
  if (available < prep.redemption.cost) return { ok: false, status: 409, body: { error: 'redemption_reserve_failed', reason: 'insufficient' } };   // mirrors the reserve; NO reserve taken
  const p = prep.priced;
  return { ok: true, discount_cents: p.discount_cents, total_cents: p.total_cents, subtotal_cents: p.subtotal_cents, tax_cents: p.tax_cents,
    free_item: { name: prep.freeName || (prep.canonical && prep.canonical.free_item_key) || null } };   // la_musa sanitized display name / x_pizza cheapest-pizza name
}

module.exports = { prepareRedemption, resolveRedemptionForOrder, quoteRedemptionCore };
