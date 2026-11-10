'use strict';
// S-B step 1 (NOTE-S-B-aggregates-build) — the PURE aggregate core: fulfilled orders + COUNTABLE ratings → the public_stats/{rid} doc.
// Every display threshold is a server-side truth: a below-threshold field is OMITTED (never zero, never left to the renderer).
// Boundaries 9↔10, 19↔20, 24↔25, 14↔15; distinct-order counting; fulfilled-only; window edges; the pairs price cap; determinism; size.
// (The REAL-writer integration — intake → fulfilment → rateOrderCore → the producer — lands with step 2.)
// Run: node ratings/aggregate.test.js
const assert = require('assert');
const AG = require('./aggregate');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const DAY = 86400000; const NOW = 1_800_000_000_000;
const R = 'x_pizza';
let seq = 0;
const order = (o = {}) => ({ restaurant_id: R, status: 'delivered', created_at: NOW - DAY, customer_phone: `5049${String(1000000 + (seq++)).slice(-7)}`, dish_qty: { d1: 1 }, ...o });
const rating = (o = {}) => ({ restaurant_id: R, state: 'live', store: 5, dishes: {}, legacy_thumb: null, rated_at: NOW - DAY, ...o });
const PRICES = { d1: 9000, d2: 5000, d3: 15000, d4: 3000, d5: 2000 };
const build = (orders, ratings, o = {}) => AG.buildPublicStats({ rid: R, nowMs: NOW, orders, ratings, priceOf: (id) => (id in PRICES ? PRICES[id] : null), firstServedAt: null, ...o });
const times = (k, f) => Array.from({ length: k }, (_, i) => f(i));

// ── 1. store rating: avg / count / count_30d only at ≥ 10 countable ratings ──
{
  assert.deepStrictEqual(Object.keys(build([], times(9, () => rating()))).filter((k) => /^rating_/.test(k)), [], '🔴 9 ratings ⇒ no rating field at all');
  const d = build([], [...times(8, () => rating({ store: 5 })), rating({ store: 4, rated_at: NOW - 40 * DAY }), rating({ store: 3, rated_at: NOW - 31 * DAY })]);
  assert.strictEqual(d.rating_count, 10); assert.strictEqual(d.rating_avg, 4.7); assert.strictEqual(d.rating_count_30d, 8, '30-day count by rated_at');
  // ratings that are not this rid's, or have no store star, never count; the core trusts ONLY what it is handed (readCountable upstream)
  const e = build([], [...times(9, () => rating()), rating({ restaurant_id: 'la_musa' }), rating({ store: null })]);
  assert.ok(!('rating_count' in e), 'a foreign-rid node / a star-less node does not reach 10');
  assert.throws(() => build([], [rating({ state: 'withdrawn' })]), /countable/, '🔴 a non-live node handed to the core is a contract breach (throws)');
}
ok('store rating: 9 ⇒ omitted, 10 ⇒ rating_avg (1 dp) + rating_count + rating_count_30d; foreign-rid / star-less never count; a non-live input throws');

// ── 2. %liked from legacy thumbs: ≥ 20 ──
{
  assert.ok(!('pct_liked' in build([], times(19, (i) => rating({ store: null, legacy_thumb: i < 15 ? 1 : -1 })))), '🔴 19 thumbs ⇒ omitted');
  assert.strictEqual(build([], times(20, (i) => rating({ store: null, legacy_thumb: i < 15 ? 1 : -1 }))).pct_liked, 75);
}
ok('%liked: 19 thumbs ⇒ omitted, 20 ⇒ pct_liked (rounded %)');

