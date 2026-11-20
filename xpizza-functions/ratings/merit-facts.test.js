'use strict';
// PLAN-3a-merit-A r0 (advisor APPROVED 2026-11-13) — the merit DAY FACTS in the ratings day close, over the REAL writers:
//   · orders: intake (buildCreateOrderUpdates / buildScheduledOrderRecord) + the fulfilment stamp (rating_index, the fulfilled-order log);
//   · order_timelines: index.js's OWN logOrderLifecycle handler, lifted and run on each status write (first-entry stamps);
//   · scheduled orders: the REAL release (scheduled-release-core.releaseOne) for cash, and the REAL confirm (pixelpay-confirm
//     .confirmAndMaterialize) then release for online — pinning the premise that new_at IS the release time (Q1);
//   · ratings: rateOrderCore → readCountable (the producer's own walk).
// Shapes (the 5f contract): stats_buckets/{rid}/{day}.merit = { accept_s: [sorted ints] (absent when empty — RTDB stores no empty
// array), accept_invalid: int }; stats_agg/{rid}/merit_ratings = { sum, count, as_of } (server-only, unthresholded).
// Run: node ratings/merit-facts.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'merit-facts-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const FN = path.join(__dirname, '..');
const AG = require('./aggregate');
const P = require('./aggregate-producer');
const { rateOrderCore } = require('./rate-order');
const { stampRatingFulfilment } = require('./rating-fulfilment');
const { buildCreateOrderUpdates, buildScheduledOrderRecord, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));
const LC = require(path.join(FN, 'order-lifecycle'));
const REL = require(path.join(FN, 'scheduled-release-core'));
const { confirmAndMaterialize } = require(path.join(FN, 'pixelpay-confirm'));
const { buildMaterializeUpdates } = require(path.join(FN, 'materialize'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 merit-facts: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let pushSeq = 0;
function fakeDb() {
  const tree = {}; const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v, rows) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)),
    forEach: (cb) => { for (const [k, x] of (rows || Object.entries(v || {}))) if (cb({ key: k, val: () => clone(x) }) === true) return true; return false; } });
  const ref = (p = '') => ({
    push: async (v) => { reads.push({ kind: "push", path: p }); set(`${p}/p${String(++pushSeq).padStart(6, "0")}`, prune(v)); },
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

// index.js's OWN logOrderLifecycle handler (the order_timelines first-entry writer), lifted and run against the fake db at CLOCK
const IDX = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const LC_AT = IDX.indexOf('exports.logOrderLifecycle = onValueWritten(');
const H_AT = IDX.indexOf('async (event) => {', LC_AT);
const H_END = IDX.indexOf('\n  }\n);', H_AT);
assert.ok(LC_AT > 0 && H_AT > LC_AT && H_END > H_AT, 'premise: index.js defines logOrderLifecycle\'s handler');
let CLOCK = 0;
const lifecycleHandler = (db) => vm.runInNewContext(`(${IDX.slice(H_AT, H_END + 4)})`, {
  getDatabase: () => db, ServerValue: { get TIMESTAMP() { return CLOCK; } }, console: { error: (...a) => { throw new Error(`logOrderLifecycle failed: ${a.join(' ')}`); } },
  countKitchenLoadAhead: LC.countKitchenLoadAhead, countDriverSupply: LC.countDriverSupply, buildLifecycleEvent: LC.buildLifecycleEvent, timelineStampKey: LC.timelineStampKey,
});
// the status write + its trigger at time `at` (before = the stored status)
async function status(db, id, to, at) {
  const before = db.get(`orders/${id}/status`) ?? null;
  db.set(`orders/${id}/status`, to);
  CLOCK = at; await lifecycleHandler(db)({ data: { before: { val: () => before }, after: { val: () => to } }, params: { orderId: id } });
}
// a write that already happened (a real writer changed the status): fire the trigger for before → the stored status
async function fired(db, id, before, at) {
  CLOCK = at; const to = db.get(`orders/${id}/status`);
  await lifecycleHandler(db)({ data: { before: { val: () => before }, after: { val: () => to } }, params: { orderId: id } });
}

const NOW = P.dayRange('2027-03-10')[0] + 4.5 * 3600e3;
const YDAY = '2027-03-09'; const Y0 = P.dayRange(YDAY)[0];
const R = 'x_pizza';
const MIN = 60e3;
const OPEN = { open: true, start: '00:00', end: '23:59' };
const HOURS = { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN };
let seq = 0;
const intake = (id, at, rid, extra = {}) => ({ orderId: id, orderType: 'pickup', now: at, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
  fields: { customer_name: 'Ana', customer_phone: `5049${String(1000000 + seq).slice(-7)}`, items_text: '1x', notes: '', payment_method: 'cash' },
  hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' }, restaurantId: rid,
  priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000, ...extra });
// an order through the real intake + lifecycle: `steps` = [[status, ms after created]…]; ending fulfilled ⇒ the real fulfilment stamp
async function order(db, { created, steps, rid = R, uid = null }) {
  const id = `XPZ-${String(++seq).padStart(5, '0')}`;
  const u = buildCreateOrderUpdates(intake(id, created, rid));
  if (uid) attachCustomerAttribution(u, id, uid, { now: created, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: [{ name: 'X', qty: 1 }] });   // the rating owner (real intake attribution)
  const first = u[`orders/${id}`].status; delete u[`orders/${id}`].status;
  await db.ref().update(u);
  await status(db, id, first, created);
  let end = created;
  for (const [s, dt] of steps) { end = created + dt; await status(db, id, s, end); }
  const last = db.get(`orders/${id}/status`);
  if (last === 'delivered' || last === 'completed') await stampRatingFulfilment(db, { orderId: id, status: last, eventTime: end });
  return id;
}
const deps = (db, o = {}) => ({ db, nowMs: NOW, keyOf: P.repeatKeyer(process.env.OTP_SALT), priceOf: () => null, runId: 'run1', ...o });
const H = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
// publish(cell 6's fixture) computed at asm9b 07a26c194, BEFORE the storeStars extraction:
// {"v":1,"rating_avg":2.9,"rating_count":37,"rating_count_30d":31,"first_served_at":1804572000000,"dish_stats":{"d1":{"up":19,"down":21,"votes":40}}}
const PUBLISH_GOLDEN = 'f3412cf7713d3f555d5d9e67d78d905c839f3246324efb420111dc6e39b40b24';

(async () => {
  // ── 1. the day's accept facts over real orders: exact sorted seconds, invalid COUNTED, other rid / cancelled / today never counted ──
  {
    const db = fakeDb();
    const T = (h) => Y0 + h * 3600e3;
    await order(db, { created: T(10), steps: [['preparing', 3 * MIN], ['ready', 15 * MIN], ['completed', 20 * MIN]] });            // 180 s
    await order(db, { created: T(11), steps: [['preparing', 45e3], ['ready', 9 * MIN], ['completed', 12 * MIN]] });                // 45 s
    await order(db, { created: T(12), steps: [['preparing', 12 * MIN + 30e3], ['out_for_delivery', 30 * MIN], ['delivered', 50 * MIN]] });   // 750 s
    await order(db, { created: T(13), steps: [['ready', 10 * MIN], ['completed', 14 * MIN]] });                                    // no preparing ⇒ invalid
    await order(db, { created: T(14), steps: [['preparing', 2 * MIN], ['completed', 5 * MIN]], rid: 'la_musa' });                  // another rid
    await order(db, { created: T(15), steps: [['preparing', 1 * MIN], ['cancelled', 2 * MIN]] });                                   // cancelled: never indexed
    await order(db, { created: NOW - 3600e3, steps: [['preparing', MIN], ['completed', 3 * MIN]] });                                // TODAY
    await P.aggregateRestaurant(deps(db), R);
    const b = db.get(`stats_buckets/${R}/${YDAY}`);
    assert.deepStrictEqual(b.merit, { accept_s: [45, 180, 750], accept_invalid: 1 }, '🔴 the day\'s accept facts: exact seconds, sorted; a missing preparing_at COUNTED as invalid');
    assert.strictEqual(b.orders, 4, 'premise: the bucket counts the same 4 fulfilled x_pizza orders');
  }
  ok('the day close over real orders (intake → logOrderLifecycle stamps → fulfilment): merit.accept_s exact + sorted, a missing preparing_at counted in accept_invalid, other rid / cancelled / today not counted');

  // ── 2. the boundary: 0 s and 24 h kept; a negative gap and > 24 h invalid; an empty day still carries merit ──
  {
    assert.deepStrictEqual(AG.meritDay(R, [
      { restaurant_id: R, status: 'delivered', new_at: 1000, preparing_at: 1000 },
      { restaurant_id: R, status: 'completed', new_at: 1000, preparing_at: 1000 + 86400e3 },
      { restaurant_id: R, status: 'delivered', new_at: 5000, preparing_at: 4000 },
      { restaurant_id: R, status: 'delivered', new_at: 1000, preparing_at: 1000 + 86401e3 },
      { restaurant_id: R, status: 'delivered', new_at: null, preparing_at: 9000 },
      { restaurant_id: R, status: 'delivered', new_at: '1000', preparing_at: 9000 },
    ]), { accept_s: [0, 86400], accept_invalid: 4 }, '🔴 0 ≤ s ≤ 24 h kept; negative, > 24 h, missing and non-number stamps COUNTED invalid');
    assert.deepStrictEqual(AG.meritDay(R, [
      { restaurant_id: 'la_musa', status: 'delivered', new_at: 1000, preparing_at: 61000 },
      { restaurant_id: R, status: 'cancelled', new_at: 1000, preparing_at: 61000 },
      { restaurant_id: R, status: 'completed', new_at: 1000, preparing_at: 31000 },
    ]), { accept_s: [30], accept_invalid: 0 }, '🔴 the counted set is bucketFromOrders\' own: another rid or an unfulfilled order is neither an accept nor invalid');
    assert.strictEqual(AG.meritDay(R, [{ restaurant_id: R, status: 'delivered', new_at: 0, preparing_at: 1499 }]).accept_s[0], 1, 'rounded to the second');
    const db = fakeDb();
    await P.aggregateRestaurant(deps(db), R);
    assert.deepStrictEqual(db.get(`stats_buckets/${R}/${YDAY}`).merit, { accept_invalid: 0 }, '🔴 a closed EMPTY day still carries merit (accept_s absent = empty: RTDB stores no empty array)');
  }
  ok('boundaries: 0 s and exactly 24 h kept; a negative gap, > 24 h, a missing or non-number stamp counted invalid; seconds rounded; a closed empty day carries merit { accept_invalid: 0 }');

  // ── 3. Q1 PREMISE PIN: a SCHEDULED order's new_at IS its release time (cash: hold → release; online: confirm → hold → release) ──
  {
    for (const pay of ['cash', 'online']) {
      const db = fakeDb(); db.set(`restaurants/${R}/identity`, { hours: HOURS, active: true });
      const id = `XPZ-S${pay}`; const created = Y0 + 8 * 3600e3, rel = Y0 + 12 * 3600e3;
      const rec = buildScheduledOrderRecord({ ...intake(id, created, R, pay === 'online' ? { fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text: '1x', notes: '', payment_method: 'online' } } : {}),
        scheduledFor: rel + 30 * MIN, releaseAt: rel - 1 })[`orders/${id}`];
      if (pay === 'online') Object.assign(rec, { status: 'pending_payment', payment_status: 'pending' });   // the hosted pending record (pay first, then hold)
      const st0 = rec.status; delete rec.status; db.set(`orders/${id}`, rec);
      await status(db, id, st0, created);
      if (pay === 'online') {
        const c = await confirmAndMaterialize({ db, buildMaterializeUpdates, getIdentity: async () => ({ hours: HOURS }), restaurant: { lat: 1, lng: 1, name: 'R', phone: '+504' } },
          { orderId: id, attemptId: null, now: created + MIN, trackingToken: 'tkon' });
        assert.strictEqual(c.outcome, 'scheduled_held', `premise: the real confirm HELD the paid scheduled order (${JSON.stringify(c)})`);
        await fired(db, id, 'pending_payment', created + MIN);
      }
      assert.strictEqual(db.get(`orders/${id}/status`), 'scheduled', `premise ${pay}: held as scheduled`);
      assert.strictEqual(db.get(`order_timelines/${id}/new_at`), undefined, `🔴 ${pay}: a held scheduled order has NO new_at before its release`);
      const r = await REL.releaseOne({ db, alert: async () => {}, genToken: () => 'TOK', restaurantFallback: { lat: 1, lng: 2, name: 'R', phone: '+504' } }, { orderId: id, now: rel, claimId: 'c1' });
      assert.strictEqual(r.released, true, `premise ${pay}: the real release (${JSON.stringify(r)})`);
      await fired(db, id, 'scheduled', rel); await fired(db, id, 'releasing', rel);   // the two writes the release made: claim (releasing) then materialize (new)
      const o = db.get(`orders/${id}`);
      assert.strictEqual(o.status, 'new', 'released live');
      assert.strictEqual(db.get(`order_timelines/${id}/new_at`), rel, `🔴 ${pay}: new_at IS the release time`);
      assert.strictEqual(o.materialized_at, rel, `🔴 ${pay}: … and equals materialized_at (so no separate read is needed — Q1)`);
      assert.ok(created < rel && db.get(`order_timelines/${id}/new_at`) !== created, `${pay}: never the creation time`);
      await status(db, id, 'preparing', rel + 2 * MIN); await status(db, id, 'completed', rel + 9 * MIN);
      await stampRatingFulfilment(db, { orderId: id, status: 'completed', eventTime: rel + 9 * MIN });
      await P.aggregateRestaurant(deps(db), R);
      assert.deepStrictEqual(db.get(`stats_buckets/${R}/${YDAY}`).merit, { accept_s: [120], accept_invalid: 0 }, `🔴 ${pay}: accept measured from the RELEASE (120 s), never from creation`);
    }
  }
  ok('Q1 premise pinned: a scheduled order (cash: hold → real release; online: real confirm → hold → real release) has NO new_at until released, then new_at = release = materialized_at; accept is measured from the release');

  // ── 3b. COST: exactly +2 timeline LEAF reads per closed-day order; the order leaves unchanged (4 each); a re-run reads none ──
  {
    const db = fakeDb();
    for (let i = 0; i < 4; i++) await order(db, { created: Y0 + 3600e3 * (1 + i), steps: [['preparing', MIN], ['completed', 5 * MIN]] });
    const mark = db.reads.length;
    await P.aggregateRestaurant(deps(db), R);
    const tl = db.reads.slice(mark).filter((r) => /^order_timelines\//.test(r.path));
    assert.strictEqual(tl.length, 2 * 4, `🔴 exactly 2 timeline leaf reads per closed-day order (got ${tl.length})`);
    assert.ok(tl.every((r) => r.kind === 'get' && /^order_timelines\/XPZ-\d+\/(new_at|preparing_at)$/.test(r.path)), '🔴 leaf reads only (new_at, preparing_at) — never a timeline node, never the root');
    assert.strictEqual(db.reads.slice(mark).filter((r) => /^orders\//.test(r.path)).length, 4 * 4, 'the order leaves are unchanged (4 each)');
    const m2 = db.reads.length;
    await P.aggregateRestaurant(deps(db, { runId: 'run2' }), R);
    assert.strictEqual(db.reads.slice(m2).filter((r) => /^order_timelines\//.test(r.path)).length, 0, 'a re-run the same day reads no timeline (the watermark)');
  }
  ok('cost: exactly +2 timeline LEAF reads (new_at, preparing_at) per closed-day order — never a node or the root; the 4 order leaves unchanged; a same-day re-run reads none');

  // ── 4. idempotent: re-closing a day rebuilds merit whole (never appended) ──
  {
    const db = fakeDb();
    await order(db, { created: Y0 + 3600e3, steps: [['preparing', 90e3], ['completed', 5 * MIN]] });
    const wset = db.ref; let fail = true;
    db.ref = (p) => { const r = wset(p); if (p === `stats_agg/${R}/watermark` && fail) return { ...r, set: async () => { fail = false; throw new Error('crash'); } }; return r; };
    await assert.rejects(() => P.aggregateRestaurant(deps(db), R), /crash/);
    db.ref = wset;
    await P.aggregateRestaurant(deps(db, { runId: 'run2' }), R);
    assert.deepStrictEqual(db.get(`stats_buckets/${R}/${YDAY}`).merit, { accept_s: [90], accept_invalid: 0 }, '🔴 a re-close REPLACES merit (90 once, never twice)');
  }
  ok('idempotent: a crash between the bucket and the watermark ⇒ the re-run rebuilds the day\'s merit whole ([90], not [90, 90])');

  // ── 5. merit_ratings: server-only, UNTHRESHOLDED; public_stats still applies its ≥ 10 rule ──
  {
    const db = fakeDb();
    const verifyIdToken = async (t) => ({ uid: t.slice(4), customer: true });
    const uidOf = (i) => `u_${String(i).padStart(24, 'a')}`;
    const ids = [];
    for (let i = 0; i < 9; i++) ids.push(await order(db, { created: Y0 + 3600e3 + i, steps: [['preparing', MIN], ['completed', 4 * MIN]], uid: uidOf(i) }));
    for (let i = 0; i < 9; i++) {
      const r = await rateOrderCore(db, { body: { order_id: ids[i], store: i < 6 ? 5 : 3 }, idToken: `tok-${uidOf(i)}`, now: Y0 + 22 * 3600e3, verifyIdToken });
      assert.strictEqual(r.httpStatus, 200, JSON.stringify(r.body));
    }
    await P.aggregateRestaurant(deps(db), R);
    assert.deepStrictEqual(db.get(`stats_agg/${R}/merit_ratings`), { sum: 6 * 5 + 3 * 3, count: 9, as_of: NOW }, '🔴 merit_ratings is UNTHRESHOLDED: 9 ratings ⇒ { sum 39, count 9, as_of }');
    assert.ok(!('rating_avg' in db.get(`public_stats/${R}`)) && !('rating_count' in db.get(`public_stats/${R}`)), '🔴 public_stats keeps its ≥ 10 rule (9 ⇒ no rating published)');
    assert.ok(!JSON.stringify(db.get(`public_stats/${R}`)).includes('merit'), 'nothing merit is published');
    const empty = fakeDb(); await P.aggregateRestaurant(deps(empty), R);
    assert.deepStrictEqual(empty.get(`stats_agg/${R}/merit_ratings`), { sum: 0, count: 0, as_of: NOW }, 'no ratings ⇒ { 0, 0, as_of } (written, so 5f sees a fresh as_of)');
  }
  ok('merit_ratings: stats_agg/{rid}/merit_ratings = { sum, count, as_of } over the countable ratings, UNTHRESHOLDED (9 ⇒ 39 / 9) while public_stats keeps its ≥ 10 rule; nothing merit published; no ratings ⇒ { 0, 0, as_of }');

  // ── 6. storeStars is publish's OWN rating math: publish byte-equal (golden), and the same numbers ──
  {
    const rating = (i, o = {}) => ({ state: 'live', restaurant_id: R, store: 1 + (i % 5), rated_at: NOW - (i % 40) * AG.DAY_MS, ...(i % 3 === 0 ? { legacy_thumb: i % 2 ? 1 : -1 } : {}), dishes: { d1: i % 2 ? 1 : -1 }, ...o });
    const ratings = [...Array.from({ length: 37 }, (_, i) => rating(i)), rating(99, { restaurant_id: 'la_musa' }), rating(98, { store: 0 }), rating(97, { store: 6 }), rating(96, { store: 4.5 })];
    const buckets = { [YDAY]: AG.bucketFromOrders(R, [{ restaurant_id: R, status: 'delivered', dish_qty: { d1: 1 } }], () => null) };
    const doc = AG.publish({ rid: R, nowMs: NOW, buckets, ratings, priceOf: () => null, firstServedAt: Y0 });
    assert.strictEqual(H(doc), PUBLISH_GOLDEN, `🔴 publish is byte-equal to its pre-extraction output (got ${H(doc)})`);
    const s = AG.storeStars(R, ratings, NOW);
    assert.deepStrictEqual([s.count, Math.round((s.sum / s.count) * 10) / 10, s.count30], [doc.rating_count, doc.rating_avg, doc.rating_count_30d], '🔴 storeStars = publish\'s own rating_count / rating_avg / rating_count_30d');
    assert.throws(() => AG.storeStars(R, [{ state: 'withdrawn', restaurant_id: R, store: 5 }], NOW), /non-countable/, 'a non-countable rating is refused (readCountable upstream)');
  }
  ok('storeStars is publish\'s own rating math: publish byte-equal to its pre-extraction golden; the same count / avg / 30-day count; a non-countable input refused');

  // ── 7. the carry onto main (PLAN-3a-s4-carry-r0, advisor GO 11-19): the merit_ratings write and the Anuncio's hidden-day recorder
  //       share the producer's tail — each runs in its OWN try, so either failing leaves the other intact and the run still completes.
  //       The world is the Anuncio's (test/_anuncio-world: the REAL roster, config, ratings pipeline and producer; a REAL booking). ──
  {
    const AW = require('../test/_anuncio-world');
    const AC = require('../marketing/anuncio-core');
    const BOOK_AT = AW.at('2027-03-03', 12); const RUN_AT = AW.at('2027-03-10', 4.5); const WK = 'W2027-03-08';
    const booked = async () => {
      const db = await AW.world(); await AW.eligible(db, 'tb_centro');
      const b = (await AC.anuncioBookCore(AW.depsAt(db, BOOK_AT), AW.req(`t-${AW.OWNER}`, { rid: 'tb_centro', week: WK }))).body.booking;
      assert.ok(b && b.id, 'premise: the REAL booking writer booked the week');
      return { db, id: b.id };
    };
    const failing = (db, test) => { const real = db.ref; db.ref = (p) => { const r = real(p); if (!test(String(p))) return r; const boom = async () => { throw new Error('down'); }; return { ...r, set: boom, update: boom, once: boom, get: boom, transaction: boom }; }; };
    const runQuiet = async (db) => { const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(' ')); try { return { out: await AW.produce(db, 'tb_centro', RUN_AT), errs }; } finally { console.error = ce; } };

    const base = await booked(); const ok0 = await runQuiet(base.db);
    const days0 = base.db.get(`anuncio_bookings/tb_centro/${base.id}/days`); const merit0 = base.db.get('stats_agg/tb_centro/merit_ratings');
    assert.deepStrictEqual(days0, { '2027-03-08': { state: 'shown' } }, 'premise: a healthy run records the booked day');
    assert.ok(merit0 && merit0.count >= 10 && merit0.as_of === RUN_AT, 'premise: a healthy run writes merit_ratings');
    assert.strictEqual(ok0.out.anuncio_days, 1, 'premise: the run reports one recorded day');

    const a = await booked(); failing(a.db, (p) => p.startsWith('anuncio_slots/'));
    const ar = await runQuiet(a.db).catch((e) => assert.fail(`🔴 ANUNCIO-MERIT-ISOLATION: an Anuncio failure must not fail the run (${e.message})`));
    assert.deepStrictEqual(a.db.get('stats_agg/tb_centro/merit_ratings'), merit0, '🔴 ANUNCIO-MERIT-ISOLATION: an Anuncio failure still writes merit_ratings');
    assert.strictEqual(a.db.get(`anuncio_bookings/tb_centro/${a.id}/days`) ?? null, null, 'premise: the Anuncio step really failed (no day recorded)');
    assert.ok(ar.errs.some((l) => /^anuncio days tb_centro /.test(l)), 'the Anuncio failure is logged');

    const m = await booked(); failing(m.db, (p) => p === 'stats_agg/tb_centro/merit_ratings');
    const mr = await runQuiet(m.db).catch((e) => assert.fail(`🔴 MERIT-ANUNCIO-ISOLATION: a merit_ratings failure must not fail the run (${e.message})`));
    assert.deepStrictEqual(m.db.get(`anuncio_bookings/tb_centro/${m.id}/days`), days0, '🔴 MERIT-ANUNCIO-ISOLATION: a merit_ratings failure still records the Anuncio day');
    assert.strictEqual(mr.out.anuncio_days, 1, 'the run still reports the recorded day');
    assert.deepStrictEqual(m.db.get('public_stats/tb_centro'), base.db.get('public_stats/tb_centro'), 'public_stats byte-identical to the healthy run');
    assert.ok(mr.errs.some((l) => /^merit ratings tb_centro /.test(l)), 'the merit failure is logged (rid only)');
  }
  ok('merit_ratings and the Anuncio hidden-day recorder each run in their own try: either failing leaves the other intact, public_stats unchanged, the run completes and logs it');

  FINISHED = true;
  console.log(`\nmerit-facts: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\nmerit-facts: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
