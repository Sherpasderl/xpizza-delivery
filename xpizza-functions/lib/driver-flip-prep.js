'use strict';
// S1a (PLAN-S1 §13/§14, advisor condition 1) — the FLIP-PREP READINESS gate.
//
// The §13 operational-reader eligibility FILTERING (dispatch roster/picker, isOnShift, countDriverSupply + their
// pinned-module inverses) is DEFERRED to a flip-prep slice — it is inert in tolerant/dark and would otherwise disturb
// pinned order-path modules for no behavioural change before the flip. To make that deferral SAFE, the enforcement
// flip to 'closed' is HARD-GATED on this readiness flag: the flip writer (scripts/set-driver-enforcement-mode.js)
// refuses to set 'closed' until the flip-prep slice flips FLIP_PREP_READY to true (after it ships the reader
// filtering + pinned inverses + codex + gate). So the closed flip can never outrun the reader filtering.
const FLIP_PREP_READY = false;   // ⚠️ set true ONLY by the flip-prep slice — never standalone.

// Pure decision for the flip writer. Returns the value to write at platform_config/driver_enforcement_mode:
// 'closed' to enforce (allowed only when ready), or null to be tolerant (absent key = tolerant = the dark default).
function decideEnforcementWrite(mode, flipReady = FLIP_PREP_READY) {
  if (mode === 'closed' && !flipReady) {
    return { ok: false, reason: 'FLIP_PREP_READY is false — the §13 reader filtering is not shipped; refusing to enforce closed mode (flip-prep slice must land + flip the flag first).' };
  }
  if (mode !== 'closed' && mode !== 'tolerant') return { ok: false, reason: `unknown enforcement mode: ${JSON.stringify(mode)} (expected 'tolerant' or 'closed')` };
  return { ok: true, value: mode === 'closed' ? 'closed' : null };
}

module.exports = { FLIP_PREP_READY, decideEnforcementWrite };
