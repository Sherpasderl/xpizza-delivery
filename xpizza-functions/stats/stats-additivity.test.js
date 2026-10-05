'use strict';
// Merchant STATS — ADDITIVITY property tests (PLAN-stats rev 4 Tests §ADDITIVITY).
// Random whole-lifecycle fixtures from the REAL writers (stats-gen.js), many seeds. Expectations come
// from the GENERATOR's intent (_expect), not from classifyOrder. Run: node stats/stats-additivity.test.js
const assert = require('assert');
const B = require('./stats-build');
const T = require('./stats-time');
const X = require('./stats-index');
const { generate, rng } = require('./stats-gen');
const { makeCustomerKeyer } = require('./stats-identity');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const keyer = makeCustomerKeyer('a'.repeat(40));
const FROM = '2026-09-01', DAYS = 24;
const ALL_DATES = T.datesBetween(FROM, T.addDays(FROM, DAYS + 7));   // + the scheduled horizon
const SEEDS = Array.from({ length: 25 }, (_, i) => 1000 + i * 7);

function directOver(orders, rid, dates) {
  // "Building directly over the N days": ONE summary, every in-range order folded in once.
  const D = new Set(dates);
  const s = B.emptySummary();
  for (const o of orders) if (B.ridOf(o) === rid && D.has(T.dateOf(T.serviceMs(o)))) B.addOrder(s, o, rid, keyer);
  return s;
}
function randomPeriod(r) {
  const a = Math.floor(r() * ALL_DATES.length), b = Math.floor(r() * ALL_DATES.length);
  return [ALL_DATES[Math.min(a, b)], ALL_DATES[Math.max(a, b)]];
}

// 1. merge(daily docs) == build(range), EVERY additive field, random periods, many seeds. Also through a
//    JSON round trip (what storage does to a summary).
{
  let checks = 0;
  for (const seed of SEEDS) {
    const orders = generate({ seed, from: FROM, days: DAYS });
    const r = rng(seed ^ 0xabc);
    const dailies = B.buildDailies(orders, { keyer, restaurants: new Set(['r_a', 'r_b']), dates: new Set(ALL_DATES) });
    for (let k = 0; k < 6; k++) {
      const [f, t] = randomPeriod(r);
      const ds = T.datesBetween(f, t);
      for (const rid of ['r_a', 'r_b']) {
        const merged = B.mergeSummaries(ds.map((d) => JSON.parse(JSON.stringify(dailies.get(rid).get(d)))));
        assert.deepStrictEqual(merged, directOver(orders, rid, ds), `seed ${seed} ${rid} ${f}..${t}`);
        checks++;
      }
    }
  }
  ok(`merge(N daily summaries) deep-equals a direct build over the N days (${checks} random periods × all fields)`);
}

// 2. Against the GENERATOR's intent (independent of classifyOrder): sales, orders, per type/method,
//    class counts, cancellation numerators.
{
  for (const seed of SEEDS) {
    const orders = generate({ seed, from: FROM, days: DAYS });
    const dailies = B.buildDailies(orders, { keyer, restaurants: new Set(['r_a', 'r_b']), dates: new Set(ALL_DATES) });
    const r = rng(seed ^ 0x123);
    const [f, t] = randomPeriod(r);
    for (const rid of ['r_a', 'r_b']) {
      const m = B.mergeSummaries(T.datesBetween(f, t).map((d) => dailies.get(rid).get(d)));
      const inP = orders.filter((o) => o._expect.rid === rid && o._expect.date >= f && o._expect.date <= t);
      const sales = inP.filter((o) => o._expect.cls === 'sale');
      assert.strictEqual(m.sale.orders, sales.length);
      assert.strictEqual(m.sale.cents, sales.reduce((a, o) => a + o._expect.cents, 0));
      for (const ty of ['delivery', 'pickup']) assert.strictEqual(m.by_type[ty].orders, sales.filter((o) => o._expect.type === ty).length);
      const bucket = (pm) => (['cash', 'card_delivery', 'online'].includes(pm) ? pm : 'other');
      for (const pm of B.PAYMENT_METHODS) assert.strictEqual(m.by_payment[pm].cents, sales.filter((o) => bucket(o._expect.pm) === pm).reduce((a, o) => a + o._expect.cents, 0));
      for (const cls of ['cancelled', 'refunded', 'refund_pending', 'excluded']) assert.strictEqual(m[cls].orders, inP.filter((o) => o._expect.cls === cls).length, cls);
      assert.strictEqual(m.unresolved.orders, 0, 'the generator produces no unresolved orders');
      assert.strictEqual(m.sale.anonymous_orders, sales.filter((o) => !o._expect.phone).length);
    }
  }
  ok(`builder agrees with the generator's independent intent across ${SEEDS.length} seeds`);
}

