'use strict';
// PER-PRODUCT EXTRAS — ROLLBACK SAFETY (PLAN-per-product-extras rev 2.2 §4 "Rollback targets while non-off"; codex stage-2
// r1 P1-2). A version published before this feature has NO eligibility document, and under shadow/enforce such a version
// makes every fresh checkout `unavailable` — rolling back to it would take the restaurant's checkout down. So:
//
//   target HAS its document          → allowed (whatever the mode)
//   target has NONE, mode is 'off'   → allowed (an affirmative off: a successful read of the absent node counts — §4 ruling)
//   target has NONE, mode non-off    → REFUSED  rollback_pre_baseline_while_non_off  (set the mode to off first)
//   target has NONE, mode unknown    → REFUSED  rollback_extras_mode_unknown  (retry; the check is never skipped)
//   no mode reader supplied          → REFUSED  rollback_extras_mode_unconfirmed  (a caller cannot skip it by omission)
//   the document cannot be read      → REFUSED  rollback_eligibility_unreadable  (a read error is not absence)
//
// Brand-agnostic: nothing here names a restaurant; the mode is platform-wide and the document is per version.
const { readEligibility } = require('./extras-eligibility-store');
const { createExtrasModeReader } = require('./extras-intake');

function refusal(code, detail, retryable = false) {
  const e = new Error(`${code}: ${detail}`);
  e.code = code;
  if (retryable) e.retryable = true;
  return e;
}

async function assertRollbackTargetEligible(db, rid, versionId, readExtrasMode) {
  let doc;
  try { doc = await readEligibility(db, rid, versionId); } catch (e) {
    throw refusal('rollback_eligibility_unreadable', `${rid}/${versionId}: ${String((e && e.message) || e).slice(0, 160)}`, true);
  }
  if (doc) return { allowed: true, why: 'has_document' };
  if (typeof readExtrasMode !== 'function') {
    throw refusal('rollback_extras_mode_unconfirmed', `${rid}/${versionId} has no extras eligibility document (pre-baseline) and the extras mode was not read — pass readExtrasMode`);
  }
  // a FRESH reader: an admin decision is never made on another request's cached mode
  const { mode } = await createExtrasModeReader({ read: readExtrasMode }).getMode();
  if (mode === 'off') return { allowed: true, why: 'mode_off' };
  if (mode === 'unknown') throw refusal('rollback_extras_mode_unknown', `${rid}/${versionId} is pre-baseline and the extras mode could not be read — retry`, true);
  throw refusal('rollback_pre_baseline_while_non_off', `${rid}/${versionId} has no extras eligibility document; under mode '${mode}' it would make checkout unavailable — set platform_config/extras_eligibility to 'off' first`);
}

module.exports = { assertRollbackTargetEligible };
