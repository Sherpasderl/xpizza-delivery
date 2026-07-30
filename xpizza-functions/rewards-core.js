'use strict';

// Pure earn-engine core for the per-brand rewards program (Phase A). Config + earn math + ledger-entry
// builder — zero deps, no I/O, never throws. Drives the impure rewards-earn.js. Hidden balances; no
// money-path. Locked earn config (owner): X. Pizza = 1 punch per pizza, welcome 2; La Musa = 10 points
// per 30 L (from subtotal_cents), welcome 100. Redemption thresholds are Phase B (not here).
const REWARDS_CONFIG_VERSION = 1;
const REWARDS_CONFIG = {
  // `goal` = the FIRST-reward display threshold (a mirror of the redemption config, rewards-redeem-config.js:
  // X. Pizza punch card_size 8 / La Musa first tier cost 300). Display-only — stamped into earn_preview so the
  // tracker/success reward card embed ZERO reward constants (drift-proof). Hand-synced with the redemption config.
  x_pizza: { kind: 'punch', welcome: 2, goal: 8 },
  la_musa: { kind: 'points', pointsPer: 10, perCents: 3000, welcome: 100, goal: 300 },
};

// computeEarn({items, subtotalCents, restaurantId}) → {delta:<int>, unit}. x_pizza: Σ positive-int qty
// (every x_pizza line is a pizza) → punches. la_musa: floor(subtotalCents / 3000) * 10 → points. Unknown
// restaurant / non-array items / non-finite subtotal → delta 0 (fail-safe).
function computeEarn({ items, subtotalCents, restaurantId } = {}) {
  const cfg = REWARDS_CONFIG[restaurantId];
  if (!cfg) return { delta: 0, unit: 'point' };
  if (cfg.kind === 'punch') {
    if (!Array.isArray(items)) return { delta: 0, unit: 'punch' };
    let n = 0;
    for (const it of items) { const q = Number(it && it.qty); if (Number.isInteger(q) && q > 0) n += q; }
    return { delta: n, unit: 'punch' };
  }
  const c = Number(subtotalCents);
  if (!Number.isFinite(c) || c <= 0) return { delta: 0, unit: 'point' };
  return { delta: Math.floor(c / cfg.perCents) * cfg.pointsPer, unit: 'point' };
}

// earn_preview (reward card) — the DISPLAY preview of what an order earns + the reward context, stamped on
// order_tracking for the tracker (the success card computes the same client-side). { unit, delta } come from
// computeEarn (the SAME function the authoritative earnRewardsOnCompletion uses → the preview never disagrees
// with what credits); welcome + goal are the display constants so the tracker embeds none. Writes NOTHING to
// balances. delta 0 → still return the shape (card shows welcome-only proximity).
function earnPreview({ items, subtotalCents, restaurantId, redemption } = {}) {
  const { delta, unit } = computeEarn({ items, subtotalCents, restaurantId });
  // delta MUST equal what actually credits (rewards-earn.js creditEarnForOrder): an X. Pizza `discount`
  // redemption frees ONE pizza base unit → −1 punch. Apply the SAME adjustment so preview === credited for
  // ALL orders. (Guests can't redeem → no adjustment; La Musa add_free's free item is a 0-price line absent
  // from subtotal_cents → its points-earn is already correct, no adjustment.)
  const adjusted = (redemption && redemption.model === 'discount') ? Math.max(0, delta - 1) : delta;
  const cfg = REWARDS_CONFIG[restaurantId] || {};
  return { unit, delta: adjusted, welcome: cfg.welcome || 0, goal: cfg.goal || 0 };
}

// Earn fires ONLY on an order's real terminal state: delivery completes at 'delivered', pickup at
// 'completed'. 'ready' is pre-collection and must NOT earn. Pure gate for the earnRewardsOnCompletion
// trigger (mirrors the shouldSendOrderReceived / decideStatusMirror predicate split).
function shouldEarnOnStatus(after) {
  return after === 'delivered' || after === 'completed';
}

// Immutable append-only ledger entry — always stamps ts + config_version; drops null-valued optional keys.
function ledgerEntry({ type, delta, orderId = null, redemptionId = null, now, note = null }) {
  const e = { type, delta, ts: now, config_version: REWARDS_CONFIG_VERSION };
  if (orderId != null) e.order_id = orderId;
  if (redemptionId != null) e.redemption_id = redemptionId;
  if (note != null) e.note = note;
  return e;
}

module.exports = { REWARDS_CONFIG, REWARDS_CONFIG_VERSION, computeEarn, earnPreview, shouldEarnOnStatus, ledgerEntry };
