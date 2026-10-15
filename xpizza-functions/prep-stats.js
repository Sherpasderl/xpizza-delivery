'use strict';
// ── prep-stats — the daily measured-prep summary behind the order forms' arrival window (PLAN-S5 §5) ──
//
// Once a day (index.js prepStatsDaily) this job reads the last 28 days of kitchen timelines with ONE paged, bounded,
// indexed query, attributes each candidate row with two leaf reads, and publishes per restaurant × bucket
// {median_min, p80_min, n} to restaurants/{rid}/public/prep_stats in ONE root multipath update(). The forms read it (public);
// clients can never write it (rules: no grant at any depth).
//
// Bounded by construction (§5.1): order_timelines.orderByChild('new_at').startAt(lo).endAt(hi).limitToFirst(500), paged by
// (new_at, key); completion = a page whose RAW length is < 500 (BC1); a full page at the 40-page cap → abort. Per candidate
// row exactly two leaves: orders/{key}/restaurant_id and orders/{key}/customer_phone, at most 10 OUTSTANDING at any moment.
// All pages or nothing: any read failure, an unproven exhaustion or a rejected write → nothing changes and one
// prep_stats_aborted{reason} line; the previous summary ages out on the client (72 h staleness). Phones are used ONLY for
// the exclusion helper — never in a summary or a log line.
// Brand-agnostic: the restaurant set is the configured ready_time_config.active_restaurants; a row without a
// restaurant_id (or with an unlisted one) is excluded, never defaulted to a brand.

const { daypartOf, TZ_OFFSET_MS } = require('./ready-time-features');
const { timelineSanity, nonLabelExclusions, DEFAULT_MAX_PLAUSIBLE_PREP_MS } = require('./ready-time-eligibility');

const DAY_MS = 24 * 3600000;
const PREP_STATS = Object.freeze({
  LOOKBACK_MS: 28 * DAY_MS,
  // /orders has NO retention sweep at c83f2f9 (verified: no writer deletes orders/{id}; retention-sweep.js reclaims /tasks
  // only). The lookback clamps to it all the same, so a future retention shorter than 28 days is honoured by one edit here.
  ORDERS_RETENTION_MS: Infinity,
  SETTLE_MS: 3600000,          // the window ends 1 h ago (a row still being prepared is not yet a label)
  PAGE: 500,
  MAX_PAGES: 40,               // ≤ 20,000 entries, ≤ 19,961 distinct rows
  LEAF_CONCURRENCY: 10,        // OUTSTANDING leaf reads, not rows
  MIN_PREP_MS: 60000,          // 1 min ≤ ready − new ≤ DEFAULT_MAX_PLAUSIBLE_PREP_MS (3 h)
  MIN_N: 8,                    // the client ignores a bucket below this (it is still published with its n)
});
const DAYPARTS = ['late', 'morning', 'lunch', 'dinner'];
const BUCKETS = Object.freeze(['weekday', 'weekend'].flatMap((w) => DAYPARTS.map((d) => `${w}_${d}`)));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// weekday (Mon–Fri) / weekend (Sat–Sun) of the LOCAL (Tegucigalpa, UTC−6, no DST) day at `ms`
function prepWeekpartOf(ms) { const d = new Date(ms - TZ_OFFSET_MS).getUTCDay(); return (d === 0 || d === 6) ? 'weekend' : 'weekday'; }
const prepBucketOf = (newAt) => `${prepWeekpartOf(newAt)}_${daypartOf(newAt)}`;

// the timeline-only checks (run BEFORE attribution, so only plausible rows cost leaf reads)
function prepTimelineCandidate(t) {
  if (!t || !isNum(t.new_at) || !isNum(t.ready_at)) return false;
  if (!timelineSanity(t).ok) return false;
  const prep = t.ready_at - t.new_at;
  return prep >= PREP_STATS.MIN_PREP_MS && prep <= DEFAULT_MAX_PLAUSIBLE_PREP_MS;
}

