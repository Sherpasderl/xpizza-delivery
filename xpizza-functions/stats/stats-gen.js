'use strict';
// TEST-ONLY. A seeded generator of whole order LIFECYCLES built from the real writers (stats-fixtures).
// Each order carries `_expect` — the class and facts the GENERATOR intended — so suites can check the
// builder against an expectation that does not come from classifyOrder.
const F = require('./stats-fixtures');
const T = require('./stats-time');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const MENU = [{ name: 'Margherita', unit: 249 }, { name: 'Pepperoni', unit: 289 }, { name: 'Coca-Cola', unit: 35 }, { name: 'Calzone "Especial", grande', unit: 310 }];

/**
 * generate({ seed, restaurants, from, days, perDay, phones }) → orders[]
 * Outcomes: cash/card/'' sale (delivered / pickup completed / live), online sale (materialized,
 * delivered), scheduled cash (served up to 7 days later), cancelled cash, refunded online, refund_pending
 * online, abandoned online, never-paid online, zero-value sale, anonymous (bad phone).
 */
function generate({ seed = 1, restaurants = ['r_a', 'r_b'], from = '2026-09-01', days = 20, perDay = 6, phones = 12 } = {}) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = [];
  for (let di = 0; di < days; di++) {
    const date = T.addDays(from, di);
    for (let k = 0; k < perDay; k++) {
      const rid = pick(restaurants);
      const created = T.dayStartMs(date) + Math.floor(r() * 86400000);
      const phoneN = Math.floor(r() * phones);
      const phone = r() < 0.08 ? 'sin-telefono' : String(88000000 + phoneN);   // ~8% anonymous
      const items = [];
      const nl = 1 + Math.floor(r() * 3);
      for (let i = 0; i < nl; i++) { const m = pick(MENU); items.push({ name: m.name, qty: 1 + Math.floor(r() * 3), unit: m.unit }); }
      const orderType = r() < 0.7 ? 'delivery' : 'pickup';
      const outcome = pick(['cash_done', 'cash_done', 'cash_live', 'online_done', 'online_done', 'card_done', 'blank_done', 'sched_cash', 'sched_online', 'cancel_cash', 'refunded', 'refund_pending', 'abandoned', 'never_paid', 'cancel_unpaid', 'zero_value']);
      const base = { rid, now: created, phone, items, orderType };
      const prep = 600000 + Math.floor(r() * 2400000), drive = 300000 + Math.floor(r() * 1800000);
      let o, cls;
      const finish = (x, start) => (orderType === 'delivery' ? F.deliver(F.pickup(x, start + prep), start + prep + drive) : F.kds(x, 'completed'));
      switch (outcome) {
        case 'cash_done': o = finish(F.cashOrder({ ...base, pm: 'cash' }), created); cls = 'sale'; break;
        case 'card_done': o = finish(F.cashOrder({ ...base, pm: 'card_delivery' }), created); cls = 'sale'; break;
        case 'blank_done': o = finish(F.cashOrder({ ...base, pm: '' }), created); cls = 'sale'; break;
        case 'cash_live': o = F.kds(F.cashOrder({ ...base, pm: 'cash' }), 'preparing'); cls = 'sale'; break;
        case 'zero_value': o = finish(F.cashOrder({ ...base, pm: 'cash', items: [{ name: 'Margherita', qty: 1, cents: 0 }], totalCents: 0 }), created); cls = 'sale'; break;
        case 'online_done': { const p = F.onlinePending({ ...base }); const m = F.materialize({ ...p, payment_status: 'confirmed' }, created + 60000); o = finish(m, created + 60000); cls = 'sale'; break; }
        case 'sched_cash': { const sf = created + Math.floor(r() * 7 * 86400000); o = F.scheduledCashOrder({ ...base, pm: 'cash', scheduledFor: sf }); if (sf < T.dayStartMs(T.addDays(from, days))) o = finish(F.materialize(o, sf - 1800000), sf - 1800000); cls = 'sale'; break; }
        case 'sched_online': { const sf = created + Math.floor(r() * 7 * 86400000); o = F.holdConfirmed(F.onlinePending({ ...base, scheduledFor: sf }), created + 60000); cls = 'sale'; break; }
        case 'cancel_cash': o = F.cancel(F.cashOrder({ ...base, pm: 'cash' })); cls = 'cancelled'; break;
        case 'refunded': o = F.cancel(F.materialize({ ...F.onlinePending(base), payment_status: 'confirmed' }, created + 60000), 'refunded'); cls = 'refunded'; break;
        case 'refund_pending': o = F.cancel(F.materialize({ ...F.onlinePending(base), payment_status: 'confirmed' }, created + 60000), 'refund_pending'); cls = 'refund_pending'; break;
        case 'abandoned': o = F.cancel(F.onlinePending(base), 'abandoned'); cls = 'excluded'; break;
        case 'never_paid': o = F.onlinePending(base); cls = 'excluded'; break;
        case 'cancel_unpaid': o = F.cancel(F.onlinePending(base)); cls = 'excluded'; break;
        default: throw new Error(outcome);
      }
      o._expect = { cls, rid, phone: phone === 'sin-telefono' ? null : phone, date: T.dateOf(T.serviceMs(o)), cents: o.total_cents, type: orderType, pm: o.payment_method };
      out.push(o);
    }
  }
  return out;
}

module.exports = { generate, rng, MENU };
