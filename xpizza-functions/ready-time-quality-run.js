'use strict';

/**
 * Ready-Time Phase 1 · Step 1b — the data-quality-monitor RUNNER.
 *
 * A thin I/O shell around the FROZEN Step-1a pure core (ready-time-quality.js), imported not copied.
 * Observer-only: READS orders ⋈ order_events ⋈ order_timelines + ready_time_config; the ONLY mutating
 * targets are ready_time_quality/runs/{runId} (create-only immutable), ready_time_quality/preview/{runId},
 * and the ready_time_quality/latest beacon (a monotonic status pointer). NEVER /orders, /order_tracking,
 * driver tasks, or notifications. NOT a deployed Cloud Function (a script → no prune risk).
 * See PHASE1_STEP1B_QUALITY_RUNNER.md (rev-3). `now` is injected (deterministic tests); db is injected.
 */

const core = require('./ready-time-quality');
const { computeQualityMetrics, runIdFor, pickNewEvent } = core;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ── deterministic hashing (djb2 over a canonical serialization) ──
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); }
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

// hashRows — canonicalizes the exact post-window joined rows over EVERY core-read field (fold #2), so a
// metric-affecting late change flips the hash (→ new runId, no stale no-op). Row/event-key order agnostic.
function canonRow(r) {
  const o = r.order || {}, t = r.timeline || {};
  const evs = Object.keys(r.events || {}).sort().map((k) => {
    const e = r.events[k] || {};
    return [k, e.from ?? null, e.to ?? null, e.at ?? null, e.kitchen_load_ahead ?? null];
  });
  return [o.restaurant_id ?? null, o.customer_phone ?? null, o.order_id ?? null,
    t.new_at ?? null, t.preparing_at ?? null, t.ready_at ?? null, t.out_for_delivery_at ?? null, t.delivered_at ?? null, evs];
}
function hashRows(rows) {
  const arr = (rows || []).map(canonRow).sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return djb2(stableStringify(arr));
}
function hashConfig(cfg) {
  const c = cfg || {};
  return djb2(stableStringify({
    active_restaurants: c.active_restaurants, epoch_start_ms: c.epoch_start_ms,
    excluded_phones: c.excluded_phones, excluded_orders: c.excluded_orders, cleanup_paths: c.cleanup_paths,
    critical_segments: c.critical_segments, quality_thresholds: c.quality_thresholds, settle_lag_ms: c.settle_lag_ms,
    graduation_thresholds: c.graduation_thresholds,   // Phase 1b-i (plan-gate #2): a re-sign of graduation
    // thresholds must flip config_hash so old ready_time_graduation verdicts fail the _meta/active_config_hash
    // fence (fix 7'). NOTE: this couples the quality runner's config_hash to graduation config — a graduation
    // re-sign also re-stamps quality runs (rare, harmless: an idempotent re-merge). Plan-mandated.
  }));
}

// resolveWindow — fail-closed (fold #4, E2). Active set + epochs come from signed config only.
function resolveWindow(cfg, now, requested) {
  const c = cfg || {}, req = requested || {};
  const active = c.active_restaurants;
  if (!Array.isArray(active) || active.length === 0) return { status: 'config_invalid', reason: 'no_active_restaurants' };
  if (!isNum(c.settle_lag_ms)) return { status: 'config_invalid', reason: 'settle_lag_ms' };
  const epochs = active.map((rid) => (c.epoch_start_ms || {})[rid]);
  if (!epochs.every(isNum)) return { status: 'config_invalid', reason: 'epoch_start_ms' };
  const minEpoch = Math.min(...epochs);
  const from_ms = isNum(req.from) ? Math.max(req.from, minEpoch) : minEpoch;

  if (req.mode === 'preview') return { from_ms, to_ms: now, settled: false, mode: 'preview', active };
  const to_ms = Math.min(isNum(req.to) ? req.to : now, now - c.settle_lag_ms);
  if (from_ms >= to_ms) return { status: 'nothing_settled' };
  return { from_ms, to_ms, settled: true, mode: 'authoritative', active };
}

// buildRunNode — materializes EVERY active restaurant (fold #3): an absent one is an explicit fail, and
// an all-empty settled window carries status empty_settled_window (consumed as FAIL, no green-by-absence).
const emptyRestaurant = () => ({ n_population: 0, n_terminal: 0, n_kitchen_path: 0, tap_rate: null, capture_acceptable: false, gate_reasons: ['empty_denominator'], by_segment: {} });
function buildRunNode(metrics, { active, window, input_hash, config_hash, thresholds, now }) {
  const restaurants = {};
  const src = (metrics && metrics.restaurants) || {};
  let hasRows = false;
  for (const rid of active) {
    restaurants[rid] = src[rid] || emptyRestaurant();
    if (src[rid] && src[rid].n_population > 0) hasRows = true;
  }
  return {
    computed_at: now, window, input_hash, config_hash, thresholds: thresholds || null,
    status: hasRows ? 'ok' : 'empty_settled_window', restaurants,
  };
}

