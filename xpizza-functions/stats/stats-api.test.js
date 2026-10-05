'use strict';
// Merchant STATS — getSalesStats core. The REAL authorizeCatalogEdit (catalog-edit-auth.js:48) decides
// access against a membership double; data comes from a REAL job run over real-writer fixtures.
// Run: node stats/stats-api.test.js
const assert = require('assert');
const T = require('./stats-time');
const S = require('./stats-store');
const J = require('./stats-job');
const A = require('./stats-api');
const F = require('./stats-fixtures');
const { makeRtdb } = require('./stats-rtdb-fake');
const { makeDb } = require('../catalog/firestore-fake');
const { makeCustomerKeyer } = require('./stats-identity');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SECRET = 's'.repeat(40);
const keyer = makeCustomerKeyer(SECRET);
const NOW = T.dayStartMs('2026-10-20') + 15 * 3600000;   // 2026-10-20 15:00 local
const TODAY = '2026-10-20';
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;

// Membership double: RTDB paths that exist. `throwAll` simulates an outage.
function members(paths, { throwAll = false } = {}) {
  const set = new Set(paths);
  return { ref: (p) => ({ once: async () => { if (throwAll) throw new Error('down'); return { exists: () => set.has(p) }; } }) };
}
const TOKENS = {
  ownerA: { uid: 'uA' }, ownerB: { uid: 'uB' }, staffA: { uid: 'sA' }, disp: { uid: 'd1' }, cust: { uid: 'c1', customer: true },
};
const MEMBERS = ['restaurants/r_a/owners/uA', 'restaurants/r_b/owners/uB', 'restaurants/r_a/kitchen_staff/sA', 'dispatchers/d1',
  'restaurants/zz_third_merchant/owners/uZ'];
TOKENS.ownerZ = { uid: 'uZ' };
const verifyIdToken = async (t) => { if (!TOKENS[t]) throw new Error('bad token'); return TOKENS[t]; };
const req = (query, token) => ({ method: 'GET', query, get: (h) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined) });

// Spy wrappers that LOG every read, so "authorize before any read" is observable.
function spyFs(fs, log) {
  const wrapRef = (ref) => ({ ...ref, get: async () => { log.push(`fs:${ref.path}`); return ref.get(); } });
  const col = (base) => ({ doc: (id) => { const r = base.doc(id); return { ...wrapRef(r), path: r.path, collection: (c) => col(r.collection(c)) }; } });
  return { collection: (c) => col(fs.collection(c)), runTransaction: fs.runTransaction };
}
function spyRtdb(rtdb, log) { return { ref: (p) => { log.push(`rtdb:${p}`); return rtdb.ref(p); } }; }

async function world() {
  const orders = {};
  const add = (o) => { orders[o.order_id] = o; return o; };
  // r_a: a returning customer (first Sale 2026-10-01), sales over the last weeks, cancellations, refunds.
  add(F.deliver(F.pickup(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-01', 12), phone: '+504 8888-0001', totalCents: 10000, items: [{ name: 'Pizza "Especial", grande', qty: 2, unit: 50 }] }), at('2026-10-01', 12, 20)), at('2026-10-01', 12, 45)));
  add(F.cashOrder({ rid: 'r_a', pm: 'card_delivery', now: at('2026-10-14', 13), phone: '88880001', totalCents: 20000, items: [{ name: '=HYPERLINK("x")', qty: 1, unit: 200 }] }));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-15', 19), phone: '88880002', totalCents: 30000 }));
  add(F.cancel(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-15', 20), phone: '88880003', totalCents: 4000 })));
  add(F.cancel(F.materialize({ ...F.onlinePending({ rid: 'r_a', now: at('2026-10-16', 11), phone: '88880004', totalCents: 6000 }), payment_status: 'confirmed' }, at('2026-10-16', 11, 1)), 'refunded'));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-08', 12), phone: '88880005', totalCents: 7000 }));   // previous_week of 10-15
  // TODAY (live): a first-ever customer + a returning one + a same-day refund
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 10), phone: '88880009', totalCents: 1500 }));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 11), phone: '88880002', totalCents: 2500 }));
  add(F.cancel(F.materialize({ ...F.onlinePending({ rid: 'r_a', now: at(TODAY, 12), phone: '88880010', totalCents: 999 }), payment_status: 'confirmed' }, at(TODAY, 12, 1)), 'refunded'));
  // r_b and a synthetic third merchant
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at('2026-10-15', 12), phone: '88880001', totalCents: 99900 }));
  add(F.cashOrder({ rid: 'zz_third_merchant', pm: 'cash', now: at('2026-10-15', 12), phone: '88880001', totalCents: 12300 }));
  const fs = makeDb();
  const rtdb = makeRtdb(orders);
  const deps = { rtdb, fsdb: fs, keyer, listRestaurants: async () => ['r_a', 'r_b', 'zz_third_merchant'], log: () => {} };
  await J.runStatsRollup(deps, { nowMs: NOW, mode: 'range', from: '2026-09-25', to: '2026-10-19', commit: true });
  return { orders, add, fs, rtdb };
}
function core(w, { memberDb = members(MEMBERS), getKeyer = () => keyer, log = null, nowMs = NOW, fsdb = null } = {}) {
  return (query, token) => {
    const r = req(query, token);
    return A.getSalesStatsCore({
      authorize: (rid) => authorizeCatalogEdit({ db: memberDb, verifyIdToken }, r, rid),
      fsdb: fsdb || (log ? spyFs(w.fs, log) : w.fs), rtdb: log ? spyRtdb(w.rtdb, log) : w.rtdb,
      getKeyer, nowMs, liveCache: A.makeLiveCache(),
    }, r);
  };
}
const Q = (o) => ({ restaurantId: 'r_a', from: '2026-10-14', to: '2026-10-16', ...o });

