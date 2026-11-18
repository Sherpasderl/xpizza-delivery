'use strict';
// PLAN-3a-capp-member-reads (3) §3.2 + R2.10 + R3.3 — the served `dish_stats` decoration of the PUBLIC MENU (C-4 dish badges).
// The producer (ratings/aggregate.js publish, daily) already writes public_stats/{rid}/dish_stats/{canonical dish id}; this module
// reads it ONCE per rid per instance under its own deadline and serves a re-allowlisted, capped copy as a TOP-LEVEL body field (the
// photos precedent: a decoration that can never fail the serve). buildPublicMenu calls it on the identity-overlay branch only, after
// the overlay APPLIED (the served dishes carry dish_id) — never on the overlayIdentity:false bake/reconciler path.
//   NEVER FAILING, NEVER BLOCKING (R2.10 #6 + 5f review): the menu never awaits the read (memoFor below); the BACKGROUND read races
//     a cleared 1.5 s timer (identity-overlay.js's pattern); a timeout, rejection or malformed doc ⇒ the field is omitted. In-flight DEDUPE: one shared promise per rid per instance. MEMO: a success is reused for
//     10 min, a failure for 60 s (a negative cache: an outage never becomes a read storm or a 1.5 s delay on every request).
//   RE-ALLOWLIST (never trust): only dish ids the served body carries as dish_id; up/down/votes (votes = up + down ≥ the producer's
//     DISH_VOTES), orders_30d (≥ DISH_ORDERS), top_rank (1..TOP), pairs (≤ PAIRS_MAX, each partner another served dish_id, count ≥
//     PAIR) — thresholds are the PRODUCER's own (aggregate.T, one source). Every count is an integer 0..COUNT_MAX (6 digits); a wider
//     one is malformed and dropped, so the worst case below is a real bound.
//   CAP + BUDGET (R2.10 #14, R3.3): at most DISH_STATS_MAX dishes — top_rank first, then orders_30d desc, votes desc, dish id — and
//     DISH_STATS_MAX is the largest N whose WORST CASE (48-char ids, every count at COUNT_MAX width, every field, 3 pairs each) is
//     ≤ DISH_STATS_BYTES of canonical JSON; dish-stats-serve.test.js proves N fits and N + 1 does not.
const { T } = require('../ratings/aggregate');

const DISH_STATS_TIMEOUT_MS = 1500;
const OK_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const STALE_MAX_MS = 60 * 60 * 1000;   // advisor 11-13: a stale success is served at most 60 min past its expiry (stats may lag an hour, never days)
const COUNT_MAX = 999999;
const DISH_STATS_BYTES = 3072;
const DISH_STATS_MAX = 8;   // set by the worst-case cell: 8 × worst case = 2,880 B, 9 = 3,235 B (> 3,072) (dish-stats-serve.test.js), never asserted untested

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v, min = 0) => Number.isInteger(v) && v >= min && v <= COUNT_MAX;

// the served dish ids of a body (the overlay's dish_id), in body order
function servedDishIds(body) {
  const out = new Set();
  for (const d of Array.isArray(body && body.dishes) ? body.dishes : []) if (d && typeof d.dish_id === 'string' && d.dish_id) out.add(d.dish_id);
  return out;
}

// ONE entry, re-allowlisted field by field → a new object, or null when nothing qualifies
function allowEntry(id, e, served) {
  if (!isObj(e)) return null;
  const out = {};
  if (isCount(e.up) && isCount(e.down) && isCount(e.votes, T.DISH_VOTES) && e.votes === e.up + e.down) Object.assign(out, { up: e.up, down: e.down, votes: e.votes });
  if (isCount(e.orders_30d, T.DISH_ORDERS)) out.orders_30d = e.orders_30d;
  if (Number.isInteger(e.top_rank) && e.top_rank >= 1 && e.top_rank <= T.TOP) out.top_rank = e.top_rank;
  if (Array.isArray(e.pairs)) {
    const seen = new Set();
    const pairs = [];
    for (const p of e.pairs) {
      if (pairs.length >= T.PAIRS_MAX) break;
      if (!isObj(p) || typeof p.dishId !== 'string' || p.dishId === id || !served.has(p.dishId) || seen.has(p.dishId) || !isCount(p.count, T.PAIR)) continue;
      seen.add(p.dishId); pairs.push({ dishId: p.dishId, count: p.count });
    }
    if (pairs.length) out.pairs = pairs;
  }
  return Object.keys(out).length ? out : null;
}

// the WHOLE served field from a raw doc and the served body → an object, or null (omit)
function selectDishStats(raw, body) {
  if (!isObj(raw)) return null;
  const served = servedDishIds(body);
  const rows = [];
  for (const id of Object.keys(raw)) {
    if (!served.has(id)) continue;
    const e = allowEntry(id, raw[id], served);
    if (e) rows.push([id, e]);
  }
  const rank = (e) => (e.top_rank !== undefined ? e.top_rank : T.TOP + 1);
  rows.sort(([a, x], [b, y]) => (rank(x) - rank(y)) || ((y.orders_30d || 0) - (x.orders_30d || 0)) || ((y.votes || 0) - (x.votes || 0)) || (a < b ? -1 : a > b ? 1 : 0));
  const kept = rows.slice(0, DISH_STATS_MAX);
  return kept.length ? Object.fromEntries(kept) : null;
}

// the memo + background read (catalog/serve-memo.js, shared with the offers decoration): exactly this module's former memoFor / startRead
const SM = require('./serve-memo').createServeMemo({ okTtlMs: OK_TTL_MS, failTtlMs: FAIL_TTL_MS, staleMaxMs: STALE_MAX_MS, timeoutMs: DISH_STATS_TIMEOUT_MS,
  timeoutError: 'dish_stats_timeout', absentLog: 'public_menu_dish_stats_absent',
  // the RTDB handle: deps.rtdb, else the Admin app's, resolved LAZILY inside the guarded promise (photos/edit-io.js's pattern)
  defaultRead: (r, deps) => (deps.rtdb || require('firebase-admin/database').getDatabase()).ref(`public_stats/${r}/dish_stats`).once('value').then((s) => s.val()) });
const memoFor = SM.memoFor;

// buildPublicMenu's hook: the body with `dish_stats` when the memo holds qualifying stats, else the body unchanged. Never throws,
// never awaits a read.
async function withDishStats(rid, body, deps = {}) {
  try {
    const m = memoFor(rid, deps);
    if (!m) return body;
    const ds = selectDishStats(m.raw, body);
    return ds ? { ...body, dish_stats: ds } : body;
  } catch (e) {
    console.warn('public_menu_dish_stats_absent', JSON.stringify({ rid, reason: 'error' }));
    return body;
  }
}

module.exports = { withDishStats, selectDishStats, allowEntry, DISH_STATS_MAX, DISH_STATS_BYTES, DISH_STATS_TIMEOUT_MS, OK_TTL_MS, FAIL_TTL_MS, STALE_MAX_MS, COUNT_MAX, _state: SM.state };
