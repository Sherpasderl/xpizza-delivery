'use strict';
// Merchant STATS — publication + job + API against REAL (emulated) Firestore AND RTDB.
// The properties a fake cannot prove live here: one-transaction coherence (a crash leaves NO partial
// state), the freshness refusal, lease ownership + expiry, overlapping runs completing in reverse order,
// crash recovery, the size preflight aborting before any publish, an interrupted repair resuming, the
// 417-write chunk fitting a real transaction, and the bounded RTDB read (startAfter/endBefore chunks).
// Run: npm run test:stats-emulator
require('./_emulator-required')('firestore', 'database');

const assert = require('assert');
const admin = require('firebase-admin');
const T = require('../stats/stats-time');
const S = require('../stats/stats-store');
const J = require('../stats/stats-job');
const A = require('../stats/stats-api');
const B = require('../stats/stats-build');
const F = require('../stats/stats-fixtures');
const { makeCustomerKeyer } = require('../stats/stats-identity');

const NS = 'demo-xpizza';
admin.initializeApp({ projectId: NS, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}` });
const fsdb = admin.firestore();
const rtdb = admin.database();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const keyer = makeCustomerKeyer('e'.repeat(40));
const NOW = T.dayStartMs('2026-10-20') + 9 * 3600000 + 600000;
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wipe() {
  await rtdb.ref('/').set(null);
  for (const rid of ['r_a', 'r_b', 'r_c']) {
    for (const c of ['stats_daily', 'stats_customers', 'stats_meta']) {
      const s = await fsdb.collection('restaurants').doc(rid).collection(c).get();
      await Promise.all(s.docs.map((d) => d.ref.delete()));
    }
  }
}
async function seed(list) { const u = {}; for (const o of list) u[`orders/${o.order_id}`] = o; await rtdb.ref('/').update(u); }
const daily = async (rid, d) => { const s = await S.dailyRef(fsdb, rid, d).get(); return s.exists ? s.data() : null; };
const snapshotStats = async (rid) => {
  const out = {};
  for (const c of ['stats_daily', 'stats_customers', 'stats_meta']) {
    const s = await fsdb.collection('restaurants').doc(rid).collection(c).get();
    for (const d of s.docs) if (!['lease', 'clock'].includes(d.id)) out[`${c}/${d.id}`] = JSON.stringify(d.data(), (k, v) => (k === 'computed_at' || k === 'published_at' ? 'ts' : v));
  }
  return out;
};
// RTDB spy: records every query's bounds, so read volume is asserted against the real database.
function spy(db) {
  const log = [];
  const wrap = (q, desc) => new Proxy(q, { get(t, p) {
    const v = t[p];
    if (typeof v !== 'function') return v;
    if (p === 'once') return async (...a) => { log.push(desc); return v.apply(t, a); };
    return (...a) => wrap(v.apply(t, a), [...desc, `${String(p)}(${a.join(',')})`]);
  } });
  return { ref: (p) => wrap(db.ref(p), [`ref(${p})`]), _log: log };
}
const deps = (over = {}) => ({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a', 'r_b'], log: () => {}, ...over });

(async () => {
  // 1. A real nightly run: ONE bounded created_at range in non-overlapping chunks; coherent publish.
  {
    await wipe();
    const list = [];
    for (let i = 0; i < 9; i++) list.push(F.cashOrder({ rid: i % 2 ? 'r_a' : 'r_b', pm: 'cash', now: at('2026-10-15', 12, i % 3), phone: '8888000' + i, totalCents: 1000 + i }));
    list.push(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-08-01', 12), phone: '1', totalCents: 5 }));   // outside the window
    await seed(list);
    const r = spy(rtdb);
    const rep = await J.runStatsRollup(deps({ rtdb: r }), { nowMs: NOW, mode: 'nightly', commit: true, budget: { ...J.DEFAULT_BUDGET, chunkSize: 4 } });
    assert.strictEqual(rep.read.records, 9); assert.strictEqual(r._log.length, 3, '9 records / chunk 4 → 3 queries');
    for (const q of r._log) {
      assert(q.includes('orderByChild(created_at)'));
      assert(q.some((s) => s.startsWith(`endBefore(${T.dayEndMs('2026-10-19')}`)));
      assert(q.some((s) => s.startsWith('limitToFirst(4')));
    }
    assert(r._log[1].some((s) => s.startsWith('startAfter(')), 'continuation chunks use startAfter (no overlap)');
    assert.strictEqual((await daily('r_a', '2026-10-15')).sale.orders, 4);
    assert.strictEqual((await daily('r_b', '2026-10-15')).sale.orders, 5);
    assert.strictEqual((await S.readMeta(fsdb, 'r_a')).epoch, 1);
    ok('nightly against real RTDB: one bounded range, 3 non-overlapping chunks, both restaurants published');
  }

  const summariesFor = async (rid, dates) => {
    const { orders } = await J.readOrdersBounded(rtdb, T.dayStartMs(dates[0]) - T.READ_PAD_MS, T.dayEndMs(dates[dates.length - 1]));
    return B.buildDailies(orders, { keyer, restaurants: new Set([rid]), dates: new Set(dates) }).get(rid);
  };

  // 2. FRESHNESS REFUSAL: a run that read OLDER orders cannot overwrite a newer publication.
  {
    const dates = ['2026-10-15'];
    const sums = await summariesFor('r_a', dates);
    const tok = await S.acquireLease(fsdb, 'r_a');
    const tNew = await S.serverNow(fsdb, 'r_a');
    await S.publishChunk(fsdb, 'r_a', { summaries: sums, dates, token: tok, readStartedAt: tNew });
    const before = await snapshotStats('r_a');
    await assert.rejects(() => S.publishChunk(fsdb, 'r_a', { summaries: sums, dates, token: tok, readStartedAt: tNew - 1 }), (e) => e.code === 'stats_stale_read');
    assert.deepStrictEqual(await snapshotStats('r_a'), before, 'nothing changed');
    await S.publishChunk(fsdb, 'r_a', { summaries: sums, dates, token: tok, readStartedAt: tNew });   // equal = same run's next chunk: allowed
    await S.releaseLease(fsdb, 'r_a', tok);
    ok('stale-read publication refused, state untouched; an equal read time (same run) is allowed');
  }

  // 3. A CRASH between decision and commit leaves NO partial state (real transaction).
  {
    const dates = ['2026-10-14', '2026-10-15'];
    const sums = await summariesFor('r_a', dates);
    sums.get('2026-10-15').sale.cents = 999999;                    // a publication that must not land
    const tok = await S.acquireLease(fsdb, 'r_a');
    const before = await snapshotStats('r_a');
    const rs3 = await S.serverNow(fsdb, 'r_a');
    await assert.rejects(() => S.publishChunk(fsdb, 'r_a', { summaries: sums, dates, token: tok, readStartedAt: rs3, _beforeCommit: async () => { throw new Error('crash'); } }), /crash/);
    assert.deepStrictEqual(await snapshotStats('r_a'), before, 'no daily doc, shard or meta changed');
    await S.releaseLease(fsdb, 'r_a', tok);
    ok('crash inside the publication → no partial state (dailies, shards, meta all unchanged)');
  }

  // 4. LEASE: expiry and ownership are both enforced at publish time.
  {
    const dates = ['2026-10-15'];
    const sums = await summariesFor('r_a', dates);
    const t1 = await S.acquireLease(fsdb, 'r_a', 300);
    await sleep(600);
    const rs4 = await S.serverNow(fsdb, 'r_a');
    await assert.rejects(() => S.publishChunk(fsdb, 'r_a', { summaries: sums, dates, token: t1, readStartedAt: rs4 }), (e) => e.code === 'stats_lease_expired');
    const t2 = await S.acquireLease(fsdb, 'r_a');                 // reclaim the expired lease (crash recovery)
    const rs4b = await S.serverNow(fsdb, 'r_a');
    await assert.rejects(() => S.publishChunk(fsdb, 'r_a', { summaries: sums, dates, token: t1, readStartedAt: rs4b }), (e) => e.code === 'stats_lease_lost');
    await assert.rejects(() => S.acquireLease(fsdb, 'r_a'), (e) => e.code === 'stats_locked');
    await S.releaseLease(fsdb, 'r_a', t2);
    ok('expired lease refused; reclaimed lease makes the old token LOST; a live lease blocks a second run');
  }

  // 5. OVERLAPPING RUNS completing in REVERSE order publish the NEWER generation; a crashed run that
  //    never released is recovered after expiry.
  {
    await wipe();
    const o = F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-15', 12), phone: '88880001', totalCents: 5000 });
    await seed([o]);
    const dates = ['2026-10-15'];
    // Run A: lease (short), read the OLD state.
    const tA = await S.acquireLease(fsdb, 'r_a', 400);
    const readA = await S.serverNow(fsdb, 'r_a');
    const sumsA = await summariesFor('r_a', dates);
    // The order is refunded; A's lease lapses (A stalls); run B starts, reads NEW state, publishes FIRST.
    await rtdb.ref(`orders/${o.order_id}`).update({ status: 'cancelled' });
    await sleep(700);
    const tB = await S.acquireLease(fsdb, 'r_a');
    const readB = await S.serverNow(fsdb, 'r_a');
    const sumsB = await summariesFor('r_a', dates);
    await S.publishChunk(fsdb, 'r_a', { summaries: sumsB, dates, token: tB, readStartedAt: readB });
    await S.releaseLease(fsdb, 'r_a', tB);
    // A completes LAST — with a token it no longer owns. Even re-acquiring a lease, its OLD read is refused.
    await assert.rejects(() => S.publishChunk(fsdb, 'r_a', { summaries: sumsA, dates, token: tA, readStartedAt: readA }), (e) => ['stats_lease_lost', 'stats_lease_expired'].includes(e.code));
    const tA2 = await S.acquireLease(fsdb, 'r_a');
    await assert.rejects(() => S.publishChunk(fsdb, 'r_a', { summaries: sumsA, dates, token: tA2, readStartedAt: readA }), (e) => e.code === 'stats_stale_read');
    await S.releaseLease(fsdb, 'r_a', tA2);
    const d = await daily('r_a', '2026-10-15');
    assert.strictEqual(d.sale.orders, 0); assert.deepStrictEqual(d.cancelled, { orders: 1, cents: 5000 });
    assert.strictEqual((await S.readMeta(fsdb, 'r_a')).epoch, 1, 'only B published');
    // crash recovery: a run that died holding the lease is reclaimed after expiry by the next run
    await S.acquireLease(fsdb, 'r_a', 300);   // never released
    await sleep(600);
    const rep = await J.runStatsRollup(deps({ listRestaurants: async () => ['r_a'] }), { nowMs: NOW, mode: 'nightly', commit: true });
    assert(rep.restaurants.r_a.epochs.length === 1);
    ok('overlapping runs in reverse completion order → the newer read wins; a dead lease is reclaimed');
  }

  // 6. SIZE PREFLIGHT aborts BEFORE publishing (nothing written, not even a new epoch).
  {
    const before = await snapshotStats('r_a');
    await assert.rejects(() => J.runStatsRollup(deps({ listRestaurants: async () => ['r_a'] }), { nowMs: NOW, mode: 'nightly', commit: true, limits: { maxDocBytes: 400, maxWrites: 450, maxCommitBytes: 1e9 } }),
      (e) => e.code === 'stats_rollup_failed' && e.failures[0].code === 'stats_size_preflight_failed' && /SUPPORTED VOLUME/.test(e.failures[0].message));
    assert.deepStrictEqual(await snapshotStats('r_a'), before);
    await assert.rejects(() => J.runStatsRollup(deps({ listRestaurants: async () => ['r_a'] }), { nowMs: NOW, mode: 'nightly', commit: true, limits: { maxDocBytes: 1e6, maxWrites: 10, maxCommitBytes: 1e9 } }), /stats_rollup_failed/);
    assert.deepStrictEqual(await snapshotStats('r_a'), before);
    ok('size preflight (doc bytes, write count) aborts loudly with the numbers; nothing published');
  }

  // 7. A 400-DATE CHUNK (417 writes) fits ONE real transaction; an INTERRUPTED repair RESUMES.
  {
    await wipe();
    await seed([F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2025-09-10', 12), phone: '1', totalCents: 100 }),
      F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-10', 12), phone: '88880002', totalCents: 300 })]);
    const real = S.publishChunk;
    let calls = 0;
    S.publishChunk = async (...a) => { if (++calls === 2) throw Object.assign(new Error('simulated crash'), { code: 'crash' }); return real(...a); };
    try {
      await assert.rejects(() => J.runStatsRollup(deps({ listRestaurants: async () => ['r_a'] }), { nowMs: NOW, mode: 'range', from: '2025-09-01', to: '2026-10-12', commit: true }), /stats_rollup_failed/);
    } finally { S.publishChunk = real; }
    const meta = await S.readMeta(fsdb, 'r_a');
    assert.strictEqual(meta.epoch, 1); assert.strictEqual(meta.last_dates.count, 400, 'a full 400-date chunk committed in one real transaction');
    assert(meta.pending_repair.includes('2026-10-10'));
    assert.strictEqual(await daily('r_a', '2026-10-10'), null);
    await J.runStatsRollup(deps({ listRestaurants: async () => ['r_a'] }), { nowMs: NOW, mode: 'nightly', commit: true });
    assert.strictEqual((await daily('r_a', '2026-10-10')).sale.cents, 300);
    assert.strictEqual((await S.readMeta(fsdb, 'r_a')).pending_repair, null);
    ok('417-write chunk commits in one real transaction; interrupted repair resumes from pending_repair');
  }

  // 8. API end to end on real storage: epoch read, live today, aggregates only.
  {
    await seed([F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-20', 8), phone: '88880002', totalCents: 700 })]);
    const r = await A.getSalesStatsCore({ authorize: async () => ({ ok: true, role: 'owner' }), fsdb, rtdb, getKeyer: () => keyer, nowMs: NOW }, { method: 'GET', query: { restaurantId: 'r_a', from: '2026-10-10', to: '2026-10-20' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.kpis.sales_cents, 1000);
    assert.deepStrictEqual(r.body.customers.new, { customers: 1, orders: 2, cents: 1000 }, '88880002 first bought 10-10, inside the period');
    const r2 = await A.getSalesStatsCore({ authorize: async () => ({ ok: true, role: 'owner' }), fsdb, rtdb, getKeyer: () => keyer, nowMs: NOW }, { method: 'GET', query: { restaurantId: 'r_a', from: '2026-10-11', to: '2026-10-20' } });
    assert.deepStrictEqual(r2.body.customers.returning, { customers: 1, orders: 1, cents: 700 }, 'returning when the period starts after their first Sale');
    assert.strictEqual(r.body.epoch, 2);
    assert(!JSON.stringify(r.body).includes('88880002'));
    ok('API over real storage: stored days + live today + overlay; aggregates only');
  }

  console.log(`\nstats.emulator: ${n} cells passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
