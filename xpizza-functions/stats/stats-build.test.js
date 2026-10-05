'use strict';
// Merchant STATS — the pure builder (real-writer fixtures). Run: node stats/stats-build.test.js
const assert = require('assert');
const B = require('./stats-build');
const F = require('./stats-fixtures');
const T = require('./stats-time');
const { makeCustomerKeyer } = require('./stats-identity');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const keyer = makeCustomerKeyer('k'.repeat(40));
const D = '2026-10-05';
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const build = (orders, rid = 'r1', dates = [D]) => B.buildDailies(orders, { keyer, restaurants: new Set([rid]), dates: new Set(dates) }).get(rid);

// 1. Day boundaries: 23:59 vs 00:00 local land on different dates and hours.
{
  const a = F.cashOrder({ rid: 'r1', pm: 'cash', now: T.dayEndMs(D) - 60000, phone: '88880001', totalCents: 10000 });
  const b = F.cashOrder({ rid: 'r1', pm: 'cash', now: T.dayEndMs(D), phone: '88880001', totalCents: 20000 });
  const m = build([a, b], 'r1', [D, T.addDays(D, 1)]);
  assert.strictEqual(m.get(D).sale.cents, 10000); assert.strictEqual(m.get(D).by_hour[23].orders, 1);
  assert.strictEqual(m.get(T.addDays(D, 1)).sale.cents, 20000); assert.strictEqual(m.get(T.addDays(D, 1)).by_hour[0].orders, 1);
  ok('half-open business-day boundaries');
}

// 2. A 7-day-ahead scheduled order lands on its SERVICE date, not its creation date.
{
  const sf = at(T.addDays(D, 7), 19);
  const o = F.scheduledCashOrder({ rid: 'r1', pm: 'cash', now: at(D, 10), phone: '88880002', totalCents: 30000, scheduledFor: sf });
  const m = build([o], 'r1', [D, T.addDays(D, 7)]);
  assert.strictEqual(m.get(D).sale.orders, 0);
  assert.strictEqual(m.get(T.addDays(D, 7)).sale.orders, 1);
  assert.strictEqual(m.get(T.addDays(D, 7)).by_hour[19].orders, 1);
  ok('7-day-ahead scheduled order attributed to its service date and hour');
}

// 3. All three payment methods (+ '' → other), Σ by_payment == Σ by_type == sale.orders.
{
  const os = ['cash', 'card_delivery', '', 'card'].map((pm, i) => F.cashOrder({ rid: 'r1', pm, now: at(D, 12, i), phone: '8888000' + i, totalCents: 1000 * (i + 1) }));
  const p = F.onlinePending({ rid: 'r1', now: at(D, 13), phone: '88880009', totalCents: 5000 });
  os.push(F.materialize({ ...p, payment_status: 'confirmed' }, at(D, 13, 1)));
  const s = build(os).get(D);
  assert.strictEqual(s.by_payment.cash.cents, 1000); assert.strictEqual(s.by_payment.card_delivery.cents, 2000);
  assert.strictEqual(s.by_payment.online.cents, 5000); assert.strictEqual(s.by_payment.other.cents, 3000 + 4000);
  const sum = (o) => Object.values(o).reduce((a, x) => a + x.orders, 0);
  assert.strictEqual(sum(s.by_payment), s.sale.orders); assert.strictEqual(sum(s.by_type), s.sale.orders);
  assert.strictEqual(s.sale.orders, 5);
  ok("cash / card_delivery / online + '' and legacy under other; breakdowns foot to sale.orders");
}

// 4. Items: cents summed AS STORED (already qty × price, extras folded in) — never re-multiplied.
{
  const o = F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 14), phone: '88880003', items: [{ name: 'Pepperoni', qty: 3, unit: 289 }, { name: 'Coca-Cola', qty: 2, unit: 35 }] });
  assert.deepStrictEqual(o.summary_lines[0], { name: 'Pepperoni', qty: 3, cents: 86700 }, 'fixture premise: writer shape');
  const s = build([o]).get(D);
  assert.deepStrictEqual(s.items.Pepperoni, { qty: 3, cents: 86700 });
  assert.deepStrictEqual(s.items['Coca-Cola'], { qty: 2, cents: 7000 });
  ok('item revenue not re-multiplied by qty');
}

// 5. Reward lines keep their own key; zero-value Sales count as orders but not in average_paid_ticket.
{
  const paid = F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 15), phone: '88880004', totalCents: 24900, items: [{ name: 'Margherita', qty: 1, unit: 249 }] });
  const free = F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 15, 5), phone: '88880005', totalCents: 0, items: [{ name: 'Margherita', qty: 1, cents: 0 }] });
  const s = build([paid, free]).get(D);
  assert.deepStrictEqual(s.items.Margherita, { qty: 1, cents: 24900 });
  assert.deepStrictEqual(s.items['reward:Margherita'], { qty: 1, cents: 0 });
  assert.strictEqual(s.sale.orders, 2); assert.strictEqual(s.sale.zero_value_orders, 1);
  assert.strictEqual(B.avgPaidTicket(s.sale), 24900, 'average over PAID orders only');
  assert.strictEqual(B.avgPaidTicket({ orders: 1, cents: 0, zero_value_orders: 1 }), null, 'null when no paid order');
  ok('reward discriminator + zero-value orders + average_paid_ticket denominator');
}

