'use strict';

/**
 * Ready-Time Phase 1 · Step 1a — pure data-quality-monitor helpers.
 *
 * PURE: no db, no I/O (extract-then-golden, like order-lifecycle.js / ready-time-eligibility.js).
 * Consumed by the Step-1b observer runner (offline replay) and by the C1/C2 gates. Observer-only;
 * introduces no behavior change. See PHASE1_STEP1_DATA_QUALITY_MONITOR.md (rev-3).
 *
 * Governing principle: a data-quality monitor must never let a capture failure hide as a pass — so the
 * population is defined INDEPENDENTLY of the label gates (missed taps are the signal), and every metric
 * is guarded (finite/denominator/coverage) before it can contribute to a passing verdict.
 */

const { timelineSanity, nonLabelExclusions, TZ_OFFSET_MS } = require('./ready-time-eligibility');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const normRid = (rid) => rid || 'x_pizza';
const TERMINAL = new Set(['out_for_delivery', 'delivered']);
const KITCHEN_FROM = new Set(['preparing', 'ready']);
const RUSH_EVENTS = new Set(['new', 'preparing', 'out_for_delivery']); // taps skipped at completion → include OFD
const ORDERED_BUCKETS = ['0', '1-2', '3-5', '6+'];

// hour-of-day in fixed UTC−6 (Step-0 convention).
const hourUTCminus6 = (ms) => String(new Date(ms - TZ_OFFSET_MS).getUTCHours());

// rushProxyLoad — the peak congestion the order actually saw: max kitchen_load_ahead across its
// {new, preparing, out_for_delivery} events (OFD is the completion moment a tap is skipped at). null
// when no such event carries a numeric load.
function rushProxyLoad(events) {
  let max = null;
  for (const e of Object.values(events || {})) {
    if (e && RUSH_EVENTS.has(e.to) && isNum(e.kitchen_load_ahead)) {
      max = max === null ? e.kitchen_load_ahead : Math.max(max, e.kitchen_load_ahead);
    }
  }
  return max;
}

const loadBucket = (n) => (n === null || n === undefined ? 'unknown' : n <= 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : '6+');

// percentile — nearest-rank (deterministic; documented).
function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

// Deterministic first to:'new' event (numeric at), by the (at, eventId) tie-break — mirrors the Step-0
// feature contract. Returns the row (with .at) or null.
function pickNewEvent(events) {
  const c = Object.entries(events || {})
    .filter(([, e]) => e && e.to === 'new' && isNum(e.at))
    .sort(([ia, a], [ib, b]) => (a.at - b.at) || (ia < ib ? -1 : ia > ib ? 1 : 0));
  return c.length ? c[0][1] : null;
}

// isMonitorPopulation — INDEPENDENT of the label gates. Included iff a numeric to:'new' EVENT exists
// (a real order that reached 'new') AND it is not epoch/denylist-excluded. NOT conditioned on the
// timeline.new_at STAMP — a missing stamp is a capture failure to MEASURE (new_at_missingness), not drop.
function isMonitorPopulation(order, timeline, events, cfg) {
  const reasons = [];
  if (!pickNewEvent(events)) reasons.push('no_new_event');
  reasons.push(...nonLabelExclusions(order, timeline, cfg).reasons);
  return { included: reasons.length === 0, reasons };
}

// Classify one order's terminal reach from its events (transition-path inference — events record the
// transition, not the actor). cleanupSet = `from>to` strings classified as cleanup/test (exempt).
function classifyTerminal(events, cleanupSet) {
  const terminals = Object.values(events || {}).filter((e) => e && TERMINAL.has(e.to));
  const isTerminal = terminals.length > 0;
  const kitchenPath = terminals.some((e) => KITCHEN_FROM.has(e.from));
  const allCleanup = isTerminal && terminals.every((e) => cleanupSet.has(`${e.from}>${e.to}`));
  return { isTerminal, kitchenPath, nonKitchen: isTerminal && !kitchenPath && !allCleanup };
}

