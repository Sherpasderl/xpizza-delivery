'use strict';
// Merchant STATS — the MEASURED SUPPORTED VOLUME (PLAN-stats §S1.3 size preflight; codex r3 #4).
// Builds real summaries from real-writer orders at several daily volumes, measures every document with
// the same docBytes() the preflight uses, and derives the ceilings. Prints the table quoted in the
// hand-back; ASSERTS the design point fits with headroom and that planChunks splits a 2-year backfill
// into publications that each pass the preflight. Run: node stats/stats-volume.test.js
const assert = require('assert');
const T = require('./stats-time');
const B = require('./stats-build');
const X = require('./stats-index');
const S = require('./stats-store');
const F = require('./stats-fixtures');
const { makeCustomerKeyer } = require('./stats-identity');
const { makeDb } = require('../catalog/firestore-fake');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const keyer = makeCustomerKeyer('v'.repeat(40));
const db = makeDb();
const RID = 'r_volume_probe';
const D = '2026-10-05';
const MENU = Array.from({ length: 60 }, (_, i) => ({ name: `Item de menú número ${i + 1}`, unit: 100 + i }));

function dayAt(ordersPerDay, customersPool) {
  const os = [];
  for (let i = 0; i < ordersPerDay; i++) {
    const items = [MENU[i % 60], MENU[(i * 7) % 60]].map((m) => ({ ...m, qty: 1 + (i % 3) }));
    os.push(F.deliver(F.pickup(F.cashOrder({ rid: RID, pm: i % 3 ? 'cash' : 'card_delivery', now: T.dayStartMs(D) + (i * 53000) % 86400000, phone: String(88000000 + (i % customersPool)), items }), T.dayStartMs(D) + (i * 53000) % 86400000 + 1200000), T.dayStartMs(D) + (i * 53000) % 86400000 + 2400000));
  }
  const s = B.buildDailies(os, { keyer, restaurants: new Set([RID]), dates: new Set([D]) }).get(RID).get(D);
  return S.docBytes(S.dailyRef(db, RID, D).path, { ...s, date: D, gen: 1, computed_at: null });
}
function indexBytes(customers, datesEach) {
  const flat = new Map();
  for (let c = 0; c < customers; c++) {
    const k = keyer(RID, String(80000000 + c));
    flat.set(k, Array.from({ length: datesEach }, (_, j) => T.addDays('2024-10-01', (c * 13 + j * 17) % 730)).sort());
  }
  const shards = X.toShards(flat);
  const per = Object.keys(shards).map((id) => S.docBytes(S.shardRef(db, RID, id).path, { v: 1, shard: id, c: shards[id] }));
  return { total: per.reduce((a, b) => a + b, 0), maxShard: Math.max(...per) };
}

const rows = [];
// 1. Daily document size by volume (unique customers ≈ 85% of orders on a day).
for (const v of [30, 100, 300, 1000]) rows.push({ what: `daily doc @ ${v} sales/day`, bytes: dayAt(v, Math.round(v * 0.85)) });
// 2. Customer index by customer count × average Sale dates per customer.
const idx = {};
for (const [c, d] of [[2000, 4], [10000, 6], [25000, 8], [40000, 8]]) { idx[`${c}x${d}`] = indexBytes(c, d); rows.push({ what: `index ${c} customers × ${d} dates`, bytes: idx[`${c}x${d}`].total, max_shard: idx[`${c}x${d}`].maxShard }); }
console.log('\n  measured (bytes, Firestore storage-size rules):');
for (const r of rows) console.log(`    ${r.what.padEnd(34)} ${String(r.bytes).padStart(10)} B${r.max_shard ? `   max shard ${r.max_shard} B` : ''}`);

// Ceilings, derived from the measurements:
const perEntry = (idx['25000x8'].total) / 25000;                                    // bytes per customer @ 8 dates
const maxCustomersCommit = Math.floor((S.LIMITS.maxCommitBytes - 64 * 1024 - dayAt(300, 255)) / perEntry);
const maxCustomersShard = Math.floor(S.LIMITS.maxDocBytes * X.SHARD_COUNT / perEntry);
console.log(`\n  per customer entry @ 8 dates ≈ ${perEntry.toFixed(1)} B; ceiling ≈ ${Math.min(maxCustomersCommit, maxCustomersShard)} customers per restaurant`
  + ` (commit-bound ${maxCustomersCommit}, shard-bound ${maxCustomersShard}) before a redesign (more shards / per-period index).`);

// 3. The design point fits with headroom: 300 sales/day, 25,000 customers × 8 dates.
{
  const daily = dayAt(300, 255);
  assert(daily < S.LIMITS.maxDocBytes / 10, `daily doc ${daily} B`);
  assert(idx['25000x8'].maxShard < S.LIMITS.maxDocBytes, 'every shard under the per-doc limit');
  assert(idx['25000x8'].total + daily + 64 * 1024 < S.LIMITS.maxCommitBytes, 'index + one day fits a publication');
  ok(`design point (300 sales/day, 25k customers × 8 dates) fits: daily ${daily} B, index ${idx['25000x8'].total} B, max shard ${idx['25000x8'].maxShard} B`);
}

// 4. A 2-year backfill at the design point is split by planChunks into publications that each pass the
//    preflight; the over-volume case fails LOUDLY, never partially.
{
  const dates = T.datesBetween('2024-10-06', '2026-10-05');
  const daily = dayAt(300, 255);
  const parts = S.planChunks(dates, () => daily, idx['25000x8'].total);
  assert.deepStrictEqual([].concat(...parts), dates, 'every date exactly once, in order');
  for (const p of parts) {
    assert(p.length <= S.CHUNK_DATES && p.length + 17 <= S.LIMITS.maxWrites);
    assert(idx['25000x8'].total + 64 * 1024 + p.length * daily <= S.LIMITS.maxCommitBytes);
  }
  console.log(`    2-year backfill @ design point → ${parts.length} publications (≤ ${Math.max(...parts.map((p) => p.length))} dates each)`);
  const small = S.planChunks(dates, () => dayAt(30, 25), idx['2000x4'].total);
  console.log(`    2-year backfill @ 30 sales/day, 2k customers → ${small.length} publications`);
  assert.throws(() => S.planChunks(dates, () => daily, S.LIMITS.maxCommitBytes), /stats_size_preflight_failed[\s\S]*SUPPORTED VOLUME/);
  ok('planChunks splits a 2-year backfill into preflight-passing publications; over-volume throws loudly');
}
// 5. The preflight itself: each limit trips, with the numbers, and the measurement is returned when under.
{
  const w = (k, bytes) => Array.from({ length: k }, (_, i) => ({ path: `restaurants/r/stats_daily/d${i}`, data: { blob: 'x'.repeat(bytes) } }));
  assert.throws(() => S.preflight(w(451, 10)), (e) => e.code === 'stats_size_preflight_failed' && /writes 451 > 450/.test(e.message));
  assert.throws(() => S.preflight(w(1, 950 * 1024)), (e) => e.code === 'stats_size_preflight_failed' && /doc restaurants\/r\/stats_daily\/d0/.test(e.message));
  assert.throws(() => S.preflight(w(12, 800 * 1024)), (e) => e.code === 'stats_size_preflight_failed' && /commit \d+ B > 9437184 B/.test(e.message));
  const m = S.preflight(w(3, 100));
  assert.strictEqual(m.writes, 3); assert(m.commit_bytes > 300 && m.max_doc_bytes > 100);
  ok('preflight trips on writes, per-doc bytes and commit bytes (with the numbers); measures when under');
}
console.log(`\nstats-volume: ${n} cells passed`);
