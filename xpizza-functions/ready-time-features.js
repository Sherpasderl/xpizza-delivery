'use strict';

/**
 * Ready-Time Phase 1 · Step 0 — pure feature-extraction + label helpers for the ready-time predictor.
 *
 * PURE: no db, no I/O (extract-then-golden pattern, like order-lifecycle.js). Consumed at prediction
 * time (Step 3) and eval (Step 4); introduces no behavior change. See PHASE1_STEP0_SCHEMA_ELIGIBILITY.md
 * (rev-3): §3 feature contract, §3 extractLabels self-guard.
 */

const TZ_OFFSET_MS = 6 * 3600000; // America/Tegucigalpa = UTC−6, no DST
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const normRid = (rid) => rid || 'x_pizza';

// hour-of-day / day-of-week in fixed UTC−6 (NOT server-local) so buckets are region-stable.
function localTemporal(ms) {
  if (!isNum(ms)) return { hour_of_day: null, day_of_week: null };
  const d = new Date(ms - TZ_OFFSET_MS);
  return { hour_of_day: d.getUTCHours(), day_of_week: d.getUTCDay() };
}

// extractCreationFeatures — the immutable to:'new' feature contract.
// Ephemeral congestion/supply come ONLY from the CHOSEN to:'new' order_events row (never recomputed
// from current /orders). Deterministic selection: among to:'new' rows with a numeric `at`, pick the
// minimum by the tuple (at, eventId) — at ascending, ties broken by lexicographic eventId. Rows with a
// non-numeric/missing `at` are quarantined (ignored). Returns null if none remain (not predictable).
// Stable order-composition (item_count) is joined from /orders and frozen into the snapshot.
function extractCreationFeatures(events, order, timeline) {
  const candidates = Object.entries(events || {})
    .filter(([, e]) => e && e.to === 'new' && isNum(e.at))
    .sort(([idA, a], [idB, b]) => (a.at - b.at) || (idA < idB ? -1 : idA > idB ? 1 : 0));
  if (candidates.length === 0) return null;

  const [source_event_id, chosen] = candidates[0];
  const o = order || {};
  const t = timeline || {};
  const rid = normRid(chosen.restaurant_id);

  // item_count: explicit per-restaurant schema. x_pizza from order.items.length; la_musa has no items
  // array (external_pos) → null, and items_text is NEVER parsed as a proxy (blueprint §la_musa parity).
  const item_count = rid === 'la_musa'
    ? null
    : (Array.isArray(o.items) ? o.items.length : null);

  // accept_latency_ms diagnostic: preparing_at − new_at, only when both numeric and ordered.
  const accept_latency_ms = (isNum(t.new_at) && isNum(t.preparing_at) && t.preparing_at >= t.new_at)
    ? t.preparing_at - t.new_at
    : null;

  const features = {
    kitchen_load_ahead: chosen.kitchen_load_ahead,
    drivers_available: chosen.drivers_available,
    drivers_on_shift: chosen.drivers_on_shift,
    ...localTemporal(t.new_at),
    item_count,
    accept_latency_ms,
  };
  return { features, source_event_id };
}

// extractLabels — derive the training deltas, guarding EACH delta by ITS OWN endpoint pair only, so a
// violation in one pair never nulls an unrelated delta (rev-3 §3, R2 refinement). Self-guarding: never
// emits a negative/nonsensical delta even if called without timelineSanity first.
function extractLabels(timeline) {
  const t = timeline || {};
  const label_issues = [];
  const coerce = (x) => (isNum(x) ? x : null);

  // delta = bVal − aVal, valid iff both endpoints present+numeric and ordered (bVal ≥ aVal).
  // Missing (absent) endpoints → null with NO issue (missing intermediates are allowed).
  const delta = (aName, aVal, bName, bVal, deltaName) => {
    const aMissing = aVal === undefined || aVal === null;
    const bMissing = bVal === undefined || bVal === null;
    if (aMissing || bMissing) return null; // one endpoint simply absent — not an error
    if (!isNum(aVal)) { label_issues.push(`nonnum:${aName}`); }
    if (!isNum(bVal)) { label_issues.push(`nonnum:${bName}`); }
    if (!isNum(aVal) || !isNum(bVal)) return null;
    if (bVal < aVal) { label_issues.push(`neg:${deltaName}`); return null; }
    return bVal - aVal;
  };

  const { new_at, preparing_at, ready_at, out_for_delivery_at } = t;
  return {
    new_at: coerce(new_at),
    preparing_at: coerce(preparing_at),
    ready_at: coerce(ready_at),
    out_for_delivery_at: coerce(out_for_delivery_at),
    accept_latency_ms: delta('new_at', new_at, 'preparing_at', preparing_at, 'accept_latency'),
    prep_ms_from_preparing: delta('preparing_at', preparing_at, 'ready_at', ready_at, 'prep_from_preparing'),
    prep_ms_from_new: delta('new_at', new_at, 'ready_at', ready_at, 'prep_from_new'),
    label_issues,
  };
}