// summarize — raw metric bundle over a set of population rows (no threshold-derived fields).
function summarize(rows, cfg) {
  const cleanupSet = new Set((cfg && cfg.cleanup_paths) || []);
  const byLoad = {};
  const dwell = [];
  let nPop = 0, nTerminal = 0, nKitchen = 0, nNonKitchen = 0, hitsKitchen = 0;
  let newMissing = 0, prepMissing = 0, unknownLoad = 0, nMulti = 0, impossible = 0;

  for (const r of rows) {
    const t = r.timeline || {};
    nPop++;
    if (!isNum(t.new_at)) newMissing++;
    if (!isNum(t.preparing_at)) prepMissing++;

    const rush = rushProxyLoad(r.events);
    if (rush === null) unknownLoad++;

    const { isTerminal, kitchenPath, nonKitchen } = classifyTerminal(r.events, cleanupSet);
    if (isTerminal) nTerminal++;
    if (nonKitchen) nNonKitchen++;
    if (kitchenPath) {
      nKitchen++;
      const bucket = loadBucket(rush);
      byLoad[bucket] = byLoad[bucket] || { n: 0, hits: 0 };
      byLoad[bucket].n++;
      if (isNum(t.ready_at)) { byLoad[bucket].hits++; hitsKitchen++; }
    }

    // impossible-timeline rate over rows with ≥2 numeric stamps
    const stamps = ['new_at', 'preparing_at', 'ready_at', 'out_for_delivery_at'].filter((k) => isNum(t[k]));
    if (stamps.length >= 2) { nMulti++; if (!timelineSanity(t).ok) impossible++; }

    // dwell over tapped + sane ready→ofd
    if (isNum(t.ready_at) && isNum(t.out_for_delivery_at) && t.out_for_delivery_at >= t.ready_at) {
      dwell.push(t.out_for_delivery_at - t.ready_at);
    }
  }

  for (const b of Object.keys(byLoad)) byLoad[b].tap_rate = byLoad[b].n > 0 ? byLoad[b].hits / byLoad[b].n : null;

  return {
    n_population: nPop,
    n_terminal: nTerminal,
    n_kitchen_path: nKitchen,
    n_non_kitchen_path: nNonKitchen,
    tap_rate: nKitchen > 0 ? hitsKitchen / nKitchen : null,
    by_load: byLoad,
    impossible_timeline_rate: nMulti > 0 ? impossible / nMulti : null,
    n_multi_stamp: nMulti,
    new_at_missingness: nPop > 0 ? newMissing / nPop : null,
    preparing_at_missingness: nPop > 0 ? prepMissing / nPop : null,
    non_kitchen_path_share: nTerminal > 0 ? nNonKitchen / nTerminal : null,
    unknown_load: { n: unknownLoad, share: nPop > 0 ? unknownLoad / nPop : null },
    tapped_sane_ready_to_ofd_ms: {
      n: dwell.length,
      p25: percentile(dwell, 25), median: percentile(dwell, 50), p75: percentile(dwell, 75), p90: percentile(dwell, 90),
    },
  };
}

// rush_bias = tap_rate(highest sufficient load bucket) / tap_rate(lowest sufficient) — contrast across
// the load spectrum, NOT top-vs-overall (which dilutes). "sufficient" = n ≥ min_bucket_n.
function rushBiasFromLoad(byLoad, minBucketN) {
  const present = ORDERED_BUCKETS.filter((b) => byLoad[b] && byLoad[b].n > 0);
  const sufficient = present.filter((b) => byLoad[b].n >= minBucketN);
  const topPresent = present[present.length - 1];
  const top_present_insufficient = !!topPresent && byLoad[topPresent].n < minBucketN;
  if (sufficient.length < 2) return { rush_bias: null, top_tap_rate: null, n_sufficient: sufficient.length, top_present_insufficient };
  const hi = byLoad[sufficient[sufficient.length - 1]].tap_rate;
  const lo = byLoad[sufficient[0]].tap_rate;
  return { rush_bias: hi / lo, top_tap_rate: hi, n_sufficient: sufficient.length, top_present_insufficient };
}