// ── 3. dish thumbs: up / down / votes only at ≥ 20 votes ──
{
  const r19 = times(19, (i) => rating({ dishes: { d1: i < 18 ? 1 : -1 } }));
  assert.ok(!build([], r19).dish_stats, '🔴 19 dish votes ⇒ no dish thumbs');
  const r20 = [...r19, rating({ dishes: { d1: 1, d2: -1 } })];
  const ds = build([], r20).dish_stats;
  assert.deepStrictEqual(ds.d1, { up: 19, down: 1, votes: 20 }); assert.ok(!ds.d2, 'd2 (1 vote) omitted entirely');
}
ok('dish thumbs: 19 votes ⇒ omitted, 20 ⇒ { up, down, votes }');

// ── 4. orders: fulfilled only, DISTINCT orders (qty never multiplies), 30-day window, top_rank only top-3 ∧ ≥ 20 ──
{
  const base = [...times(25, () => order({ dish_qty: { d1: 5 } })), ...times(20, () => order({ dish_qty: { d2: 1 } })), ...times(19, () => order({ dish_qty: { d3: 1 } })),
    ...times(21, () => order({ dish_qty: { d4: 1 } })), ...times(30, () => order({ dish_qty: { d5: 1 } }))];
  const noise = [...times(9, () => order({ status: 'cancelled', dish_qty: { d3: 1 } })), ...times(9, () => order({ status: 'new', dish_qty: { d3: 1 } })),
    ...times(9, () => order({ created_at: NOW - 31 * DAY, dish_qty: { d3: 1 } })), ...times(9, () => order({ restaurant_id: 'la_musa', dish_qty: { d3: 1 } }))];
  const ds = build([...base, ...noise], []).dish_stats;
  assert.strictEqual(ds.d1.orders_30d, 25, '🔴 distinct orders (qty 5 counts once)');
  assert.ok(!('orders_30d' in (ds.d3 || {})), '🔴 19 fulfilled 30-day orders ⇒ omitted (cancelled / new / 31-day-old / foreign never count)');
  assert.deepStrictEqual([ds.d5.top_rank, ds.d1.top_rank, ds.d4.top_rank], [1, 2, 3], 'top-3 by orders_30d');
  assert.ok(!('top_rank' in ds.d2), '4th place (20 orders) has no rank');
  assert.strictEqual(build([...base, ...times(1, () => order({ status: 'completed', dish_qty: { d3: 1 } }))], []).dish_stats.d3.orders_30d, 20, 'completed counts as fulfilled; 20 ⇒ shown');
  const thin = build(times(19, () => order({ dish_qty: { d1: 1 } })), []).dish_stats;
  assert.ok(!thin || !thin.d1 || !('top_rank' in thin.d1), '🔴 a top dish below 20 orders has no rank');
}
ok('orders: fulfilled (delivered | completed) only, distinct orders, the 30-day window, foreign rid excluded; orders_30d 19 ⇒ omitted / 20 ⇒ shown; top_rank only top-3 ∧ ≥ 20');

// ── 5. pairs: ≥ 15 co-orders in 90 d, the partner's unit price < L100, ≤ 3, deterministic ──
{
  const co = (a, b, k, at = NOW - DAY) => times(k, () => order({ created_at: at, dish_qty: { [a]: 1, [b]: 2 } }));
  const os = [...co('d1', 'd2', 15), ...co('d1', 'd4', 14), ...co('d1', 'd3', 30), ...co('d1', 'd5', 16, NOW - 80 * DAY), ...co('d2', 'd5', 15, NOW - 91 * DAY)];
  const ds = build(os, []).dish_stats;
  assert.deepStrictEqual(ds.d1.pairs, [{ dishId: 'd5', count: 16 }, { dishId: 'd2', count: 15 }], '🔴 ≥15 only (d4 at 14 out), the L100 cap (d3 L150 out), 80-day-old counts, sorted by count');
  assert.deepStrictEqual(ds.d2.pairs, [{ dishId: 'd1', count: 15 }], 'symmetric; the 91-day-old pair is out of window');
  const many = build(['d2', 'd4', 'd5', 'd6'].flatMap((x, i) => co('d1', x, 20 + i)), [], { priceOf: () => 100 }).dish_stats.d1.pairs;
  assert.deepStrictEqual(many.map((p) => p.dishId), ['d6', 'd5', 'd4'], 'at most 3');
  const un = (build(co('d1', 'd9', 20), []).dish_stats || {});
  assert.ok(!(un.d1 && un.d1.pairs), 'an unpriced partner (not on the menu) is never suggested');
  assert.deepStrictEqual(un.d9.pairs, [{ dishId: 'd1', count: 20 }], 'the priced side still is');
}
ok('pairs: ≥ 15 co-orders within 90 d, partner unit price < L100 (unpriced ⇒ never), ≤ 3, sorted by count then id, symmetric');

