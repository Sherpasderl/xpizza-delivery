'use strict';
// S-B (PLAN §S-B; NOTE-S-B-aggregates-build + advisor rulings 2026-11-02) — the PURE aggregate core. No I/O.
// INCREMENTAL (ruling F3, the cost rule: never «a sweep downloading RTDB»): each fulfilled DAY of a restaurant becomes ONE small
// server-only bucket — built ONCE from that day's fulfilled orders, replaced whole on a re-run (idempotent) —
//   bucket = { v, orders, dish: { <canonical dish id>: <distinct orders> }, pairs: { '<a>~<b>': <co-orders> }, cust: { <key>: <orders> } }
// and publication SUMS the last 30 / 90 buckets. `cust` keys are PSEUDONYMOUS (the producer passes an HMAC keyer — HKDF(OTP_SALT,
// 'sherpa/stats-repeat/v1') — never raw digits) and expire with their bucket after 90 days; only COUNTS are ever published.
// Ratings arrive already COUNTABLE (rating-v2.readCountable upstream: live, owner not tombstoned) — a non-live input is a contract
// breach and throws.
// The doc (public_stats/{rid}) — WHOLE-doc replace; every below-threshold field is OMITTED (never zero, never left to the renderer):
//   rating_avg (1 dp) + rating_count + rating_count_30d  ≥ 10 store ratings     pct_liked                ≥ 20 legacy thumbs
//   repeatCustomers  ≥ 25 customers with ≥ 2 fulfilled orders in 90 d          first_served_at; new_until while now < +60 d ∧ < 10 ratings
//   dish_stats/{dishId}: up/down/votes ≥ 20 votes · orders_30d ≥ 20 · top_rank (store top-3 by orders_30d, each ≥ 20)
//                        · pairs [{dishId, count}] ≤ 3, each ≥ 15 co-orders / 90 d and the partner's unit price < L100
// Counts only: no identity, comment or delivery thumb ever enters the doc.
const { hnDateISO } = require('../lib/hn-date');

const STATS_VERSION = 1;
const BUCKET_VERSION = 1;
const DAY_MS = 86400000;
const T = Object.freeze({ RATINGS: 10, LIKED: 20, DISH_VOTES: 20, DISH_ORDERS: 20, TOP: 3, PAIR: 15, PAIRS_MAX: 3, PAIR_PRICE_CENTS: 10000, REPEAT: 25, NEW_DAYS: 60 });
const W = Object.freeze({ SHORT: 30, LONG: 90 });
const FULFILLED = new Set(['delivered', 'completed']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const normPhone = (p) => (typeof p === 'string' || typeof p === 'number' ? String(p).replace(/\D/g, '') : '');
const PAIR_SEP = '~';

// ONE day's bucket from that day's orders (the producer's keyed reads). Only this rid's FULFILLED orders count; a dish counts once
// per order (qty never multiplies); every unordered dish pair in an order co-occurs once. keyOf(normalized phone digits) → key|null.
function bucketFromOrders(rid, orders, keyOf) {
  const b = { v: BUCKET_VERSION, orders: 0, dish: {}, pairs: {}, cust: {} };
  for (const o of orders || []) {
    if (!isObj(o) || o.restaurant_id !== rid || !FULFILLED.has(o.status)) continue;
    b.orders += 1;
    const ids = isObj(o.dish_qty) ? Object.keys(o.dish_qty).filter((d) => Number.isInteger(o.dish_qty[d]) && o.dish_qty[d] > 0 && !d.includes(PAIR_SEP)).sort(byStr) : [];
    for (const d of ids) b.dish[d] = (b.dish[d] || 0) + 1;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const k = `${ids[i]}${PAIR_SEP}${ids[j]}`; b.pairs[k] = (b.pairs[k] || 0) + 1; }
    const digits = normPhone(o.customer_phone);
    const ck = digits ? keyOf(digits) : null;
    if (ck) b.cust[ck] = (b.cust[ck] || 0) + 1;
  }
  return b;
}

// the HN days of the window ending YESTERDAY (today is never complete): [today − days, today − 1]
function windowDays(nowMs, days) {
  const out = new Set();
  for (let i = 1; i <= days; i++) out.add(hnDateISO(nowMs - i * DAY_MS));
  return out;
}
function sumBuckets(buckets, days) {
  const acc = { orders: 0, dish: {}, pairs: {}, cust: {} };
  for (const [day, b] of Object.entries(buckets || {})) {
    if (!days.has(day) || !isObj(b)) continue;
    acc.orders += Number.isInteger(b.orders) ? b.orders : 0;
    for (const f of ['dish', 'pairs', 'cust']) for (const [k, v] of Object.entries(isObj(b[f]) ? b[f] : {})) if (Number.isInteger(v) && v > 0) acc[f][k] = (acc[f][k] || 0) + v;
  }
  return acc;
}

