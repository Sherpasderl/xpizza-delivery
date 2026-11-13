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

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('dish_stats_timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

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

// per-instance state: rid → { at, ok, raw } (memo) and rid → promise (in flight)
const MEMO = new Map();
const INFLIGHT = new Map();

// ONE bounded background read for rid (in-flight dedupe). Never rejects; fills the memo: → { ok, raw, at }
function startRead(rid, deps) {
  const inflight = deps.inflight || INFLIGHT;
  if (inflight.has(rid)) return inflight.get(rid);
  // the RTDB handle: deps.rtdb, else the Admin app's, resolved LAZILY inside the guarded promise (photos/edit-io.js's pattern) — so
  // getPublicMenu's index.js call is unchanged, and an unavailable handle is a failed read (omitted), never a failed menu
  const read = deps.read || ((r) => (deps.rtdb || require('firebase-admin/database').getDatabase()).ref(`public_stats/${r}/dish_stats`).once('value').then((s) => s.val()));
  const p = withTimeout(Promise.resolve().then(() => read(rid)), deps.timeoutMs || DISH_STATS_TIMEOUT_MS)
    .then((raw) => ({ ok: true, raw }), () => ({ ok: false, raw: null }))
    .then((r) => {
      const memo = deps.memo || MEMO; const prev = memo.get(rid);
      // a FAILED read keeps the LAST SUCCESS beside it (served while within the staleness cap); a success replaces both
      const lastOk = r.ok ? null : (prev && prev.ok ? { raw: prev.raw, at: prev.at } : (prev && prev.lastOk) || null);
      const rec = { ...r, at: deps.now ? deps.now() : Date.now(), ...(lastOk ? { lastOk } : {}) }; memo.set(rid, rec); inflight.delete(rid);
      if (!rec.ok) console.warn('public_menu_dish_stats_absent', JSON.stringify({ rid, reason: 'read_failed' }));
      return rec;
    });
  inflight.set(rid, p);
  return p;
}

/* NON-BLOCKING (5f review, advisor 11-13, rule 7: no awaited network on the menu's path). The menu NEVER waits for public_stats:
   - a FRESH memo (ok ≤ 10 min / failure ≤ 60 s) is served as it is (a failure ⇒ no field);
   - otherwise a background read is STARTED (deduped; bounded by its own 1.5 s deadline) and NOT awaited;
     · a STALE success memo is served meanwhile (stale-while-revalidate: the field does not vanish for one request every
       10 min, which would flip the ETag and cost every client a 200) — and a FAILED refresh keeps it, but only up to
       STALE_MAX (60 min) past its expiry; after that the field is omitted until a refresh succeeds (advisor 11-13);
     · with no usable memo (a cold instance, or after a failure) this response carries NO dish_stats; the next one has it.
   The ETag is computed over the body actually served, so it always reflects what was sent. */
function memoFor(rid, deps) {
  const now = deps.now ? deps.now() : Date.now();
  const memo = (deps.memo || MEMO).get(rid);
  const fresh = memo && now - memo.at < (memo.ok ? OK_TTL_MS : FAIL_TTL_MS);
  if (!fresh) startRead(rid, deps);   // background: never awaited here
  // the newest SUCCESS (this memo, or the one a failed refresh kept), served only within OK_TTL + STALE_MAX of its read
  const ok = memo && (memo.ok ? memo : memo.lastOk);
  return ok && now - ok.at < OK_TTL_MS + STALE_MAX_MS ? ok : null;
}

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

module.exports = { withDishStats, selectDishStats, allowEntry, DISH_STATS_MAX, DISH_STATS_BYTES, DISH_STATS_TIMEOUT_MS, OK_TTL_MS, FAIL_TTL_MS, STALE_MAX_MS, COUNT_MAX, _state: { MEMO, INFLIGHT } };