// 6. Times: prep (service start → pickup) and delivery (pickup → delivered), delivery orders only;
//    missing / negative excluded, never zero-filled; scheduled prep starts at materialized_at.
{
  const a = F.deliver(F.pickup(F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 18), phone: '1', totalCents: 100 }), at(D, 18, 20)), at(D, 18, 45));
  const b = F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 18, 1), phone: '1', totalCents: 100 });                 // not picked up yet
  const c = F.pickup(F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 18, 30), phone: '1', totalCents: 100 }), at(D, 18, 10));   // negative
  const pk = F.kds(F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 18), phone: '1', totalCents: 100, orderType: 'pickup' }), 'completed');
  const sched = F.scheduledCashOrder({ rid: 'r1', pm: 'cash', now: at(T.addDays(D, -2), 9), phone: '1', totalCents: 100, scheduledFor: at(D, 20) });
  const sm = F.pickup(F.materialize(sched, at(D, 19, 30)), at(D, 19, 50));
  const s = build([a, b, c, pk, sm]).get(D);
  assert.strictEqual(s.prep.eligible, 4, 'four delivery Sales; the pickup order is not eligible');
  assert.strictEqual(s.prep.n, 2, 'a (20 min) + scheduled (20 min from materialized_at); b missing, c negative');
  assert.strictEqual(s.prep.sum_ms, 40 * 60000);
  assert.strictEqual(s.delivery.n, 1); assert.strictEqual(s.delivery.sum_ms, 25 * 60000);
  assert.strictEqual(s.prep.hist[4], 2, '20 min → bucket [20,25)');
  ok('prep/delivery: eligibility, exclusion of missing/negative, scheduled start = materialized_at');
}

// 7. Classes counted; fulfilled is orthogonal; anonymous Sales counted without a customer key.
{
  const os = [
    F.cancel(F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 9), phone: '1', totalCents: 500 })),
    F.cancel(F.materialize({ ...F.onlinePending({ rid: 'r1', now: at(D, 9), phone: '1', totalCents: 700 }), payment_status: 'confirmed' }, at(D, 9, 1)), 'refunded'),
    F.onlinePending({ rid: 'r1', now: at(D, 9), phone: '1', totalCents: 900 }),
    F.deliver(F.pickup(F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 9), phone: 'nope', totalCents: 1100 }), at(D, 9, 30)), at(D, 9, 50)),
  ];
  const s = build(os).get(D);
  assert.deepStrictEqual(s.cancelled, { orders: 1, cents: 500 });
  assert.deepStrictEqual(s.refunded, { orders: 1, cents: 700 });
  assert.strictEqual(s.excluded.orders, 1);
  assert.strictEqual(s.sale.orders, 1); assert.strictEqual(s.fulfilled.orders, 1);
  assert.strictEqual(s.sale.anonymous_orders, 1); assert.deepStrictEqual(s.customers, {});
  ok('class counters, fulfilled, anonymous Sales');
}

// 8. Restaurant scoping + legacy rid-less orders via restaurant-id.js DEFAULT_RESTAURANT_ID (C2).
{
  const { DEFAULT_RESTAURANT_ID } = require('../restaurant-id');
  const legacy = F.cashOrder({ rid: 'r1', pm: 'cash', now: at(D, 8), phone: '1', totalCents: 100 }); delete legacy.restaurant_id;
  const other = F.cashOrder({ rid: 'r_other', pm: 'cash', now: at(D, 8), phone: '1', totalCents: 100 });
  const m = B.buildDailies([legacy, other], { keyer, restaurants: new Set([DEFAULT_RESTAURANT_ID, 'r1']), dates: new Set([D]) });
  assert.strictEqual(m.get(DEFAULT_RESTAURANT_ID).get(D).sale.orders, 1);
  assert.strictEqual(m.get('r1').get(D).sale.orders, 0, "another restaurant's order never leaks in");
  ok('restaurant scoping; rid-less legacy order → the platform default (imported, not a literal)');
}

// 9. Empty target dates are real zeros (so a stale doc cannot survive a re-settle).
{
  const m = build([], 'r1', [D, T.addDays(D, 1)]);
  assert.deepStrictEqual(m.get(D), B.emptySummary());
  ok('every target date gets a summary, empty = zero');
}

// 10. Histogram median resolution.
{
  const h = { n: 3, hist: [0, 0, 1, 1, 1, ...new Array(20).fill(0)] };
  assert.deepStrictEqual(B.histMedian(h), { bucket: 3, lo_ms: 15 * 60000, hi_ms: 20 * 60000, approx_ms: 17.5 * 60000 });
  const over = { n: 1, hist: [...new Array(24).fill(0), 1] };
  assert.strictEqual(B.histMedian(over).hi_ms, null, 'overflow bucket is open-ended');
  assert.strictEqual(B.histMedian({ n: 0, hist: [] }), null);
  ok('histogram median bucket');
}
console.log(`\nstats-build: ${n} cells passed`);