// 3. Histogram-merged MEDIAN == exact median within ONE bucket, for random periods.
{
  let checked = 0;
  for (const seed of SEEDS) {
    const orders = generate({ seed, from: FROM, days: DAYS });
    const dailies = B.buildDailies(orders, { keyer, restaurants: new Set(['r_a']), dates: new Set(ALL_DATES) });
    const r = rng(seed ^ 0x777);
    const [f, t] = randomPeriod(r);
    const ds = new Set(T.datesBetween(f, t));
    const m = B.mergeSummaries([...ds].map((d) => dailies.get('r_a').get(d)));
    for (const [field, start, end] of [['prep', B.prepStart, (o) => o.picked_up_at], ['delivery', (o) => o.picked_up_at, (o) => o.delivered_at]]) {
      const vals = orders.filter((o) => o._expect.rid === 'r_a' && ds.has(o._expect.date) && o._expect.cls === 'sale' && o._expect.type === 'delivery')
        .map((o) => B.interval(start(o), end(o))).filter((v) => v !== null).sort((a, b) => a - b);
      assert.strictEqual(m[field].n, vals.length);
      if (!vals.length) { assert.strictEqual(B.histMedian(m[field]), null); continue; }
      const exact = vals[Math.ceil(vals.length / 2) - 1];
      const med = B.histMedian(m[field]);
      assert(exact >= med.lo_ms && (med.hi_ms === null || exact < med.hi_ms), `${field} exact ${exact} ∉ [${med.lo_ms}, ${med.hi_ms})`);
      assert.strictEqual(m[field].sum_ms, vals.reduce((a, v) => a + v, 0), 'sum for the average is exact');
      checked++;
    }
  }
  ok(`histogram median within one bucket of the exact median (${checked} period/metric checks)`);
}

// Independent reference for customers: from the generator's raw phones, over ALL history.
function refCustomers(orders, rid, f, t) {
  const datesByPhone = new Map();
  for (const o of orders) {
    const e = o._expect;
    if (e.rid !== rid || e.cls !== 'sale' || !e.phone) continue;
    if (!datesByPhone.has(e.phone)) datesByPhone.set(e.phone, []);
    datesByPhone.get(e.phone).push({ date: e.date, cents: e.cents });
  }
  const res = { distinct: 0, new: { customers: 0, orders: 0, cents: 0 }, returning: { customers: 0, orders: 0, cents: 0 } };
  for (const [, list] of datesByPhone) {
    const inP = list.filter((x) => x.date >= f && x.date <= t);
    if (!inP.length) continue;
    res.distinct++;
    const first = list.reduce((a, x) => (x.date < a ? x.date : a), '9999');
    const b = first >= f ? res.new : res.returning;
    b.customers++; b.orders += inP.length; b.cents += inP.reduce((a, x) => a + x.cents, 0);
  }
  return res;
}
// The index as a sequence of nightly publications would build it.
function publishAll(dailies, rid, dates, chunk = 5) {
  let shards = {};
  for (let i = 0; i < dates.length; i += chunk) {
    const part = dates.slice(i, i + chunk);
    shards = X.rederive(shards, part, new Map(part.map((d) => [d, Object.keys(dailies.get(rid).get(d).customers)])));
  }
  return shards;
}

// 4. Distinct customers, NEW / RETURNING counts AND sales correct for ARBITRARY periods.
{
  let checks = 0;
  for (const seed of SEEDS) {
    const orders = generate({ seed, from: FROM, days: DAYS, phones: 15 });
    const dailies = B.buildDailies(orders, { keyer, restaurants: new Set(['r_a', 'r_b']), dates: new Set(ALL_DATES) });
    const r = rng(seed ^ 0x4242);
    for (const rid of ['r_a', 'r_b']) {
      const shards = publishAll(dailies, rid, ALL_DATES, 1 + Math.floor(r() * 9));
      const firsts = X.firstDatesWithOverlay(shards);
      for (let k = 0; k < 5; k++) {
        const [f, t] = randomPeriod(r);
        const m = B.mergeSummaries(T.datesBetween(f, t).map((d) => dailies.get(rid).get(d)));
        const got = X.newVsReturning(m.customers, firsts, f);
        const want = refCustomers(orders, rid, f, t);
        assert.deepStrictEqual({ distinct: got.distinct, new: got.new, returning: got.returning }, want, `seed ${seed} ${rid} ${f}..${t}`);
        assert.strictEqual(got.unindexed, 0);
        checks++;
      }
    }
  }
  ok(`distinct + new/returning counts AND sales == independent reference (${checks} random periods)`);
}