// isFreshAuthoritativeRun — the C1/C2 freshness contract (E1b). runExists is resolved by the caller by
// reading runs/{runId} — the beacon's runId is NOT trusted blindly (pin 1). Any miss ⇒ not fresh (FAIL).
function isFreshAuthoritativeRun(latest, expected) {
  if (!latest) return { fresh: false, reasons: ['no_latest_run'] };
  const e = expected || {};
  const reasons = [];
  if (latest.status !== 'ok') reasons.push('run_not_ok');
  if (latest.mode !== 'authoritative') reasons.push('not_authoritative');
  if (latest.settled !== true) reasons.push('not_settled');
  if (latest.config_hash !== e.config_hash) reasons.push('config_hash_mismatch');
  const w = latest.window || {};
  const cov = e.coverage || {};
  if (!(isNum(w.from_ms) && isNum(w.to_ms) && w.from_ms <= cov.from_ms && w.to_ms >= cov.to_ms)) reasons.push('coverage_shortfall');
  if (!(isNum(latest.computed_at) && isNum(e.now) && (e.now - latest.computed_at) <= e.max_age_ms)) reasons.push('stale');
  if (!e.runExists) reasons.push('run_missing');
  return { fresh: reasons.length === 0, reasons };
}

// latestMergeMonotonic — an overlapping/slower run can't repoint latest backwards (pin 2): keep the
// existing beacon if it is strictly newer than the incoming one.
function latestMergeMonotonic(cur, node) {
  if (cur && isNum(cur.computed_at) && cur.computed_at > node.computed_at) return cur;
  return node;
}

// ─────────────────────────── I/O (db injected; emulator-proven) ───────────────────────────

async function readJoin(db, win, cfg) {
  const [oSnap, eSnap, tSnap] = await Promise.all([
    db.ref('orders').once('value'), db.ref('order_events').once('value'), db.ref('order_timelines').once('value'),
  ]);
  const orders = oSnap.val() || {}, events = eSnap.val() || {}, timelines = tSnap.val() || {};
  const budget = (cfg && cfg.read_budget) || {};
  const ids = Object.keys(orders);
  if (isNum(budget.max_rows) && ids.length > budget.max_rows) return { status: 'read_budget_exceeded' };

  const rows = [];
  for (const id of ids) {
    const evs = events[id] || {};
    const chosen = pickNewEvent(evs);            // FROZEN core selection — window keyed on its `at`
    if (!chosen || !isNum(chosen.at)) continue;
    if (chosen.at < win.from_ms || chosen.at >= win.to_ms) continue;
    rows.push({ order: orders[id], timeline: timelines[id] || {}, events: evs });
  }
  return { rows };
}

function pathFor(mode, runId) { return `ready_time_quality/${mode === 'preview' ? 'preview' : 'runs'}/${runId}`; }

async function writeRunCreateOnly(db, mode, runId, node) {
  const res = await db.ref(pathFor(mode, runId)).transaction((cur) => (cur === null ? node : undefined));
  return { committed: res.committed };
}
async function updateLatestMonotonic(db, node) {
  await db.ref('ready_time_quality/latest').transaction((cur) => {
    const merged = latestMergeMonotonic(cur, node);
    return merged === cur ? undefined : merged;   // keeping the newer existing beacon → abort (no write)
  });
}

// main — one observer pass. Returns the outcome; writes only under ready_time_quality/.
async function main({ db, now, window, mode }) {
  const cfg = (await db.ref('ready_time_config').once('value')).val() || {};
  const win = resolveWindow(cfg, now, { ...(window || {}), mode });

  if (win.status) { // config_invalid / nothing_settled → no run; the beacon records the failure (E1a)
    await updateLatestMonotonic(db, { status: win.status, runId: null, config_hash: hashConfig(cfg), window: null, mode: 'authoritative', settled: false, computed_at: now });
    return { status: win.status };
  }

  const join = await readJoin(db, win, cfg);
  if (join.status === 'read_budget_exceeded') {
    await updateLatestMonotonic(db, { status: 'read_budget_exceeded', runId: null, config_hash: hashConfig(cfg), window: win, mode: win.mode, settled: win.settled, computed_at: now });
    return { status: 'read_budget_exceeded' };
  }

  const metrics = computeQualityMetrics(join.rows, cfg, cfg.quality_thresholds);
  const input_hash = hashRows(join.rows);
  const config_hash = hashConfig(cfg);
  const node = buildRunNode(metrics, { active: cfg.active_restaurants, window: win, input_hash, config_hash, thresholds: cfg.quality_thresholds, now });
  const runId = runIdFor(input_hash, config_hash);

  await writeRunCreateOnly(db, win.mode, runId, node);
  if (win.mode === 'authoritative') {
    await updateLatestMonotonic(db, { status: node.status, runId, config_hash, window: win, mode: 'authoritative', settled: win.settled, computed_at: now });
  }
  return { status: node.status, runId };
}

// readFreshAuthoritativeRun — the C1/C2-side read: latest beacon + confirm runs/{runId} exists (pin 1).
async function readFreshAuthoritativeRun(db, { now, config_hash, coverage, max_age_ms }) {
  const latest = (await db.ref('ready_time_quality/latest').once('value')).val();
  let runExists = false;
  if (latest && latest.runId) runExists = (await db.ref(`ready_time_quality/runs/${latest.runId}`).once('value')).exists();
  return isFreshAuthoritativeRun(latest, { now, config_hash, coverage, max_age_ms, runExists });
}

module.exports = {
  hashRows, hashConfig, resolveWindow, buildRunNode, isFreshAuthoritativeRun, latestMergeMonotonic,
  readJoin, writeRunCreateOnly, updateLatestMonotonic, readFreshAuthoritativeRun, main, pickNewEvent,
};

// CLI entrypoint (real invocation): initialize admin, run one authoritative pass. Never imported by index.js.
if (require.main === module) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  main({ db: admin.database(), now: Date.now(), mode: 'authoritative' })
    .then((r) => { console.log('ready-time-quality-run:', JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('ready-time-quality-run FAILED:', e); process.exit(1); });
}
