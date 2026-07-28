'use strict';

// Pure earn-engine core for the per-brand rewards program (Phase A). Config + earn math + ledger-entry
// builder — zero deps, no I/O, never throws. Drives the impure rewards-earn.js. Hidden balances; no
// money-path. Locked earn config (owner): X. Pizza = 1 punch per pizza, welcome 2; La Musa = 10 points
// per 25 L (from subtotal_cents), welcome 100. Redemption thresholds are Phase B (not here).
const REWARDS_CONFIG_VERSION = 1;
const REWARDS_CONFIG = {
  x_pizza: { kind: 'punch', welcome: 2 },
  la_musa: { kind: 'points', pointsPer: 10, perCents: 2500, welcome: 100 },
};

// computeEarn({items, subtotalCents, restaurantId}) → {delta:<int>, unit}. x_pizza: Σ positive-int qty
// (every x_pizza line is a pizza) → punches. la_musa: floor(subtotalCents / 2500) * 10 → points. Unknown
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

// Immutable append-only ledger entry — always stamps ts + config_version; drops null-valued optional keys.
function ledgerEntry({ type, delta, orderId = null, redemptionId = null, now, note = null }) {
  const e = { type, delta, ts: now, config_version: REWARDS_CONFIG_VERSION };
  if (orderId != null) e.order_id = orderId;
  if (redemptionId != null) e.redemption_id = redemptionId;
  if (note != null) e.note = note;
  return e;
}

module.exports = { REWARDS_CONFIG, REWARDS_CONFIG_VERSION, computeEarn, ledgerEntry };