// ── 6. repeat customers: distinct phones with ≥ 2 fulfilled orders: 24 ⇒ omitted, 25 ⇒ shown; phones never published ──
{
  const rep = (k) => times(k, (i) => [order({ customer_phone: `+504 9${String(i).padStart(7, '0')}` }), order({ customer_phone: `5049${String(i).padStart(7, '0')}` })]).flat();
  assert.ok(!('repeatCustomers' in build(rep(24), [])), '🔴 24 ⇒ omitted');
  const d = build([...rep(25), ...times(30, () => order())], []);
  assert.strictEqual(d.repeatCustomers, 25, 'normalized digits: the same phone formatted twice is ONE customer');
  assert.ok(!/5049\d{7}|\+504/.test(JSON.stringify(d)), '🔴 no phone in the doc');
  assert.ok(!('repeatCustomers' in build(times(30, (i) => order({ customer_phone: '50499990000', status: i ? 'cancelled' : 'delivered' })), [])), 'only FULFILLED orders make a repeat');
}
ok('repeat customers: normalized-digit identity, ≥ 2 fulfilled orders each; 24 ⇒ omitted, 25 ⇒ shown; no phone ever published');

// ── 7. «Nuevo en Sherpa»: new_until only while now < first_served_at + 60 d AND rating_count < 10 ──
{
  const fs = NOW - 59 * DAY;
  assert.strictEqual(build([], [], { firstServedAt: fs }).new_until, fs + 60 * DAY);
  assert.ok(!('new_until' in build([], [], { firstServedAt: NOW - 60 * DAY })), 'at 60 d ⇒ no longer new');
  assert.ok(!('new_until' in build([], times(10, () => rating()), { firstServedAt: fs })), '10 ratings ⇒ not new');
  assert.strictEqual(build([], [], { firstServedAt: fs }).first_served_at, fs);
  assert.ok(!('first_served_at' in build([], [])), 'no provenance ⇒ omitted');
}
ok('«Nuevo en Sherpa»: new_until while now < first_served_at + 60 d ∧ rating_count < 10; first_served_at carried; absent ⇒ omitted');

// ── 8. the doc: deterministic, counts only, ≤ ~2 KB for a busy store ──
{
  const os = []; for (let i = 0; i < 400; i++) os.push(order({ dish_qty: Object.fromEntries(['d1', 'd2', 'd3', 'd4', 'd5'].filter((_, j) => (i + j) % 2).map((d) => [d, 1 + (i % 3)])) }));
  const rs = times(200, (i) => rating({ store: 1 + (i % 5), legacy_thumb: i % 3 ? 1 : -1, dishes: { d1: 1, d2: i % 2 ? 1 : -1 } }));
  const a = build(os, rs); const b = build([...os].reverse(), [...rs].reverse());
  assert.deepStrictEqual(a, b, 'deterministic (input order never matters)');
  assert.ok(JSON.stringify(a).length <= 2048, `≤ 2 KB (${JSON.stringify(a).length} B)`);
  assert.strictEqual(a.v, AG.STATS_VERSION);
  assert.ok(!/comment|owner|uid|phone|delivery|order_id/i.test(JSON.stringify(a)), '🔴 counts only');
}
ok('the doc: deterministic, counts only (no identity / comment / delivery thumb), ≤ 2 KB for a busy store');

console.log(`aggregate: OK (${n})`);