// full eligibility for an attributed row {key, timeline, restaurant_id, customer_phone}
function prepRowEligible(row, cfg, active) {
  if (!prepTimelineCandidate(row.timeline)) return false;
  if (typeof row.restaurant_id !== 'string' || !row.restaurant_id || !active.includes(row.restaurant_id)) return false;   // unattributed / unlisted
  const order = { order_id: row.key, restaurant_id: row.restaurant_id, customer_phone: row.customer_phone };
  return !nonLabelExclusions(order, row.timeline, cfg).excluded;
}

// median: the middle of the sorted minutes (even n: the mean of the two middles), rounded to the nearest whole minute;
// p80: nearest rank, sorted[ceil(0.8 n) − 1], rounded the same way.
function prepSummarize(minutes) {
  const s = minutes.slice().sort((a, b) => a - b); const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { median_min: Math.round(median), p80_min: Math.round(s[Math.ceil(0.8 * n) - 1]), n };
}

// rows → { [rid]: { [bucket]: {median_min, p80_min, n} } } over the publishable restaurants
function prepAggregate(rows, cfg, publishable) {
  const acc = {};
  for (const rid of publishable) acc[rid] = {};
  for (const row of rows) {
    if (!prepRowEligible(row, cfg, publishable)) continue;
    const b = prepBucketOf(row.timeline.new_at);
    (acc[row.restaurant_id][b] = acc[row.restaurant_id][b] || []).push((row.timeline.ready_at - row.timeline.new_at) / 60000);
  }
  const out = {};
  for (const rid of publishable) { out[rid] = {}; for (const b of Object.keys(acc[rid])) out[rid][b] = prepSummarize(acc[rid][b]); }
  return out;
}

// the ONE root multipath update: every bucket of every publishable restaurant (absent → null, so a stale bucket is deleted)
function prepBuildUpdates(stats, publishable, nowMs) {
  const u = {};
  for (const rid of publishable) {
    for (const b of BUCKETS) u[`restaurants/${rid}/public/prep_stats/${b}`] = (stats[rid] && stats[rid][b]) || null;
    u[`restaurants/${rid}/public/prep_stats/updated_at`] = nowMs;
  }
  return u;
}

// a limiter: at most `max` OUTSTANDING promises from `fns`, results in order; the first rejection rejects the whole run
function prepPooled(fns, max) {
  return new Promise((resolve, reject) => {
    const out = new Array(fns.length); let next = 0, done = 0, failed = false;
    if (!fns.length) { resolve(out); return; }
    const launch = () => {
      if (failed || next >= fns.length) return;
      const i = next++;
      Promise.resolve().then(fns[i]).then((v) => { out[i] = v; done += 1; if (done === fns.length) resolve(out); else launch(); },
        (e) => { if (!failed) { failed = true; reject(e); } });
    };
    for (let k = 0; k < Math.min(max, fns.length); k += 1) launch();
  });
}

const sizeOf = (v) => { try { return JSON.stringify(v === undefined ? null : v).length; } catch (_) { return 0; } };

