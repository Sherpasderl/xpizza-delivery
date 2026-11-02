'use strict';
// S-B step 2 — the INCREMENTAL producer, over the REAL writers: intake (buildCreateOrderUpdates), the fulfilment stamp (which writes
// rating_index — the fulfilled-order log), rateOrderCore + withdraw, a deleted_uids tombstone. The cost rule is ASSERTED from a read
// log: a run reads only the closed days' orders (four leaves each), never history and never the orders root.
// dish_qty comes from the REAL intake writer: index.js's `/* sb:begin cash-dish-qty */` hunk, lifted and run on the intake updates.
// Run: node ratings/aggregate-producer.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'aggregate-producer-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const FN = path.join(__dirname, '..');
const V2 = require('./rating-v2');
const AG = require('./aggregate');
const P = require('./aggregate-producer');
const { rateOrderCore } = require('./rate-order');
const { stampRatingFulfilment } = require('./rating-fulfilment');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));
const { hnDateISO } = require(path.join(FN, 'lib', 'hn-date'));
const vm = require('vm');
const fsys = require('fs');
const { MENU_BY_RESTAURANT } = require(path.join(FN, 'menu-pricing'));
const IDX = fsys.readFileSync(path.join(FN, 'index.js'), 'utf8');
const SB_CASH = IDX.slice(IDX.lastIndexOf('\n', IDX.indexOf('/* sb:begin cash-dish-qty */')) + 1, IDX.indexOf('/* sb:end cash-dish-qty */') + '/* sb:end cash-dish-qty */'.length + 1);
const XK = Object.keys(MENU_BY_RESTAURANT.x_pizza);
const DISH_OF = { d1: XK[0], d2: XK[1], d3: XK[2] };   // the test's canonical ids ↔ real menu keys, through a usable D4-a context
const CTX = { usableAsIdentity: true, objects: Object.entries(DISH_OF).map(([cid, k]) => ({ kind: 'dish', legacyKey: k, canonicalId: cid })) };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 aggregate-producer: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeDb() {
  const tree = {}; const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v, rows) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)),
    forEach: (cb) => { for (const [k, x] of (rows || Object.entries(v || {}))) if (cb({ key: k, val: () => clone(x) }) === true) return true; return false; } });
  const ref = (p = '') => ({
    get: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); }, once: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); },
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v === null ? null : prune(v)); },
    orderByKey: () => { const q = {}; const api = {
      startAt: (k) => { q.ge = k; return api; }, endAt: (k) => { q.le = k; return api; }, startAfter: (k) => { q.gt = k; return api; }, limitToFirst: (m) => { q.first = m; return api; },
      once: async () => {
        reads.push({ kind: 'query', path: p, ...q });
        let rows = Object.entries(get(p) || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        rows = rows.filter(([k]) => (q.ge === undefined || k >= q.ge) && (q.le === undefined || k <= q.le) && (q.gt === undefined || k > q.gt));
        if (q.first !== undefined) rows = rows.slice(0, q.first);
        return snap(rows.length ? Object.fromEntries(rows) : null, rows);
      } }; return api; },
    orderByChild: (c) => ({ equalTo: (v) => ({ once: async () => { const rows = Object.entries(get(p) || {}).filter(([, r]) => r && r[c] === v); return snap(rows.length ? Object.fromEntries(rows) : null); } }) }),
    transaction: async (fn) => {
      const actual = clone(get(p)) ?? null;
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: snap(get(p)) };
      if (actual !== null) { next = fn(actual); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; }
      set(p, prune(next)); return { committed: true, snapshot: snap(get(p)) };
    },
  });
  return { tree, reads, get, set, ref };
}
const DAY = AG.DAY_MS;
const NOW = P.dayRange('2027-03-10')[0] + 4.5 * 3600e3;              // 04:30 HN on 2027-03-10 (the scheduled hour)
const YDAY = '2027-03-09'; const Y0 = P.dayRange(YDAY)[0];
const R = 'x_pizza';
const verifyIdToken = async (t) => ({ uid: t.slice(4), customer: true });
let seq = 0;
async function served(db, { at, phone, dish = { d1: 1 }, uid = null, status = 'delivered', rid = R } = {}) {
  const id = `XPZ-${String(++seq).padStart(5, '0')}`;
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: at - 3600e3, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana', customer_phone: phone || `5049${String(1000000 + seq).slice(-7)}`, items_text: '1x', notes: '', payment_method: 'cash' },
    hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' }, restaurantId: rid,
    priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  if (uid) attachCustomerAttribution(u, id, uid, { now: at, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: [{ name: 'Margherita', qty: 1 }] });
  // the REAL intake hunk stamps dish_qty from the charged body lines
  vm.runInNewContext(SB_CASH, { updates: u, orderId: id, restaurantId: rid, pricingTables: { restaurantId: rid }, contextOfTables: () => CTX,
    body: { items: Object.entries(dish).map(([cid, qty]) => ({ name: DISH_OF[cid], qty })) }, require: (m) => require(m.startsWith('./') ? path.join(FN, m) : m) });
  assert.deepStrictEqual(u[`orders/${id}`].dish_qty, dish, 'premise: the intake hunk stamped dish_qty');
  await db.ref().update(u);
  db.set(`orders/${id}/status`, status);
  if (status === 'delivered' || status === 'completed') await stampRatingFulfilment(db, { orderId: id, status, now: at });
  return id;
}
const PRICES = { d1: 9000, d2: 5000, d3: 15000 };
const deps = (db, o = {}) => ({ db, nowMs: NOW, keyOf: P.repeatKeyer(process.env.OTP_SALT), priceOf: (id) => PRICES[id] ?? null, runId: 'run1', ...o });
const orderReads = (db, from = 0) => db.reads.slice(from).filter((r) => /^orders(\/|$)/.test(r.path));

