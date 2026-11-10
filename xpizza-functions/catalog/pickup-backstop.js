'use strict';
// S2-8 (D4c-grill/item-s1/S2-DESIGN.md §1.4 + its option-A addendum; §2 r1 B + C) — THE PICKUP-ONLY BACKSTOP. NEW server
// enforcement (today only clients enforce it): a product in a pickup-only section may not be ordered for delivery.
//   kind 'binding' (createOrder / chargeOnline): refused unless order_type === 'pickup' (mandatory there, validated at intake).
//   kind 'quote'   (quoteOrder / quoteRedemption): refused ONLY on an explicit mode === 'delivery' — the frozen forms send no
//                  mode, so a missing / invalid one skips the check without even reading the gate; the binding endpoints
//                  always judge.
// Each line is judged by its RESOLVED key (the stage's stamp, read through itemPricingKey); a reward by the key its calculator
// consumes. The gate is the PRICED version's (served-version provenance): unauthored ⇒ no check (today), unavailable ⇒ a
// retryable 503 menu_updating (never a silent waiver). Callers place it where nothing has been charged or reserved.
const { itemPricingKey } = require('../menu-pricing');
const { rewardKeysOf } = require('./group-intake');
const { MENU_UPDATING } = require('./menu-gates');

async function pickupRefusal({ restaurantId, versionId, keyMode, kind, body, gates }) {
  const b = body && typeof body === 'object' ? body : {};
  const forDelivery = kind === 'quote' ? b.mode === 'delivery' : b.order_type !== 'pickup';
  if (!forDelivery) return null;
  const keys = [];
  for (const it of Array.isArray(b.items) ? b.items : []) { const k = it && typeof it === 'object' ? itemPricingKey(it, restaurantId, keyMode) : null; if (typeof k === 'string' && k) keys.push(k); }
  for (const k of rewardKeysOf(b.redeem)) keys.push(k);
  if (!keys.length) return null;
  const g = await gates.pickupGateFor(restaurantId, versionId);
  if (g.state === 'unavailable') return { status: 503, body: { ...MENU_UPDATING } };
  if (g.state !== 'ok') return null;
  const hit = keys.find((k) => g.keys.has(k));
  return hit ? { status: 409, body: { ok: false, error: 'pickup_only_item', item_key: hit } } : null;
}

// The card path's fresh-only gate (index.js runGate chain): the same decision, answered in the gate's { refuse } shape, with the
// hold released exactly as the other fresh gates release it (owned-only; a reused hold is the shared refusal cleanup's).
async function pickupGateRefusal(opts, releaseHold) {
  const pk = await pickupRefusal(opts);
  if (!pk) return null;
  await releaseHold();
  return { refuse: pk };
}

module.exports = { pickupRefusal, pickupGateRefusal };