// The run. deps: { db (Admin RTDB), nowMs, log ({log, warn, error}) }. Resolves to a report; never throws.
async function runPrepStats({ db, nowMs, log = console }) {
  const t0 = Date.now();
  const report = { pages: 0, rows: 0, leaf_reads: 0, bytes_approx: 0, published: [], skipped: [], aborted: null };
  const abort = (reason) => { report.aborted = reason; log.warn('prep_stats_aborted', JSON.stringify({ reason })); return report; };
  const read = async (q) => { const s = await q.once('value'); return s; };

  // ── config (admin-only) ──
  let cfg;
  try { const s = await read(db.ref('ready_time_config')); cfg = s.val() || {}; report.bytes_approx += sizeOf(cfg); }
  catch (_) { return abort('read_failed'); }
  const active = cfg.active_restaurants;
  if (!Array.isArray(active) || !active.length || !active.every((r) => typeof r === 'string' && r)) return abort('config_invalid');
  const epochs = cfg.epoch_start_ms || {};
  const publishable = active.filter((rid) => isNum(epochs[rid]));
  for (const rid of active) if (!publishable.includes(rid)) { report.skipped.push(rid); log.warn('prep_stats_skipped', JSON.stringify({ rid, reason: 'no_epoch' })); }

  // ── the paged window query (BC1: exhaustion = a RAW page shorter than PAGE, judged before the overlap row is dropped) ──
  const lo = nowMs - Math.min(PREP_STATS.LOOKBACK_MS, PREP_STATS.ORDERS_RETENTION_MS);
  const hi = nowMs - PREP_STATS.SETTLE_MS;
  const rows = new Map();
  let cursor = null, exhausted = false;
  try {
    while (report.pages < PREP_STATS.MAX_PAGES) {
      const base = db.ref('order_timelines').orderByChild('new_at');
      const q = (cursor ? base.startAt(cursor.newAt, cursor.key) : base.startAt(lo)).endAt(hi).limitToFirst(PREP_STATS.PAGE);
      const snap = await read(q);
      report.pages += 1;
      const page = []; snap.forEach((c) => { page.push([c.key, c.val()]); });
      report.bytes_approx += page.reduce((a, [, v]) => a + sizeOf(v), 0);
      const rawLen = page.length;
      for (const [key, t] of page) if (!(cursor && key === cursor.key)) rows.set(key, t);
      if (rawLen < PREP_STATS.PAGE) { exhausted = true; break; }
      const [lastKey, lastT] = page[page.length - 1];
      cursor = { newAt: lastT && lastT.new_at, key: lastKey };
    }
  } catch (_) { return abort('read_failed'); }
  if (!exhausted) return abort('cap_unproven');
  report.rows = rows.size;

  // ── attribution: two leaves per timeline candidate, ≤ LEAF_CONCURRENCY outstanding ──
  const candidates = [...rows.entries()].filter(([, t]) => prepTimelineCandidate(t));
  const reads = [];
  for (const [key] of candidates) {
    reads.push(() => read(db.ref(`orders/${key}/restaurant_id`)));
    reads.push(() => read(db.ref(`orders/${key}/customer_phone`)));
  }
  // the §8 drift check: the private prep_eta_min (feeds WhatsApp) vs the public one (feeds the window), per listed restaurant
  for (const rid of publishable) {
    reads.push(() => read(db.ref(`restaurants/${rid}/prep_eta_min`)));
    reads.push(() => read(db.ref(`restaurants/${rid}/public/prep_eta_min`)));
  }
  let snaps;
  try { snaps = await prepPooled(reads, PREP_STATS.LEAF_CONCURRENCY); } catch (_) { return abort('read_failed'); }
  report.leaf_reads = snaps.length;
  report.bytes_approx += snaps.reduce((a, s) => a + sizeOf(s.val()), 0);
  const attributed = candidates.map(([key, t], i) => ({ key, timeline: t, restaurant_id: snaps[2 * i].val(), customer_phone: snaps[2 * i + 1].val() }));
  publishable.forEach((rid, j) => {
    const priv = snaps[2 * candidates.length + 2 * j].val(), pub = snaps[2 * candidates.length + 2 * j + 1].val();
    if ((priv !== null || pub !== null) && priv !== pub) log.warn('prep_eta_min_mismatch', JSON.stringify({ rid }));
  });

  // ── publish: ONE root update, only after full aggregation ──
  if (publishable.length) {
    const updates = prepBuildUpdates(prepAggregate(attributed, cfg, publishable), publishable, nowMs);
    try { await db.ref().update(updates); } catch (_) { return abort('write_rejected'); }
    report.published = publishable.slice();
  }
  report.duration_ms = Date.now() - t0;
  log.log('prep_stats_run', JSON.stringify({ pages: report.pages, rows: report.rows, leaf_reads: report.leaf_reads, bytes_approx: report.bytes_approx,
    duration_ms: report.duration_ms, published: report.published.length, skipped: report.skipped.length }));
  return report;
}

module.exports = { runPrepStats, prepAggregate, prepSummarize, prepBuildUpdates, prepBucketOf, prepWeekpartOf, prepTimelineCandidate, prepRowEligible, prepPooled, PREP_STATS, BUCKETS };
