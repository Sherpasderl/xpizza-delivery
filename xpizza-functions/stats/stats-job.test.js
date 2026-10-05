'use strict';
// Merchant STATS — the rollup run (bounded read, partition, publish, dry-run, resume, brand-agnostic).
// Uses the RTDB double (stats-rtdb-fake.js) and catalog/firestore-fake.js. The fake Firestore does NOT
// model transaction isolation/rollback (its own header says so) — the publication properties that depend
// on that (crash = no partial state, stale-read refusal under real contention) are proven in the
// EMULATOR suite, test/stats.emulator.test.js. Run: node stats/stats-job.test.js
const assert = require('assert');
const T = require('./stats-time');
const S = require('./stats-store');
const J = require('./stats-job');
const F = require('./stats-fixtures');
const { makeRtdb } = require('./stats-rtdb-fake');
const { makeDb } = require('../catalog/firestore-fake');
const { makeCustomerKeyer } = require('./stats-identity');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const keyer = makeCustomerKeyer('j'.repeat(40));
const NOW = T.dayStartMs('2026-10-20') + 9 * 3600000 + 10 * 60000;   // 2026-10-20 03:10 local
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const silent = () => {};

function world(rids = ['r_a', 'r_b']) {
  const orders = {};
  const add = (o) => { orders[o.order_id] = o; return o; };
  const fs = makeDb();
  return { orders, add, fs, rtdb: makeRtdb(orders), deps: { fsdb: fs, keyer, listRestaurants: async () => rids, log: silent } };
}
const docsUnder = (fs, frag) => [...fs._raw.keys()].filter((k) => k.includes(frag));
const dailyDoc = async (fs, rid, d) => { const s = await S.dailyRef(fs, rid, d).get(); return s.exists ? s.data() : null; };