(async () => {
  // ── 1. the real pipeline: yesterday's fulfilled orders + countable ratings → public_stats ──
  {
    const db = fakeDb();
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push(await served(db, { at: Y0 + 3600e3 * (1 + (i % 20)), dish: i < 20 ? { d1: 2, d2: 1 } : { d1: 1 }, uid: i < 12 ? `u_${String(i).padStart(24, 'a')}` : null }));
    await served(db, { at: NOW - 3600e3, dish: { d3: 1 } });                     // TODAY: never closed by this run
    await served(db, { at: Y0 + 3600e3, status: 'cancelled', dish: { d3: 1 } });   // not fulfilled: never indexed, never counted
    for (let i = 0; i < 12; i++) {
      const r = await rateOrderCore(db, { body: { order_id: ids[i], store: i < 10 ? 5 : 1 }, idToken: `tok-u_${String(i).padStart(24, 'a')}`, now: Y0 + 22 * 3600e3, verifyIdToken });
      assert.strictEqual(r.httpStatus, 200, JSON.stringify(r.body));
    }
    await rateOrderCore(db, { body: { order_id: ids[11], action: 'withdraw' }, idToken: `tok-u_${String(11).padStart(24, 'a')}`, now: Y0 + 23 * 3600e3, verifyIdToken });   // withdrawn
    db.set(`deleted_uids/u_${String(10).padStart(24, 'a')}`, 5);                  // owner tombstoned
    const out = await P.aggregateRestaurant(deps(db), R).catch((e) => assert.fail(`🔴 the producer threw on real data: ${e.message}`));
    assert.deepStrictEqual(out.closed, [YDAY], 'the first run closes YESTERDAY only (counts begin at deploy)');
    const doc = db.get(`public_stats/${R}`);
    assert.strictEqual(doc.rating_count, 10, '🔴 only countable ratings (withdrawn + tombstoned-owner excluded)'); assert.strictEqual(doc.rating_avg, 5);
    assert.deepStrictEqual(doc.dish_stats.d1, { orders_30d: 25, top_rank: 1, pairs: [{ dishId: 'd2', count: 20 }] });
    assert.deepStrictEqual(doc.dish_stats.d2, { orders_30d: 20, top_rank: 2, pairs: [{ dishId: 'd1', count: 20 }] });
    assert.ok(!doc.dish_stats.d3, '🔴 today\'s and cancelled orders never counted');
    assert.strictEqual(doc.first_served_at, Y0 + 3600e3, 'first_served_at = the earliest fulfilment closed');
    assert.ok(!('new_until' in doc), 'rating_count 10 ⇒ not «Nuevo»');
    assert.strictEqual(db.get(`stats_agg/${R}/watermark`), YDAY);
  }
  ok('the real pipeline: intake → fulfilment stamp (rating_index) → rateOrderCore → the producer: yesterday closed, today / cancelled excluded, only countable ratings, dish orders / ranks / pairs, first_served_at, the watermark');

  // ── 2. COST: a run reads only the closed day's orders (4 leaves each); never history, never the orders root; a second run reads none ──
  {
    const db = fakeDb();
    for (let i = 0; i < 300; i++) await served(db, { at: P.dayRange('2027-02-01')[0] + i * 1000 });   // 300 orders of HISTORY
    db.set(`stats_agg/${R}/watermark`, '2027-03-08');
    for (let i = 0; i < 7; i++) await served(db, { at: Y0 + 3600e3 + i });
    const mark = db.reads.length;
    await P.aggregateRestaurant(deps(db), R);
    const ors = orderReads(db, mark);
    assert.strictEqual(ors.length, 7 * 4, `🔴 exactly 4 leaf reads × 7 closed-day orders (got ${ors.length})`);
    assert.ok(ors.every((r) => r.kind === 'get' && /^orders\/XPZ-\d+\/(restaurant_id|status|customer_phone|dish_qty)$/.test(r.path)), '🔴 leaf reads only — never an order node, never the orders root');
    const q = db.reads.slice(mark).filter((r) => r.kind === 'query' && r.path === `rating_index/${R}` && r.ge);
    assert.strictEqual(q.length, 1, 'ONE key-range query for the one closed day'); assert.strictEqual(q[0].first, P.DAY_BUDGET + 1);
    const m2 = db.reads.length;
    await P.aggregateRestaurant(deps(db, { runId: 'run2' }), R);
    assert.strictEqual(orderReads(db, m2).length, 0, '🔴 a second run the same day reads ZERO orders (the watermark)');
  }
  ok('cost: a run reads only the closed day\'s orders (4 leaf reads each, one key-range query per day) — 300 orders of history never touched; a re-run the same day reads none');

  // ── 3. idempotent: a crash after the bucket write but before the watermark ⇒ the re-run REPLACES the day (no double count) ──
  {
    const db = fakeDb();
    for (let i = 0; i < 20; i++) await served(db, { at: Y0 + 3600e3 + i, dish: { d1: 1 } });
    const wset = db.ref; let fail = true;
    db.ref = (p) => { const r = wset(p); if (p === `stats_agg/${R}/watermark` && fail) return { ...r, set: async () => { fail = false; throw new Error('crash'); } }; return r; };
    await assert.rejects(() => P.aggregateRestaurant(deps(db), R), /crash/);
    db.ref = wset;
    assert.strictEqual(db.get(`stats_agg/${R}/lease`), undefined, 'the lease is released on failure');
    await P.aggregateRestaurant(deps(db, { runId: 'run2' }), R);
    assert.strictEqual(db.get(`stats_buckets/${R}/${YDAY}`).dish.d1, 20, '🔴 the day is REPLACED, never added twice');
    assert.strictEqual(db.get(`public_stats/${R}`).dish_stats.d1.orders_30d, 20);
  }
  ok('idempotent: a crash between the bucket and the watermark ⇒ the re-run rebuilds the same day whole (20, not 40); the lease is released on failure');

  // ── 4. repeat customers: PSEUDONYMOUS keys only (HMAC under the HKDF(OTP_SALT) key), across days; 25 ⇒ published ──
  {
    const db = fakeDb();
    db.set(`stats_agg/${R}/watermark`, '2027-03-07');
    for (let i = 0; i < 25; i++) {
      await served(db, { at: P.dayRange('2027-03-08')[0] + 3600e3 + i, phone: `+504 9${String(i).padStart(7, '0')}` });
      await served(db, { at: Y0 + 3600e3 + i, phone: `5049${String(i).padStart(7, '0')}` });
    }
    await P.aggregateRestaurant(deps(db), R);
    const b = JSON.stringify(db.get(`stats_buckets/${R}`));
    assert.ok(!/9\d{7}|5049|\+504/.test(b), '🔴 no phone digits stored — keyed hashes only');
    assert.strictEqual(Object.keys(db.get(`stats_buckets/${R}/${YDAY}`).cust).length, 25);
    assert.strictEqual(db.get(`public_stats/${R}`).repeatCustomers, 25, 'the same phone, differently formatted on two days, is ONE repeat customer');
    const other = P.repeatKeyer('another-salt-'.padEnd(40, 'z'));
    assert.notStrictEqual(other('50490000000'), P.repeatKeyer(process.env.OTP_SALT)('50490000000'), 'the key depends on the secret (not a bare hash of the digits)');
    assert.throws(() => P.repeatKeyer('short'), /OTP_SALT unavailable/, 'no secret ⇒ refuse (never a raw-digit fallback)');
  }
  ok('repeat customers: HMAC keys under HKDF(OTP_SALT, stats-repeat/v1) — no digits stored, secret-dependent, refused without the secret; two days union to 25 repeaters');

  // ── 5. expiry: buckets older than 90 days are deleted with their keys; the 90th day is kept ──
  {
    const db = fakeDb();
    db.set(`stats_agg/${R}/watermark`, YDAY);
    const old = hnDateISO(NOW - 91 * DAY), edge = hnDateISO(NOW - 90 * DAY);
    db.set(`stats_buckets/${R}/${old}`, { v: 1, orders: 1, dish: {}, pairs: {}, cust: { k: 1 } });
    db.set(`stats_buckets/${R}/${edge}`, { v: 1, orders: 1, dish: {}, pairs: {}, cust: { k: 1 } });
    db.set(`public_stats/${R}`, { forged: true, v: 1 });
    await P.aggregateRestaurant(deps(db), R);
    assert.ok(!db.get(`stats_buckets/${R}/${old}`), '🔴 the 91-day-old bucket (and its keys) is gone'); assert.ok(db.get(`stats_buckets/${R}/${edge}`), 'day 90 kept');
    assert.ok(!('forged' in db.get(`public_stats/${R}`)), '🔴 WHOLE-doc replace: a stale field vanishes');
  }
  ok('expiry + replace: buckets older than 90 d deleted (pseudonymous keys with them), day 90 kept; public_stats replaced whole');

  // ── 6. the lease, the catch-up cap, the budget abort, one rid never blocks another ──
  {
    const db = fakeDb();
    db.set(`stats_agg/${R}/lease`, { run: 'other', until: NOW + 60000 });
    assert.deepStrictEqual(await P.aggregateRestaurant(deps(db), R), { rid: R, skipped: 'leased' }, 'an overlapping run is skipped');
    db.set(`stats_agg/${R}/lease`, { run: 'other', until: NOW - 1 });            // an expired lease is taken over
    db.set(`stats_agg/${R}/watermark`, '2027-02-01');
    const out = await P.aggregateRestaurant(deps(db), R);
    assert.strictEqual(out.closed.length, P.MAX_CATCHUP_DAYS, 'catch-up is capped per run'); assert.strictEqual(db.get(`stats_agg/${R}/watermark`), out.closed[out.closed.length - 1]);
    const big = fakeDb(); big.set(`stats_agg/${R}/watermark`, '2027-03-08');
    for (let i = 0; i <= P.DAY_BUDGET; i++) big.set(`rating_index/${R}/${V2.indexKey(Y0 + 1000 + i, `XPZ-b${i}`)}`, `XPZ-b${i}`);
    big.set(`public_stats/${R}`, { v: 1, rating_count: 99 });
    await assert.rejects(() => P.aggregateRestaurant(deps(big), R), /aggregate_day_budget_exceeded/, '🔴 over budget ⇒ LOUD abort');
    assert.deepStrictEqual(big.get(`public_stats/${R}`), { v: 1, rating_count: 99 }, 'nothing published on an abort'); assert.strictEqual(big.get(`stats_agg/${R}/watermark`), '2027-03-08');
    const two = fakeDb(); await served(two, { at: Y0 + 3600e3 });
    const rep = await P.runAggregates({ db: two, nowMs: NOW, listRids: async () => ['la_musa', R], salt: process.env.OTP_SALT, priceOfFor: async (rid) => { if (rid === 'la_musa') throw new Error('tables down'); return () => null; } });
    assert.deepStrictEqual(rep.failed.map((f) => f.rid), ['la_musa']); assert.deepStrictEqual(rep.ok.map((o) => o.rid), [R], 'one rid failing never blocks another');
  }
  ok('the lease (overlap skipped, expired taken over), the per-run catch-up cap, a budget overrun aborts LOUDLY with nothing published, and one failing rid never blocks the others');

  // ── 7. prices by canonical id: the guarded tables through the identity map; unusable ⇒ null (no pair suggested) ──
  {
    const { MENU_BY_RESTAURANT } = require(path.join(FN, 'menu-pricing'));
    const keys = Object.keys(MENU_BY_RESTAURANT.x_pizza);
    const ctx = { usableAsIdentity: true, objects: keys.map((k, i) => ({ kind: 'dish', legacyKey: k, canonicalId: `cid${i}` })) };
    const pf = P.priceOfFromTables({ restaurantId: R, menu: MENU_BY_RESTAURANT.x_pizza }, ctx);
    assert.strictEqual(pf('cid0'), MENU_BY_RESTAURANT.x_pizza[keys[0]] * 100); assert.strictEqual(pf('nope'), null);
    assert.strictEqual(P.priceOfFromTables({ menu: MENU_BY_RESTAURANT.x_pizza }, { usableAsIdentity: false })('cid0'), null, 'unusable context ⇒ null');
    assert.strictEqual(P.priceOfFromTables(null, ctx)('cid0'), null, 'no tables ⇒ null');
  }
  ok('prices by canonical id: the guarded tables through the identity map (cents); an unusable context or no tables ⇒ null, never a guess');

  FINISHED = true;
  console.log(`aggregate-producer: OK (${n})`);
})().catch((e) => { process.stderr.write(`aggregate-producer: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
