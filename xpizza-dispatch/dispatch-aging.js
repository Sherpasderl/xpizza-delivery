// xpizza-dispatch/dispatch-aging.js
/**
 * Pure order-aging helpers (dispatch Phase 1). Baseline = created-time for the
 * unassigned queue (honest Phase-1 baseline); `now` injected as epoch ms.
 */
export function agingBaselineMs(order) {
  return order && Number.isFinite(order.created_at) ? order.created_at : null;
}

export function agingSeconds(baselineMs, nowMs) {
  // Contract: null / absent / non-finite (either arg) → 0, never NaN or negative.
  if (!Number.isFinite(baselineMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - baselineMs) / 1000));
}

export function agingBand(seconds, thresholds = { amber: 300, red: 600 }) {
  if (seconds >= thresholds.red) return 'red';
  if (seconds >= thresholds.amber) return 'amber';
  return 'green';
}

export function formatAging(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}