(async () => {
  // 1. Nightly targets: the last 7 COMPLETE dates; today is never stored.
  {
    assert.deepStrictEqual(J.nightlyDates(NOW), T.datesBetween('2026-10-13', '2026-10-19'));
    const w = world();
    w.deps.rtdb = w.rtdb;
    await assert.rejects(() => J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'range', from: '2026-10-19', to: '2026-10-20' }), /target_includes_today/);
    ok('nightly = last 7 complete business dates; a range including today is refused');
  }

  // 2. ONE bounded read per run, non-overlapping chunks, exact coverage (incl. created_at ties).
  {
    const w = world();
    for (let i = 0; i < 23; i++) w.add(F.cashOrder({ rid: i % 2 ? 'r_a' : 'r_b', pm: 'cash', now: at('2026-10-15', 12, i % 5), phone: '8888000' + (i % 7), totalCents: 1000 + i }));   // ties on created_at
    w.add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-09-01', 12), phone: '1', totalCents: 1 }));   // far outside
    const { orders, stats } = await J.readOrdersBounded(w.rtdb, T.dayStartMs('2026-10-13') - T.READ_PAD_MS, T.dayEndMs('2026-10-19'), { ...J.DEFAULT_BUDGET, chunkSize: 4 });
    assert.strictEqual(orders.length, 23); assert.strictEqual(new Set(orders.map((o) => o.order_id)).size, 23, 'no record read twice');
    assert.strictEqual(stats.chunks, 6); assert.strictEqual(w.rtdb._queries.length, 6);
    for (const q of w.rtdb._queries) {
      assert.strictEqual(q.order, 'created_at'); assert.strictEqual(q.limit, 4);
      assert.strictEqual(q.endBefore, T.dayEndMs('2026-10-19'));
    }
    assert.strictEqual(w.rtdb._queries[0].start.v, T.dayStartMs('2026-10-13') - T.READ_PAD_MS);
    ok('one bounded created_at range, read once in non-overlapping chunks (ties included exactly once)');
  }

  // 3. The read BUDGET aborts loudly and nothing is published.
  {
    const w = world(); w.deps.rtdb = w.rtdb;
    for (let i = 0; i < 30; i++) w.add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-15', 10, i), phone: '1', totalCents: 100 }));
    await assert.rejects(() => J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true, budget: { maxRecords: 10, maxBytes: 1e9, chunkSize: 5 } }), /stats_read_budget_exceeded/);
    assert.deepStrictEqual(docsUnder(w.fs, 'stats_daily'), []); assert.deepStrictEqual(docsUnder(w.fs, 'stats_customers'), []);
    assert.deepStrictEqual(docsUnder(w.fs, 'stats_meta/state'), []);
    assert.deepStrictEqual(docsUnder(w.fs, 'stats_meta/lease'), [], 'leases released on abort');
    await assert.rejects(() => J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true, budget: { maxRecords: 1e6, maxBytes: 500, chunkSize: 5 } }), /stats_read_budget_exceeded/);
    ok('record AND byte budgets abort the run; nothing published; leases released');
  }

  // 4. DRY-RUN writes NOTHING (not even a lease or a clock probe) but still measures.
  {
    const w = world(); w.deps.rtdb = w.rtdb;
    w.add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-15', 10), phone: '88880001', totalCents: 100 }));
    const before = JSON.stringify([...w.fs._raw]);
    const rep = await J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: false });
    assert.strictEqual(JSON.stringify([...w.fs._raw]), before, 'zero Firestore writes');
    assert.strictEqual(rep.restaurants.r_a.sale_orders, 1);
    assert(rep.restaurants.r_a.measures[0].writes === 7 + 16 + 1, 'measured: 7 dailies + 16 shards + meta');
    ok('dry-run: zero writes, reports totals and the size measurement');
  }

  // 5. Commit publishes every registered restaurant — incl. a synthetic THIRD with no code change.
  {
    const w = world(['r_a', 'r_b', 'zz_third_merchant']); w.deps.rtdb = w.rtdb;
    w.add(F.cashOrder({ rid: 'zz_third_merchant', pm: 'card_delivery', now: at('2026-10-17', 13), phone: '88880001', totalCents: 4200 }));
    w.add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-17', 13), phone: '88880001', totalCents: 1000 }));
    const rep = await J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true });
    assert.deepStrictEqual(Object.keys(rep.restaurants).sort(), ['r_a', 'r_b', 'zz_third_merchant']);
    const d3 = await dailyDoc(w.fs, 'zz_third_merchant', '2026-10-17');
    assert.strictEqual(d3.sale.cents, 4200); assert.strictEqual(d3.by_payment.card_delivery.orders, 1);
    assert.strictEqual((await dailyDoc(w.fs, 'r_a', '2026-10-17')).sale.cents, 1000, 'no cross-restaurant leakage');
    for (const d of J.nightlyDates(NOW)) assert(await dailyDoc(w.fs, 'r_b', d), `r_b ${d} written as a real zero`);
    const meta = await S.readMeta(w.fs, 'r_a');
    assert.strictEqual(meta.epoch, 1); assert.strictEqual(meta.pending_repair, null); assert.strictEqual(meta.shard_count, 16);
    ok('commit: every registered restaurant (synthetic 3rd included), zeros written, epoch 1');
  }

  // 6. A LATE REFUND within 7 days re-settles on the next nightly; a TARGETED REPAIR fixes an older day.
  {
    const w = world(['r_a']); w.deps.rtdb = w.rtdb;
    const p = F.onlinePending({ rid: 'r_a', now: at('2026-10-16', 12), phone: '88880003', totalCents: 9000 });
    const o = w.add(F.materialize({ ...p, payment_status: 'confirmed' }, at('2026-10-16', 12, 1)));
    const old = w.add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-09-20', 12), phone: '88880004', totalCents: 5000 }));
    await J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true });
    await J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'range', from: '2026-09-20', to: '2026-09-20', commit: true });
    assert.strictEqual((await dailyDoc(w.fs, 'r_a', '2026-10-16')).sale.cents, 9000);
    assert.strictEqual((await dailyDoc(w.fs, 'r_a', '2026-09-20')).sale.cents, 5000);
    Object.assign(o, { status: 'cancelled', payment_status: 'refunded' });
    Object.assign(old, { status: 'cancelled' });
    await J.runStatsRollup(w.deps, { nowMs: NOW + T.DAY_MS, mode: 'nightly', commit: true });
    const d16 = await dailyDoc(w.fs, 'r_a', '2026-10-16');
    assert.strictEqual(d16.sale.cents, 0); assert.deepStrictEqual(d16.refunded, { orders: 1, cents: 9000 });
    assert.strictEqual((await dailyDoc(w.fs, 'r_a', '2026-09-20')).sale.cents, 5000, 'beyond 7 days: the nightly does not touch it');
    await J.runStatsRollup(w.deps, { nowMs: NOW + T.DAY_MS, mode: 'range', from: '2026-09-20', to: '2026-09-20', restaurants: ['r_a'], commit: true });
    assert.deepStrictEqual((await dailyDoc(w.fs, 'r_a', '2026-09-20')).cancelled, { orders: 1, cents: 5000 });
    const idx = await S.readShards(w.fs, 'r_a');
    const all = Object.assign({}, ...Object.values(idx));
    assert.strictEqual(all[keyer('r_a', '88880004')], undefined, 'the repaired customer left the index');
    assert.strictEqual(all[keyer('r_a', '88880003')], undefined);
    ok('late refund re-settled by the next nightly; targeted repair beyond 7 days fixes day + index');
  }

  // 7. READ PADDING: a scheduled order placed 7.5 days before its service day is found and attributed.
  {
    const w = world(['r_a']); w.deps.rtdb = w.rtdb;
    const target = '2026-10-13';                                   // earliest nightly target
    w.add(F.scheduledCashOrder({ rid: 'r_a', pm: 'cash', now: at(target, 20) - 7 * T.DAY_MS - 12 * 3600000, phone: '1', totalCents: 777, scheduledFor: at(target, 20) }));
    await J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true });
    assert.strictEqual((await dailyDoc(w.fs, 'r_a', target)).sale.cents, 777);
    ok('read padding catches a far-ahead scheduled order for the earliest target day');
  }

  // 8. INTERRUPTED REPAIR RESUMES from stats_meta.pending_repair.
  {
    const w = world(['r_a']); w.deps.rtdb = w.rtdb;
    w.add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2025-09-10', 12), phone: '1', totalCents: 100 }));
    const late = w.add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-10', 12), phone: '1', totalCents: 300 }));
    const real = S.publishChunk;
    let calls = 0;
    S.publishChunk = async (...a) => { if (++calls === 2) throw Object.assign(new Error('simulated crash'), { code: 'crash' }); return real(...a); };
    try {
      await assert.rejects(() => J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'range', from: '2025-09-01', to: '2026-10-12', commit: true }), /stats_rollup_failed/);
    } finally { S.publishChunk = real; }
    const meta = await S.readMeta(w.fs, 'r_a');
    assert(Array.isArray(meta.pending_repair) && meta.pending_repair.length > 0 && meta.pending_repair.includes('2026-10-10'), 'remaining dates persisted');
    assert.strictEqual(await dailyDoc(w.fs, 'r_a', '2026-10-10'), null, 'chunk 2 never published');
    assert.strictEqual((await dailyDoc(w.fs, 'r_a', '2025-09-10')).sale.cents, 100, 'chunk 1 published coherently');
    void late;
    await J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true });   // the next nightly RESUMES
    assert.strictEqual((await dailyDoc(w.fs, 'r_a', '2026-10-10')).sale.cents, 300);
    assert.strictEqual((await S.readMeta(w.fs, 'r_a')).pending_repair, null);
    ok('an interrupted multi-chunk repair persists pending_repair and the next run resumes it');
  }

  // 9. A held lease SKIPS that restaurant on the nightly (others publish) and the run FAILS LOUDLY in
  //    strict (CLI) mode; an unknown restaurant is refused.
  {
    const w = world(['r_a', 'r_b']); w.deps.rtdb = w.rtdb;
    const tok = await S.acquireLease(w.fs, 'r_a');
    const rep = await J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true });
    assert.deepStrictEqual(rep.restaurants.r_a, { skipped: 'locked' });
    assert.strictEqual((await S.readMeta(w.fs, 'r_b')).epoch, 1);
    await assert.rejects(() => J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true, strictLease: true }), /stats_locked/);
    await S.releaseLease(w.fs, 'r_a', tok);
    await assert.rejects(() => J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'range', from: '2026-10-01', to: '2026-10-01', restaurants: ['nope'] }), /unknown_restaurant/);
    ok('held lease: nightly skips that restaurant, strict mode refuses; unknown restaurant refused');
  }

  // 10. No keyer (secret failed closed) → refused before any read.
  {
    const w = world(); w.deps.rtdb = w.rtdb; w.deps.keyer = null;
    await assert.rejects(() => J.runStatsRollup(w.deps, { nowMs: NOW, mode: 'nightly', commit: true }), /needs_keyer/);
    assert.strictEqual(w.rtdb._queries.length, 0);
    ok('no keyer → refused before any read or write');
  }

  // 11. The CLI: dry-run by default, --project pinned, argument validation.
  {
    const C = require('../tools/stats-rollup');
    assert.strictEqual(C.parseArgs(['backfill', '--project', 'xpizza-delivery']).commit, false, 'dry-run by default');
    assert.strictEqual(C.parseArgs(['backfill', '--project', 'xpizza-delivery', '--commit']).commit, true);
    assert.throws(() => C.parseArgs(['repair', '--project', 'xpizza-delivery', '--from', '2026-01-01']), /repair needs/);
    assert.throws(() => C.parseArgs(['backfill', '--from', '2026-13-01']), /YYYY-MM-DD/);
    assert.throws(() => C.parseArgs(['nuke']), /usage/);
    assert.deepStrictEqual(C.batches('2026-01-01', '2026-01-05', 2), [{ from: '2026-01-01', to: '2026-01-02' }, { from: '2026-01-03', to: '2026-01-04' }, { from: '2026-01-05', to: '2026-01-05' }]);
    const { resolveProject } = require('../tools/require-project');
    assert.throws(() => resolveProject({ argv: ['backfill'], env: { GOOGLE_CLOUD_PROJECT: 'xpizza-delivery' }, requireFlag: true }), /explicit flag/);
    assert.throws(() => resolveProject({ argv: ['backfill', '--project', 'xpizza-social'], env: {}, requireFlag: true }), /refusing to run against/);
    assert.strictEqual(resolveProject({ argv: ['backfill', '--project', 'xpizza-delivery'], env: {}, requireFlag: true }), 'xpizza-delivery');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tools', 'stats-rollup.js'), 'utf8');
    assert(/requireProject\(\{ requireFlag: true \}\)/.test(src), 'the CLI demands the --project flag');
    assert(src.indexOf('requireProject({ requireFlag: true })') < src.indexOf("admin.initializeApp("), 'project guard runs before any client');
    ok('CLI: dry-run default, --project flag mandatory + matched, args validated, guard before init');
  }
  console.log(`\nstats-job: ${n} cells passed`);
})().catch((e) => { console.error(e); process.exit(1); });
