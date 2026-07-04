'use strict';

/**
 * Ready-Time Phase 1 · Step 0 — pure eligibility + filter predicates for the ready-time predictor.
 *
 * Extracted so the training-row gate is golden-testable WITHOUT the emulator (the project's
 * extract-then-golden pattern, mirroring order-lifecycle.js). PURE: no db, no I/O. Consumed at
 * ETL/eval time from the immutable orders ⋈ order_timelines ⋈ order_events join — NEVER by a live
 * order trigger. Introduces no behavior change; see PHASE1_STEP0_SCHEMA_ELIGIBILITY.md (rev-3).
 *
 * Phone exclusion REUSES the exported whatsapp.js normalizePhone (import-safe under bare node) — the
 * denylist key is its exact output form (digits only, no '+', country-code-prefixed). Not forked.
 */

const { normalizePhone } = require('./whatsapp');

const DEFAULT_MAX_PLAUSIBLE_PREP_MS = 3 * 3600000; // 3h fail-closed upper bound for a sane prep label
const TZ_OFFSET_MS = 6 * 3600000;                  // America/Tegucigalpa = UTC−6, no DST

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const normRid = (rid) => rid || 'x_pizza';         // legacy/no-id → x_pizza (mirrors order-lifecycle.js)

// timelineSanity — accept a label row only if present numeric stamps are monotonic:
//   new_at ≤ preparing_at? ≤ ready_at ≤ out_for_delivery_at?   (missing intermediates allowed).
// Returns the FIRST ordering violation found (quarantine signal), else { ok:true, violation:null }.
function timelineSanity(timeline) {
  const t = timeline || {};
  const { new_at, preparing_at, ready_at, out_for_delivery_at } = t;
  if (isNum(new_at) && isNum(preparing_at) && new_at > preparing_at) return { ok: false, violation: 'new>preparing' };
  if (isNum(preparing_at) && isNum(ready_at) && preparing_at > ready_at) return { ok: false, violation: 'preparing>ready' };
  // direct new→ready edge only matters when preparing_at is absent (else the two checks above cover it)
  if (!isNum(preparing_at) && isNum(new_at) && isNum(ready_at) && new_at > ready_at) return { ok: false, violation: 'new>ready' };
  if (isNum(ready_at) && isNum(out_for_delivery_at) && ready_at > out_for_delivery_at) return { ok: false, violation: 'ready>ofd' };
  return { ok: true, violation: null };
}

// nonLabelExclusions — the NON-label exclusions ONLY: epoch cutoff + ops denylists (R6/R7/R8). NO label
// or timeline-sanity gates. Extracted (Step-1a) so the Step-1 data-quality monitor can filter its
// population by these WITHOUT the no_ready_label/no_new_label gates — those drop the exact missed-tap
// rows the monitor exists to count. isTrainingEligible composes it, so its output is byte-identical.
function nonLabelExclusions(order, timeline, cfg) {
  const reasons = [];
  const o = order || {};
  const t = timeline || {};
  const c = cfg || {};
  const rid = normRid(o.restaurant_id);
  const epochMap = c.epoch_start_ms || {};
  const epoch = isNum(epochMap[rid]) ? epochMap[rid] : Infinity; // unset → fail-closed (nothing eligible)
  const excludedPhones = c.excluded_phones || {};
  const excludedOrders = c.excluded_orders || {};

  // R6 — before the per-restaurant go-live epoch (drops the pre-launch synthetic population wholesale).
  if (isNum(t.new_at) && t.new_at < epoch) reasons.push('before_epoch');
  // R7 — ops-maintained phone denylist (reused normalizePhone; null → matches nothing, no throw).
  const phoneKey = normalizePhone(o.customer_phone);
  if (phoneKey && excludedPhones[phoneKey] === true) reasons.push('excluded_phone');
  // R8 — ops-maintained order-id denylist (named known test orders).
  if (o.order_id && excludedOrders[o.order_id] === true) reasons.push('excluded_order');

  return { excluded: reasons.length > 0, reasons };
}

// isTrainingEligible — the shared training-row gate. Collects ALL failing reasons (no short-circuit),
// so eval can attribute exclusions by cohort. cfg is the admin-only ready_time_config (fail-closed
// defaults when absent). Pure; all inputs are plain objects from the ETL join.
function isTrainingEligible(order, timeline, events, cfg) {
  const reasons = [];
  const o = order || {};
  const t = timeline || {};
  const c = cfg || {};
  const maxPrep = isNum(c.max_plausible_prep_ms) ? c.max_plausible_prep_ms : DEFAULT_MAX_PLAUSIBLE_PREP_MS;

  // R1 — not predictable: no to:'new' event with a numeric at (used for predictability/provenance only).
  const hasNewEvent = Object.values(events || {}).some((e) => e && e.to === 'new' && isNum(e.at));
  if (!hasNewEvent) reasons.push('never_new');

  // R2 — no target label.
  if (!isNum(t.ready_at)) reasons.push('no_ready_label');
  // R2b — no label anchor (new_at is the prep denominator; may be missing even when R1 passed).
  if (!isNum(t.new_at)) reasons.push('no_new_label');

  // R3 — timeline-sanity quarantine.
  const s = timelineSanity(t);
  if (!s.ok) reasons.push(`timeline_sanity:${s.violation}`);

  // R4/R5 — prep-magnitude sanity (only when both anchors are numeric; else R2/R2b already flagged).
  if (isNum(t.new_at) && isNum(t.ready_at)) {
    const prep = t.ready_at - t.new_at;
    if (prep <= 0) reasons.push('nonpositive_prep');
    else if (prep > maxPrep) reasons.push('implausible_prep');
  }

  // R6/R7/R8 — non-label exclusions, appended LAST in the same order → output byte-identical to pre-refactor.
  reasons.push(...nonLabelExclusions(o, t, c).reasons);

  return { eligible: reasons.length === 0, reasons };
}

// isValidModelVersion — the {modelVersion} path key must avoid RTDB-forbidden chars ( . $ # [ ] / ).
const isValidModelVersion = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

// assertNonzeroEligibleCounts — the §2e zero-row guard, as a PURE helper so the contract is enforceable
// and tested without any Step-4 ETL machinery. The Step-4 harness computes `counts` and MUST call this
// before emitting success. Non-active restaurants are ignored (intended-empty is explicit); an active
// restaurant that is 0 OR absent from counts is an offender → throw a structured Error.
function assertNonzeroEligibleCounts(counts, activeRestaurants) {
  const cnt = counts || {};
  const active = activeRestaurants || [];
  const offenders = active
    .filter((r) => !(isNum(cnt[r]) && cnt[r] > 0))
    .map((r) => ({ restaurant_id: r, count: isNum(cnt[r]) ? cnt[r] : 0 }));
  if (offenders.length > 0) {
    const err = new Error(`ready-time: zero eligible training rows for active restaurant(s): ${offenders.map((o) => o.restaurant_id).join(', ')}`);
    err.name = 'ZeroEligibleRowsError';
    err.code = 'ZERO_ELIGIBLE_ROWS';
    err.offenders = offenders;
    err.counts = cnt;
    throw err;
  }
  return { ok: true, counts: cnt };
}

module.exports = { timelineSanity, isTrainingEligible, isValidModelVersion, assertNonzeroEligibleCounts, nonLabelExclusions, TZ_OFFSET_MS, DEFAULT_MAX_PLAUSIBLE_PREP_MS };