// 5. The index REPAIRS when an early order is refunded (re-settle that day only).
{
  const orders = generate({ seed: 4711, from: FROM, days: DAYS, phones: 6 });
  const rid = 'r_a';
  const dailies = B.buildDailies(orders, { keyer, restaurants: new Set([rid]), dates: new Set(ALL_DATES) });
  const shards = publishAll(dailies, rid, ALL_DATES);
  // Find a customer whose first Sale is NOT their only one, and refund that first order.
  const sales = orders.filter((o) => o._expect.rid === rid && o._expect.cls === 'sale' && o._expect.phone);
  const byPhone = new Map(); for (const o of sales) { if (!byPhone.has(o._expect.phone)) byPhone.set(o._expect.phone, []); byPhone.get(o._expect.phone).push(o); }
  const [phone, list] = [...byPhone].find(([, l]) => new Set(l.map((o) => o._expect.date)).size >= 2);
  list.sort((a, b) => (a._expect.date < b._expect.date ? -1 : 1));
  const firstDay = list[0]._expect.date;
  const victims = list.filter((o) => o._expect.date === firstDay);
  for (const v of victims) { v.status = 'cancelled'; v.payment_status = v.payment_method === 'online' ? 'refunded' : undefined; if (v.payment_status === undefined) delete v.payment_status; v._expect.cls = v.payment_method === 'online' ? 'refunded' : 'cancelled'; }
  const reb = B.buildDailies(orders, { keyer, restaurants: new Set([rid]), dates: new Set([firstDay]) });
  const repaired = X.rederive(shards, [firstDay], new Map([[firstDay, Object.keys(reb.get(rid).get(firstDay).customers)]]));
  const key = keyer(rid, phone);
  const before = X.firstDatesWithOverlay(shards).get(key);
  const after = X.firstDatesWithOverlay(repaired).get(key);
  assert.strictEqual(before, firstDay);
  assert.strictEqual(after, list.find((o) => o._expect.date > firstDay)._expect.date, 'first date moves to the next real Sale');
  // And the period stats agree with the reference after the repair.
  dailies.get(rid).set(firstDay, reb.get(rid).get(firstDay));
  const f = T.addDays(firstDay, 1), t = ALL_DATES[ALL_DATES.length - 1];
  const got = X.newVsReturning(B.mergeSummaries(T.datesBetween(f, t).map((d) => dailies.get(rid).get(d))).customers, X.firstDatesWithOverlay(repaired), f);
  const want = refCustomers(orders, rid, f, t);
  assert.deepStrictEqual({ distinct: got.distinct, new: got.new, returning: got.returning }, want);
  ok('an early refund moves the customer\'s first date; new/returning re-agree with the reference');
}

// 6. Live overlay cases: first-ever Sale today, same-day refund, a day becoming empty.
{
  const k1 = keyer('r_a', '88880001'), k2 = keyer('r_a', '88880002');
  const shards = X.rederive({}, ['2026-09-01'], new Map([['2026-09-01', [k1]]]));
  const today = '2026-09-10';
  // first-ever Sale today (k2), returning (k1)
  let f = X.firstDatesWithOverlay(shards, new Map([[today, [k1, k2]]]));
  assert.strictEqual(f.get(k2), today); assert.strictEqual(f.get(k1), '2026-09-01');
  const nv = X.newVsReturning({ [k1]: { orders: 1, cents: 10 }, [k2]: { orders: 1, cents: 20 } }, f, today);
  assert.deepStrictEqual([nv.new.customers, nv.new.cents, nv.returning.customers, nv.returning.cents], [1, 20, 1, 10]);
  // same-day refund: k2's only Sale today was refunded → absent from the live set → no index entry
  f = X.firstDatesWithOverlay(shards, new Map([[today, [k1]]]));
  assert.strictEqual(f.has(k2), false);
  // a stored day becoming empty on re-settle removes it from every list
  const emptied = X.rederive(shards, ['2026-09-01'], new Map([['2026-09-01', []]]));
  assert.deepStrictEqual(X.flatten(emptied).size, 0);
  // overlay REPLACES stored membership of the live date (stale stored day can't double count)
  const stale = X.rederive({}, [today], new Map([[today, [k2]]]));
  f = X.firstDatesWithOverlay(stale, new Map([[today, []]]));
  assert.strictEqual(f.has(k2), false, 'live set replaces the stored membership of that date');
  assert.throws(() => X.rederive({}, ['2026-09-01'], new Map([['2026-09-02', [k1]]])), /unsettled_contribution/);
  ok('live overlay: first-ever today, same-day refund, emptied day, replacement not union');
}
console.log(`\nstats-additivity: ${n} cells passed`);