// isCaptureAcceptable — fail-closed segment/bundle verdict. Requires SIGNED thresholds; rejects
// non-finite metrics / empty denominators before any threshold compare.
function isCaptureAcceptable(bundle, thresholds) {
  const th = thresholds;
  if (!th || !th.version || th.approved_at == null) return { acceptable: false, reasons: ['unsigned_thresholds'] };
  const reasons = [];

  if (bundle.tap_rate === null || !(bundle.n_kitchen_path > 0)) reasons.push('empty_denominator');
  else if (!Number.isFinite(bundle.tap_rate)) reasons.push('non_finite_metric');

  if (bundle.n_kitchen_path < th.min_segment_n) reasons.push('insufficient_sample');
  if (Number.isFinite(bundle.tap_rate) && bundle.tap_rate < th.min_tap_rate) reasons.push('low_tap_rate');

  const rb = rushBiasFromLoad(bundle.by_load || {}, th.min_bucket_n);
  if (rb.top_present_insufficient) reasons.push('insufficient_load_bucket');
  if (rb.n_sufficient < 2) reasons.push('insufficient_load_coverage');
  else if (!Number.isFinite(rb.rush_bias) || !Number.isFinite(rb.top_tap_rate)) reasons.push('non_finite_metric');
  else {
    if (rb.rush_bias < th.min_rush_bias) reasons.push('rush_biased_capture');
    if (rb.top_tap_rate < th.min_top_tap_rate) reasons.push('low_top_tap_rate');
  }

  if (Number.isFinite(bundle.impossible_timeline_rate) && bundle.impossible_timeline_rate > th.max_impossible_rate) reasons.push('high_impossible_rate');
  if (bundle.unknown_load && Number.isFinite(bundle.unknown_load.share) && bundle.unknown_load.share > th.max_unknown_load_share) reasons.push('unknown_load_excess');
  if (Number.isFinite(bundle.new_at_missingness) && bundle.new_at_missingness > th.max_new_at_missingness) reasons.push('high_new_at_missingness');
  if (Number.isFinite(bundle.non_kitchen_path_share) && bundle.non_kitchen_path_share > th.max_non_kitchen_path_share) reasons.push('non_kitchen_path_excess');

  return { acceptable: reasons.length === 0, reasons };
}

// restaurant-level verdict — a restaurant can NEVER pass vacuously (fold C): requires signed thresholds,
// a non-empty critical_segments list with ≥1 in-scope entry, and every in-scope critical segment passing.
function restaurantVerdict(rid, bySegment, cfg, thresholds) {
  if (!thresholds || !thresholds.version || thresholds.approved_at == null) return { acceptable: false, reasons: ['unsigned_thresholds'] };
  const crit = cfg && cfg.critical_segments && cfg.critical_segments[rid];
  if (!Array.isArray(crit) || crit.length === 0) return { acceptable: false, reasons: ['missing_critical_segments'] };
  const inScope = crit.filter((c) => c && c.scope === 'in');
  if (inScope.length === 0) return { acceptable: false, reasons: ['missing_critical_segments'] };
  const reasons = [];
  for (const c of inScope) {
    const seg = bySegment[c.segment];
    if (!seg) reasons.push(`critical_segment_missing:${c.segment}`);
    else if (!seg.capture_acceptable) reasons.push(`critical_segment_failed:${c.segment}`);
  }
  return { acceptable: reasons.length === 0, reasons };
}

// computeQualityMetrics — assemble per-restaurant + per-segment metrics and verdicts over population rows.
function computeQualityMetrics(rows, cfg, thresholds) {
  const minBucketN = thresholds && isNum(thresholds.min_bucket_n) ? thresholds.min_bucket_n : Infinity;
  const pop = (rows || []).filter((r) => isMonitorPopulation(r.order, r.timeline, r.events, cfg).included);

  const byRid = {};
  for (const r of pop) {
    const rid = normRid(r.order && r.order.restaurant_id);
    (byRid[rid] = byRid[rid] || []).push(r);
  }

  const restaurants = {};
  for (const [rid, rlist] of Object.entries(byRid)) {
    const bundle = summarize(rlist, cfg);
    const derived = rushBiasFromLoad(bundle.by_load, minBucketN);

    const bySeg = {};
    const byHour = {};
    for (const r of rlist) {
      const hour = hourUTCminus6(pickNewEvent(r.events).at);
      (byHour[hour] = byHour[hour] || []).push(r);
    }
    for (const [hour, hrows] of Object.entries(byHour)) {
      const sb = summarize(hrows, cfg);
      const sv = isCaptureAcceptable(sb, thresholds);
      bySeg[hour] = { n: sb.n_kitchen_path, tap_rate: sb.tap_rate, capture_acceptable: sv.acceptable, gate_reasons: sv.reasons };
    }

    const rv = restaurantVerdict(rid, bySeg, cfg, thresholds);
    restaurants[rid] = {
      ...bundle,
      rush_bias: derived.rush_bias,
      top_tap_rate: derived.top_tap_rate,
      by_segment: bySeg,
      capture_acceptable: rv.acceptable,
      gate_reasons: rv.reasons,
    };
  }
  return { restaurants };
}

// runIdFor — deterministic id keyed on the ACTUAL joined-input hash + config hash (fold #12, D), so a
// changed join (late events) yields a NEW immutable run rather than a stale create-only no-op.
function runIdFor(inputHash, configHash) {
  const s = `${inputHash}::${configHash}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

module.exports = {
  rushProxyLoad, loadBucket, percentile, pickNewEvent, isMonitorPopulation,
  summarize, rushBiasFromLoad, isCaptureAcceptable, restaurantVerdict, computeQualityMetrics, runIdFor,
};