// ── Step-3 bucket helpers — take an EXPLICIT `at` anchor (the chosen to:'new' event.at), NEVER
//    timeline.new_at, which is a separate lagging transaction (R2-#2). Pure; used by both triggers so the
//    prediction bucket and the model-update bucket are computed identically. ──

// hour-of-day (0–23) in fixed UTC−6 from an explicit ms anchor.
const hourOf = (atMs) => (isNum(atMs) ? new Date(atMs - TZ_OFFSET_MS).getUTCHours() : null);

// Daypart from the anchor: late (22–4) / morning (5–10) / lunch (11–15) / dinner (16–21).
function daypartOf(atMs) {
  const h = hourOf(atMs);
  if (h === null) return 'na';
  if (h < 5) return 'late';
  if (h < 11) return 'morning';
  if (h < 16) return 'lunch';
  if (h < 22) return 'dinner';
  return 'late';
}

// kitchen_load_ahead bucket — SAME cut points as ready-time-quality.js loadBucket (0 / 1-2 / 3-5 / 6+).
function loadBucketOf(n) {
  if (!isNum(n)) return 'na';
  if (n <= 0) return '0';
  if (n <= 2) return '1-2';
  if (n <= 5) return '3-5';
  return '6+';
}

// item_count bucket (x_pizza composition). 0/invalid → na.
function itemCountBucketOf(n) {
  if (!isNum(n) || n < 1) return 'na';
  if (n <= 1) return '1';
  if (n <= 3) return '2-3';
  return '4+';
}

// Composite bucket keys. exact = hour × load × items; daypart = daypart × load (the fallback level).
const bucketKeyExact = (atMs, kitchenLoadAhead, itemCount) => `${hourOf(atMs)}|${loadBucketOf(kitchenLoadAhead)}|${itemCountBucketOf(itemCount)}`;
const bucketKeyDaypart = (atMs, kitchenLoadAhead) => `${daypartOf(atMs)}|${loadBucketOf(kitchenLoadAhead)}`;

// pickNewEventEntry — the deterministic chosen to:'new' entry { id, event } from an order_events map: the
// min by (at, eventId) among to:'new' rows with a numeric `at`. Returning the eventId (not just the row)
// lets BOTH triggers agree on the SAME anchor event under a bounce / two-to:'new' race: Trigger A only
// predicts when ITS eventId is this winner, and Trigger B recovers the identical row. Returns null if none.
function pickNewEventEntry(events) {
  const c = Object.entries(events || {})
    .filter(([, e]) => e && e.to === 'new' && isNum(e.at))
    .sort(([ia, a], [ib, b]) => (a.at - b.at) || (ia < ib ? -1 : ia > ib ? 1 : 0));
  return c.length ? { id: c[0][0], event: c[0][1] } : null;
}
// pickNewEvent — the winner's row (or null). Delegates to pickNewEventEntry (single source of the rule).
const pickNewEvent = (events) => { const e = pickNewEventEntry(events); return e ? e.event : null; };

module.exports = {
  extractCreationFeatures, extractLabels, TZ_OFFSET_MS,
  hourOf, daypartOf, loadBucketOf, itemCountBucketOf, bucketKeyExact, bucketKeyDaypart, pickNewEvent, pickNewEventEntry,
};