const round1 = (x) => Math.round(x * 10) / 10;
function publish({ rid, nowMs, buckets, ratings, priceOf, firstServedAt }) {
  const doc = { v: STATS_VERSION };
  const dish = {};
  const ds = (id) => dish[id] || (dish[id] = {});

  // ratings (countable only)
  let starSum = 0, stars = 0, stars30 = 0, likeUp = 0, likes = 0;
  const votes = {};
  for (const r of ratings || []) {
    if (!isObj(r) || r.state !== 'live') throw new Error('aggregate: a non-countable rating was handed to the core (readCountable upstream)');
    if (r.restaurant_id !== rid) continue;
    if (Number.isInteger(r.store) && r.store >= 1 && r.store <= 5) { starSum += r.store; stars += 1; if (Number.isFinite(r.rated_at) && r.rated_at >= nowMs - W.SHORT * DAY_MS) stars30 += 1; }
    if (r.legacy_thumb === 1 || r.legacy_thumb === -1) { likes += 1; if (r.legacy_thumb === 1) likeUp += 1; }
    for (const [id, t] of Object.entries(isObj(r.dishes) ? r.dishes : {})) {
      if (t !== 1 && t !== -1) continue;
      const v = votes[id] || (votes[id] = { up: 0, down: 0 }); if (t === 1) v.up += 1; else v.down += 1;
    }
  }
  if (stars >= T.RATINGS) { doc.rating_avg = round1(starSum / stars); doc.rating_count = stars; doc.rating_count_30d = stars30; }
  if (likes >= T.LIKED) doc.pct_liked = Math.round((100 * likeUp) / likes);
  for (const id of Object.keys(votes).sort(byStr)) { const v = votes[id]; if (v.up + v.down >= T.DISH_VOTES) Object.assign(ds(id), { up: v.up, down: v.down, votes: v.up + v.down }); }

  // orders: the 30-day dish counts + top ranks; the 90-day pairs + repeat customers
  const short = sumBuckets(buckets, windowDays(nowMs, W.SHORT));
  const long = sumBuckets(buckets, windowDays(nowMs, W.LONG));
  const ranked = Object.entries(short.dish).filter(([, k]) => k >= T.DISH_ORDERS).sort(([a, x], [b, y]) => (y - x) || byStr(a, b));
  for (const [id, k] of ranked) ds(id).orders_30d = k;
  ranked.slice(0, T.TOP).forEach(([id], i) => { ds(id).top_rank = i + 1; });
  const partners = {};
  for (const [k, c] of Object.entries(long.pairs)) {
    if (c < T.PAIR) continue;
    const [a, b] = k.split(PAIR_SEP);
    (partners[a] || (partners[a] = [])).push([b, c]); (partners[b] || (partners[b] = [])).push([a, c]);
  }
  for (const id of Object.keys(partners).sort(byStr)) {
    const ok = partners[id].filter(([p]) => { const pr = priceOf(p); return Number.isInteger(pr) && pr > 0 && pr < T.PAIR_PRICE_CENTS; })
      .sort(([a, x], [b, y]) => (y - x) || byStr(a, b)).slice(0, T.PAIRS_MAX);
    if (ok.length) ds(id).pairs = ok.map(([dishId, count]) => ({ dishId, count }));
  }
  const repeat = Object.values(long.cust).filter((k) => k >= 2).length;
  if (repeat >= T.REPEAT) doc.repeatCustomers = repeat;

  if (Number.isFinite(firstServedAt)) {
    doc.first_served_at = firstServedAt;
    if (nowMs < firstServedAt + T.NEW_DAYS * DAY_MS && stars < T.RATINGS) doc.new_until = firstServedAt + T.NEW_DAYS * DAY_MS;
  }
  const ids = Object.keys(dish).sort(byStr);
  if (ids.length) doc.dish_stats = Object.fromEntries(ids.map((id) => [id, dish[id]]));
  return doc;
}

// a convenience composition for tests and tools: orders grouped by the HN day of `fulfilled_at` (else created_at) → buckets → publish
function buildPublicStats({ rid, nowMs, orders, ratings, priceOf, firstServedAt = null, keyOf = (d) => d }) {
  const byDay = {};
  for (const o of orders || []) { const t = Number.isFinite(o && o.fulfilled_at) ? o.fulfilled_at : o && o.created_at; if (Number.isFinite(t)) (byDay[hnDateISO(t)] || (byDay[hnDateISO(t)] = [])).push(o); }
  const buckets = Object.fromEntries(Object.entries(byDay).map(([d, os]) => [d, bucketFromOrders(rid, os, keyOf)]));
  return publish({ rid, nowMs, buckets, ratings, priceOf, firstServedAt });
}

module.exports = { STATS_VERSION, BUCKET_VERSION, T, W, DAY_MS, FULFILLED, PAIR_SEP, normPhone, bucketFromOrders, windowDays, sumBuckets, publish, buildPublicStats };
