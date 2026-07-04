// Pure, dependency-free KDS ready-nudge logic (browser ESM, node-testable via ready-nudge.test.mjs).
// Phase 1 · Step 2 — the v0 overdue nudge. Eligibility from CANONICAL Firebase status + order_timelines
// stamps ONLY (never rendered class / column / localState / estado). See PHASE1_STEP2_KDS_NUDGE.md (rev-3).
// The controller (in index.html) is a thin DOM shell over these pure helpers.

export const DEFAULT_PREP_THRESHOLD_MIN = 25; // fail-closed conservative default (never nudge-spam)

// Known KDS hosts → restaurant. R4: x_pizza KDS host confirmed live = xpizzakitchendisplay.netlify.app
// (NOT the stale order-filter.test.mjs value xpizzakitchen.netlify.app). Matches the exact prod host OR
// its Netlify preview form (deploy-preview-N--<host>), mirroring order-filter.js kdsRestaurantFromHost.
const KDS_HOSTS = {
  'xpizzakitchendisplay.netlify.app': 'x_pizza',
  'lamusakitchendisplay.netlify.app': 'la_musa',
};

// The nudge's OWN host classifier — strict allowlist. Unknown/custom host → null (nudge disabled), so we
// never borrow x_pizza's threshold for an unrecognized host (#8). Distinct from kdsRestaurantFromHost,
// which fails SAFE to x_pizza for order filtering.
export function nudgeRestaurantFromHost(host) {
  const h = host || '';
  for (const known of Object.keys(KDS_HOSTS)) {
    if (h === known || h.endsWith('--' + known)) return KDS_HOSTS[known];
  }
  return null;
}
export const isKnownKdsHost = (host) => nudgeRestaurantFromHost(host) !== null;

export function resolveThreshold(v) {
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : DEFAULT_PREP_THRESHOLD_MIN;
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Canonical eligibility. `order` = raw Firebase /orders/{id} record (o.status). `timeline` =
// order_timelines/{id} node (preparing_at, ready_at). NO created_at fallback (#3): if preparing_at is
// absent the nudge fail-closes. Returns { nudge, reason }.
export function nudgeEligibility(order, timeline, thresholdMin, nowMs) {
  const o = order || {};
  const t = timeline || {};
  if (o.status !== 'preparing') return { nudge: false, reason: 'not_preparing' };
  if (isNum(t.ready_at)) return { nudge: false, reason: 'already_ready' };   // defense-in-depth vs a race
  if (!isNum(t.preparing_at)) return { nudge: false, reason: 'no_preparing_at' }; // fail-closed; created_at NEVER used
  const thresholdMs = resolveThreshold(thresholdMin) * 60000;
  return (nowMs - t.preparing_at) >= thresholdMs
    ? { nudge: true, reason: 'overdue' }
    : { nudge: false, reason: 'within_threshold' };
}

// Idempotent class decision (#10): only mutate when desired ≠ current, so re-applies (MutationObserver +
// tick) never churn the DOM. Returns 'add' | 'remove' | 'none'.
export function classAction(hasClass, nudge) {
  if (nudge && !hasClass) return 'add';
  if (!nudge && hasClass) return 'remove';
  return 'none';
}

// Edge-triggered beep decision (#9 first-load seed + #4 DOM-miss defer). `prev` = last known eligibility
// for this order (undefined on first sight). Returns { beep, newState }:
//   - first sight (prev===undefined): seed to current eligibility, NEVER beep (no page-load storm).
//   - transition false→true with the card present: beep once, advance state.
//   - transition false→true but card MISSING: do NOT beep and do NOT advance (so it beeps when the card
//     later renders — the DOM miss must not consume the beep).
//   - otherwise: no beep, state follows eligibility (recovery re-arms a future beep).
export function nextBeepState(prev, isEligible, cardPresent) {
  if (prev === undefined) return { beep: false, newState: !!isEligible };
  if (isEligible && !prev) {
    return cardPresent ? { beep: true, newState: true } : { beep: false, newState: false };
  }
  return { beep: false, newState: !!isEligible };
}
