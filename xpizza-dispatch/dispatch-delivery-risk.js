// xpizza-dispatch/dispatch-delivery-risk.js
/**
 * Pure delivery-risk classifier (dispatch Phase 1). Returns BOTH the aging `band`
 * (drives the row edge) and the risk `level` (drives the Torre header count), using
 * the SAME agingBand as the rows so the two can never diverge. Amber band alone is a
 * heads-up (level 'ok'); only red-aging and slip count. NEVER a promise-based "late-by":
 * with no observed baseline the slip comparison is suppressed and only aging is used.
 */
import { agingBand } from './dispatch-aging.js';

export function deliveryRisk({
  agingSeconds,
  agingThresholds = { amber: 300, red: 600 },
  baselineArrivalMs = null,
  currentArrivalMs = null,
  slipThresholdMs = 240000,   // 4 min slip vs first observed
}) {
  const band = agingBand(agingSeconds, agingThresholds);
  const agingLevel = band === 'red' ? 'aging' : 'ok';   // amber alone does NOT count
  // No baseline (browser opened mid-delivery / no ETA observed yet) → aging only.
  if (baselineArrivalMs == null || currentArrivalMs == null) {
    return { band, level: agingLevel, slipMs: null };
  }
  const slipMs = currentArrivalMs - baselineArrivalMs;
  if (slipMs >= slipThresholdMs) return { band, level: 'slipping', slipMs };
  return { band, level: agingLevel, slipMs };
}