(async () => {
  const w = await world();

  // 1. 🔴 AUTHORIZATION BEFORE ANY READ — every denial performs ZERO reads; statuses pass through.
  {
    for (const [token, rid, status, memberDb] of [
      [null, 'r_a', 401], ['nope', 'r_a', 401], ['cust', 'r_a', 403], ['ownerB', 'r_a', 403],
      ['ownerA', 'BAD RID!', 400], ['ownerA', 'r_a', 503, members(MEMBERS, { throwAll: true })],
    ]) {
      const log = [];
      const res = await core(w, { log, memberDb })(Q({ restaurantId: rid }), token);
      assert.strictEqual(res.status, status, `${token} → ${rid}`);
      assert.deepStrictEqual(log, [], `${token} → ${rid}: read before authorization: ${log.join(',')}`);
    }
    const log = [];
    const res = await core(w, { log })(Q(), 'ownerA');
    assert.strictEqual(res.status, 200); assert(log.length > 0, 'non-vacuity: the spy sees reads when authorized');
    ok('authorize FIRST: 401/403/400/503 denials perform zero reads (spy proven non-vacuous)');
  }

  // 2. OWNER-ONLY (owner ruling 2026-10-05, supersedes the plan's "complete existing policy") + OWNER
  //    ISOLATION both ways — in EVERY form (JSON, daily CSV, orders CSV), with zero reads on refusal.
  {
    const c = core(w);
    const forms = [{}, { format: 'csv' }, { format: 'csv', kind: 'orders' }];
    for (const f of forms) {
      const tag = JSON.stringify(f);
      assert.strictEqual((await c(Q(f), 'ownerA')).status, 200, `owner A reads A ${tag}`);
      assert.strictEqual((await c(Q({ restaurantId: 'r_b', ...f }), 'ownerA')).status, 403, `A cannot read B ${tag}`);
      assert.strictEqual((await c(Q({ restaurantId: 'r_b', ...f }), 'ownerB')).status, 200);
      assert.strictEqual((await c(Q(f), 'ownerB')).status, 403, `B cannot read A ${tag}`);
      for (const tok of ['staffA', 'disp']) {
        const log = [];
        const r = await core(w, { log })(Q(f), tok);
        assert.strictEqual(r.status, 403, `${tok} ${tag}`);
        assert.deepStrictEqual(r.body, { error: 'not_owner', detail: 'sales stats are visible to restaurant owners' });
        assert.deepStrictEqual(log, [], `${tok}: no read before the owner check`);
      }
      const cust = await c(Q(f), 'cust');
      assert.strictEqual(cust.status, 403); assert.strictEqual(cust.body.error, 'not_authorized', 'customers rejected as before');
      const keepWarn = console.warn; console.warn = () => {};
      try { assert.strictEqual((await core(w, { memberDb: members(MEMBERS, { throwAll: true }) })(Q(f), 'ownerA')).status, 503, 'an authorization outage stays 503'); }
      finally { console.warn = keepWarn; }
    }
    ok('OWNER-ONLY in JSON / daily CSV / orders CSV: A↛B, B↛A, staff + dispatcher 403 not_owner (no reads), customer rejected, outage 503');
  }

  // 3. Parameter validation + 2-year cap.
  {
    const c = core(w);
    const st = async (q) => (await c(Q(q), 'ownerA')).status;
    assert.strictEqual(await st({ to: '2026-10-21' }), 400, 'future');
    assert.strictEqual(await st({ from: '2026-10-16', to: '2026-10-14' }), 400);
    assert.strictEqual(await st({ from: '2024-10-18', to: '2026-10-19' }), 400, '732 days');
    assert.strictEqual(await st({ from: '2024-10-19', to: '2026-10-19' }), 200, '731 days ok');
    for (const bad of [{ granularity: 'hour' }, { compare: 'yoy' }, { format: 'xml' }, { kind: 'x' }, { from: '2026-10-1' }, { cursor: '1;DROP' }]) assert.strictEqual(await st(bad), 400, JSON.stringify(bad));
    ok('range / granularity / compare / format / cursor validated; 2-year cap');
  }

  // 4. KPIs, comparisons, deltas, series foot to the KPI.
  {
    const res = await core(w)(Q({ compare: 'previous_week' }), 'ownerA');
    const b = res.body;
    assert.deepStrictEqual(b.kpis.sales_cents, 50000); assert.strictEqual(b.kpis.orders, 2);
    assert.strictEqual(b.kpis.average_paid_ticket_cents, 25000);
    assert.deepStrictEqual(b.comparison.range, { from: '2026-10-07', to: '2026-10-09' });
    assert.strictEqual(b.comparison.kpis.sales_cents, 7000);
    assert.strictEqual(b.deltas.sales_pct, Math.round(((50000 - 7000) / 7000) * 10000) / 100);
    assert.strictEqual(b.series.reduce((a, s) => a + s.sales_cents, 0), b.kpis.sales_cents);
    assert.strictEqual(b.by_payment.cash.cents + b.by_payment.card_delivery.cents, 50000);
    assert.deepStrictEqual(b.cancellations.cancelled, { orders: 1, cents: 4000 });
    assert.deepStrictEqual(b.cancellations.refunded, { orders: 1, cents: 6000 });
    assert.strictEqual(b.cancellations.rate_pct, 50, '(1+1)/(2+1+1)');
    assert.strictEqual(b.cancellations.lost_cents, 10000);
    const prev = (await core(w)(Q(), 'ownerA')).body;
    assert.deepStrictEqual(prev.comparison.range, { from: '2026-10-11', to: '2026-10-13' }, 'default = previous period of equal length');
    const none = (await core(w)(Q({ compare: 'none' }), 'ownerA')).body;
    assert.strictEqual(none.comparison, null);
    const wk = (await core(w)({ restaurantId: 'r_a', from: '2026-09-28', to: '2026-10-19', granularity: 'week' }, 'ownerA')).body;
    assert.deepStrictEqual(wk.series.map((s) => s.key), ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
    assert.strictEqual(wk.series.reduce((a, s) => a + s.orders, 0), wk.kpis.orders);
    const mo = (await core(w)({ restaurantId: 'r_a', from: '2026-09-28', to: '2026-10-19', granularity: 'month' }, 'ownerA')).body;
    assert.deepStrictEqual(mo.series.map((s) => s.key), ['2026-09', '2026-10']);
    assert.strictEqual(wk.heatmap.length, 7); assert.strictEqual(wk.heatmap[0].length, 24);
    assert.strictEqual(wk.heatmap[T.weekdayOf('2026-10-15')][19].orders, 1);
    ok('KPIs, previous / previous_week / none, deltas, day/week/month series, heatmap, cancellation rate');
  }

  // 5. LIVE today (never stored) + overlay: first-ever today = new; returning; same-day refund.
  {
    const b = (await core(w)({ restaurantId: 'r_a', from: TODAY, to: TODAY, compare: 'none' }, 'ownerA')).body;
    assert.deepStrictEqual(b.days, [{ date: TODAY, computed_at: 'live' }]);
    assert.strictEqual(b.kpis.sales_cents, 4000); assert.strictEqual(b.cancellations.refunded.orders, 1);
    assert.deepStrictEqual(b.customers.new, { customers: 1, orders: 1, cents: 1500 }, '88880009 first-ever today');
    assert.deepStrictEqual(b.customers.returning, { customers: 1, orders: 1, cents: 2500 }, '88880002 bought 10-15');
    assert.strictEqual(b.customers.unindexed, 0);
    assert.strictEqual(await S.dailyRef(w.fs, 'r_a', TODAY).get().then((s) => s.exists), false, 'today is never stored');
    // the same 88880002 counted NEW over a period starting before their first Sale
    const all = (await core(w)({ restaurantId: 'r_a', from: '2026-10-10', to: TODAY, compare: 'none' }, 'ownerA')).body;
    assert.strictEqual(all.customers.new.customers, 2, '88880002 (first 10-15) + 88880009 (today); 88880001 returning (first 10-01)');
    assert.strictEqual(all.customers.returning.customers, 1);
    ok('live today + in-memory overlay: first-ever today, returning, same-day refund; today never stored');
  }

  // 6. Yesterday not yet settled (00:00 → nightly) is computed live; missing days are flagged, not zero.
  {
    const nowEarly = T.dayStartMs('2026-10-21') + 3600000;   // 01:00 on the 21st; the 20th is not stored
    const b = (await core(w, { nowMs: nowEarly })({ restaurantId: 'r_a', from: '2026-10-19', to: '2026-10-21', compare: 'none' }, 'ownerA')).body;
    assert.deepStrictEqual(b.days.map((d) => d.computed_at === 'live'), [false, true, true]);
    assert.strictEqual(b.kpis.sales_cents, 4000);
    const gap = (await core(w)({ restaurantId: 'r_a', from: '2026-09-20', to: '2026-09-26', compare: 'none' }, 'ownerA')).body;
    assert.deepStrictEqual(gap.missing_days, ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'], 'never computed ≠ zero');
    ok('unsettled yesterday computed live; never-computed days reported as missing');
  }

  // 7. 🔴 PRIVACY: no phone, name, address or hmac anywhere in a JSON or CSV response.
  {
    const bodies = [
      JSON.stringify((await core(w)({ restaurantId: 'r_a', from: '2026-09-28', to: TODAY }, 'ownerA')).body),
      (await core(w)({ restaurantId: 'r_a', from: '2026-09-28', to: TODAY, format: 'csv' }, 'ownerA')).body,
      (await core(w)({ restaurantId: 'r_a', from: '2026-10-01', to: TODAY, format: 'csv', kind: 'orders' }, 'ownerA')).body,
    ];
    const phones = Object.values(w.orders).map((o) => String(o.customer_phone)).concat(['8888', '50488']);
    for (const body of bodies) {
      for (const p of phones) assert(!body.includes(p), `phone fragment ${p} leaked`);
      assert(!/h1:[0-9a-f]{8}/.test(body), 'no customer hmac');
      assert(!body.includes('Cliente') && !body.includes('address') && !/\ba\b,\s*b/.test(body), 'no name / address');
    }
    // non-vacuity: the daily docs DO hold hmacs, which the API consumed and did not emit
    const d = (await S.dailyRef(w.fs, 'r_a', '2026-10-15').get()).data();
    assert(Object.keys(d.customers).some((k) => /^h1:/.test(k)));
    ok('responses (JSON, daily CSV, orders CSV) carry aggregates only — no phone / name / address / hmac');
  }

  // 8. CSV: allowlist columns, escaping, formula-injection guard.
  {
    const res = await core(w)({ restaurantId: 'r_a', from: '2026-10-01', to: '2026-10-16', format: 'csv', kind: 'orders' }, 'ownerA');
    assert.strictEqual(res.status, 200); assert.match(res.contentType, /^text\/csv/);
    const lines = res.body.trim().split('\r\n');
    assert.strictEqual(lines[0], A.ORDER_COLUMNS.join(','));
    assert.deepStrictEqual(A.ORDER_COLUMNS, ['fecha', 'hora', 'numero', 'tipo', 'metodo_pago', 'clase', 'total_L', 'subtotal_L', 'isv_L', 'articulos']);
    assert.strictEqual(lines.length - 1, 6, 'r_a orders in range, every class');
    assert(res.body.includes('"2x Pizza ""Especial"", grande"'), 'quotes and commas escaped');
    assert(res.body.includes("1x =HYPERLINK"), 'inner text kept');
    assert.strictEqual(A.csvCell('=1+1'), "'=1+1"); assert.strictEqual(A.csvCell('-5'), '-5'); assert.strictEqual(A.csvCell('@x'), "'@x");
    assert.strictEqual(A.csvCell('a\nb'), '"a\nb"');
    const daily = await core(w)({ restaurantId: 'r_a', from: '2026-10-14', to: '2026-10-16', format: 'csv' }, 'ownerA');
    const dl = daily.body.trim().split('\r\n');
    assert.strictEqual(dl.length, 4); assert(dl[2].startsWith('2026-10-15,300.00,1,'));
    ok('orders CSV allowlist + escaping + formula guard; daily CSV rows');
  }

  // 9. Orders CSV is BOUNDED: ≤ 31 days, ONE page per call, cursor continues without overlap.
  {
    assert.strictEqual((await core(w)({ restaurantId: 'r_a', from: '2026-09-01', to: '2026-10-16', format: 'csv', kind: 'orders' }, 'ownerA')).status, 400);
    const big = { ...w };
    const many = {};
    for (let i = 0; i < 1500; i++) { const o = F.cashOrder({ rid: i % 3 ? 'r_a' : 'r_b', pm: 'cash', now: at('2026-10-15', 8) + i * 1000, phone: '1', totalCents: 100 }); many[o.order_id] = o; }
    big.rtdb = makeRtdb(many);
    const c = core(big);
    const p1 = await c({ restaurantId: 'r_a', from: '2026-10-15', to: '2026-10-15', format: 'csv', kind: 'orders' }, 'ownerA');
    assert(p1.headers['X-Next-Cursor']);
    const p2 = await c({ restaurantId: 'r_a', from: '2026-10-15', to: '2026-10-15', format: 'csv', kind: 'orders', cursor: p1.headers['X-Next-Cursor'] }, 'ownerA');
    assert.strictEqual(p2.headers['X-Next-Cursor'], undefined);
    const rows = p1.body.trim().split('\r\n').length - 1 + p2.body.trim().split('\r\n').length - 1;
    assert.strictEqual(rows, 1000, 'every r_a order exactly once across pages');
    ok('orders CSV: 31-day cap, one bounded page per call, cursor pagination exact');
  }

  // 10. Secret missing → 503 AFTER authorization (fail closed; never hashes with no key).
  {
    const res = await core(w, { getKeyer: () => { throw new Error('stats_secret_unavailable'); } })(Q(), 'ownerA');
    assert.strictEqual(res.status, 503);
    const denied = await core(w, { getKeyer: () => { throw new Error('x'); } })(Q(), 'cust');
    assert.strictEqual(denied.status, 403, 'authorization still answers first');
    ok('missing secret → 503 (fail closed), after authorization');
  }

  // 11. Epoch changes mid-read → ONE retry; a second change → 503 retryable.
  {
    let bumps = 0, metaReads = 0;
    const flaky = (mode) => ({
      collection: (c) => {
        const col = (base) => ({ doc: (id) => { const r = base.doc(id); return { ...r, path: r.path, collection: (cc) => col(r.collection(cc)), get: async () => {
          const s = await r.get();
          if (r.path.endsWith('stats_meta/state')) {
            metaReads++;
            if (mode === 'always' || (mode === 'once' && bumps === 0)) { bumps++; return { ...s, exists: true, data: () => ({ ...s.data(), epoch: 1000 + metaReads }) }; }
          }
          return s;
        } }; } });
        return col(w.fs.collection(c));
      },
    });
    bumps = 0; metaReads = 0;
    assert.strictEqual((await core(w, { fsdb: flaky('once') })(Q(), 'ownerA')).status, 200);
    assert.strictEqual(metaReads, 4, 'read, epoch moved, re-read once');
    bumps = 0; metaReads = 0;
    const r2 = await core(w, { fsdb: flaky('always') })(Q(), 'ownerA');
    assert.strictEqual(r2.status, 503); assert.strictEqual(r2.body.retryable, true);
    ok('epoch check before/after: one retry, then 503 retryable');
  }

  // 12. Brand-agnostic: the synthetic third merchant's owner reads its stats; no code change.
  {
    const b = (await core(w)({ restaurantId: 'zz_third_merchant', from: '2026-10-15', to: '2026-10-15' }, 'ownerZ')).body;
    assert.strictEqual(b.kpis.sales_cents, 12300);
    assert.strictEqual((await core(w)({ restaurantId: 'zz_third_merchant', from: '2026-10-15', to: '2026-10-15' }, 'ownerA')).status, 403);
    ok('a synthetic 3rd restaurant works end to end, isolated');
  }

  // 13. Items: rewards flagged, shares, sorted by revenue; times shaped with coverage.
  {
    const b = (await core(w)({ restaurantId: 'r_a', from: '2026-10-01', to: '2026-10-01' }, 'ownerA')).body;
    assert.deepStrictEqual(b.items[0], { name: 'Pizza "Especial", grande', reward: false, qty: 2, cents: 10000, share_pct: 100 });
    assert.strictEqual(b.times.prep.n, 1); assert.strictEqual(b.times.prep.avg_ms, 20 * 60000); assert.strictEqual(b.times.prep.coverage, 100);
    assert.strictEqual(b.times.delivery.median.lo_ms, 25 * 60000);
    assert.strictEqual(b.fulfilled.orders, 1);
    ok('items, times (avg / median bucket / coverage), fulfilled');
  }
  // 14. 🔴 B1 EXACT REPRO (codex build r1 #1): first Sale YESTERDAY (not yet settled), second TODAY;
  //     a today-only request with compare=none must count them RETURNING, not new.
  {
    const orders = {};
    const add = (o) => { orders[o.order_id] = o; return o; };
    add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-19', 20), phone: '88881111', totalCents: 1000 }));
    add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 10), phone: '88881111', totalCents: 2000 }));
    const w2 = { fs: makeDb(), rtdb: makeRtdb(orders) };   // NOTHING settled: yesterday is unsettled
    const b = (await core(w2)({ restaurantId: 'r_a', from: TODAY, to: TODAY, compare: 'none' }, 'ownerA')).body;
    assert.deepStrictEqual(b.customers.returning, { customers: 1, orders: 1, cents: 2000 }, 'bought yesterday → returning today');
    assert.deepStrictEqual(b.customers.new, { customers: 0, orders: 0, cents: 0 });
    assert.strictEqual(b.kpis.sales_cents, 2000, "yesterday's numbers are NOT added to a today-only period");
    // and once yesterday IS settled, it comes from storage, not from the live scan
    await J.runStatsRollup({ rtdb: w2.rtdb, fsdb: w2.fs, keyer, listRestaurants: async () => ['r_a'], log: () => {} }, { nowMs: NOW, mode: 'range', from: '2026-10-19', to: '2026-10-19', commit: true });
    const b2 = (await core(w2)({ restaurantId: 'r_a', from: TODAY, to: TODAY, compare: 'none' }, 'ownerA')).body;
    assert.deepStrictEqual(b2.customers.returning, { customers: 1, orders: 1, cents: 2000 });
    ok('B1: an unsettled yesterday feeds the overlay even when the request is today-only (returning, not new)');
  }

  // 15. 🔴 B2 (codex build r1 #2): ten concurrent COLD requests — across restaurants — share ONE scan;
  //     a historical-only request scans nothing; a failed scan backs off instead of re-hammering /orders.
  {
    const counting = (rt) => { const qs = []; return { qs, ref: (path) => { const r = rt.ref(path); const wrap = (q) => new Proxy(q, { get(t, k) { const v = t[k]; if (typeof v !== 'function') return v; if (k === 'once') return (...a) => { qs.push(path); return new Promise((res) => setTimeout(res, 20)).then(() => v.apply(t, a)); }; return (...a) => wrap(v.apply(t, a)); } }); return wrap(r); } }; };
    const rt = counting(w.rtdb);
    const cache = A.makeLiveCache();
    const call = (rid, q, token) => { const r = req({ restaurantId: rid, ...q }, token); return A.getSalesStatsCore({ authorize: async () => ({ ok: true, role: 'owner' }), fsdb: w.fs, rtdb: rt, getKeyer: () => keyer, nowMs: NOW, liveCache: cache }, r); };
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => call(['r_a', 'r_b', 'zz_third_merchant'][i % 3], { from: TODAY, to: TODAY, compare: 'none' })));
    assert(res.every((x) => x.status === 200));
    assert.strictEqual(rt.qs.length, 1, `10 concurrent cold requests made ${rt.qs.length} /orders reads`);
    assert.strictEqual(cache.scans, 1);
    assert.strictEqual(res[0].body.kpis.sales_cents, 4000, 'the shared scan still answers per restaurant');
    // historical-only (yesterday settled by the world's rollup): no live scan at all
    // (a FRESH cache, so a scan cannot hide behind the warm entry the concurrent requests just made)
    const rtH = counting(w.rtdb), cacheH = A.makeLiveCache();
    const hist = await A.getSalesStatsCore({ authorize: async () => ({ ok: true, role: 'owner' }), fsdb: w.fs, rtdb: rtH, getKeyer: () => keyer, nowMs: NOW, liveCache: cacheH }, req({ restaurantId: 'r_a', from: '2026-10-14', to: '2026-10-16', compare: 'previous' }, 'x'));
    assert.strictEqual(hist.status, 200);
    assert.strictEqual(rtH.qs.length, 0, 'historical request performed a live scan'); assert.strictEqual(cacheH.scans, 0);
    // non-vacuity: the same fresh setup DOES scan for a request that includes today
    await A.getSalesStatsCore({ authorize: async () => ({ ok: true, role: 'owner' }), fsdb: w.fs, rtdb: rtH, getKeyer: () => keyer, nowMs: NOW, liveCache: cacheH }, req({ restaurantId: 'r_a', from: TODAY, to: TODAY }, 'x'));
    assert.strictEqual(rtH.qs.length, 1);
    // failure → 503, then BACKOFF (no new read) until LIVE_BACKOFF_MS elapses
    let reads = 0;
    const broken = { ref: () => ({ orderByChild: () => broken.q, }), q: null };
    broken.q = { startAt: () => broken.q, startAfter: () => broken.q, endBefore: () => broken.q, limitToFirst: () => broken.q, once: async () => { reads++; throw new Error('rtdb down'); } };
    const bc = A.makeLiveCache();
    const callB = (nowMs) => A.getSalesStatsCore({ authorize: async () => ({ ok: true, role: 'owner' }), fsdb: w.fs, rtdb: broken, getKeyer: () => keyer, nowMs, liveCache: bc }, req({ restaurantId: 'r_a', from: TODAY, to: TODAY }, 'x'));
    const keepWarn = console.warn; console.warn = () => {};
    try {
      assert.strictEqual((await callB(NOW)).status, 503); assert.strictEqual(reads, 1);
      assert.strictEqual((await callB(NOW + 1000)).status, 503); assert.strictEqual(reads, 1, 'inside the backoff: no new read');
      assert.strictEqual((await callB(NOW + A.LIVE_BACKOFF_MS + 1)).status, 503); assert.strictEqual(reads, 2, 'after the backoff: one retry');
    } finally { console.warn = keepWarn; }
    ok('B2: single-flight shared scan (10 concurrent → 1 read), no scan for historical requests, failure backoff');
  }

  // 16. 🔴 S7 (codex build r1 #7): a cursor cannot leave the export range or cross restaurant/range.
  {
    const c = core(w);
    const q = { restaurantId: 'r_a', from: '2026-10-15', to: '2026-10-15', format: 'csv', kind: 'orders' };
    assert.strictEqual((await c({ ...q, cursor: '1:O0' }, 'ownerA')).status, 400, 'the codex repro (an untagged epoch cursor)');
    const p = { from: '2026-10-15', to: '2026-10-15' };
    const epoch = A.makeCursor('r_a', p, 1, 'O0');                       // correctly tagged but at the epoch
    const r1 = await c({ ...q, cursor: epoch }, 'ownerA');
    assert.strictEqual(r1.status, 400); assert.match(r1.body.detail, /outside the export range/);
    const inRange = A.makeCursor('r_a', p, at('2026-10-15', 1), 'O0');
    assert.strictEqual((await c({ ...q, cursor: inRange }, 'ownerA')).status, 200);
    assert.strictEqual((await c({ ...q, restaurantId: 'r_b', cursor: inRange }, 'ownerB')).status, 400, 'another restaurant');
    assert.strictEqual((await c({ ...q, to: '2026-10-16', cursor: inRange }, 'ownerA')).status, 400, 'another range');
    ok('S7: cursors are tagged to restaurant + range and must lie inside the padded read window');
  }

  console.log(`\nstats-api: ${n} cells passed`);
})().catch((e) => { console.error(e); process.exit(1); });
