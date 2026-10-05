'use strict';
// Merchant STATS — the MEASURED SUPPORTED VOLUME (PLAN-stats §S1.3 size preflight; codex build r1 #4).
// Real summaries from real-writer orders, measured three ways:
//   • storage size (the 1 MiB DOCUMENT limit) — docBytes;
//   • the REAL serialized CommitRequest (the 10 MiB REQUEST limit) — protoWriteBytes, asserted here
//     against the Admin SDK's own encoder (its serializer + the google.firestore.v1 protobuf schema);
//   • single-field INDEX ENTRIES per document (the 40,000 limit), under the deployed exemptions and under
//     default indexing.
// Prints the table quoted in the hand-back and ASSERTS the design point fits. Run: node stats/stats-volume.test.js
const assert = require('assert');
const T = require('./stats-time');
const B = require('./stats-build');
const X = require('./stats-index');
const S = require('./stats-store');
const F = require('./stats-fixtures');
const { makeCustomerKeyer } = require('./stats-identity');
const { exemptFor } = require('./stats-indexing');
const { makeDb } = require('../catalog/firestore-fake');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const keyer = makeCustomerKeyer('v'.repeat(40));
const db = makeDb();
const RID = 'r_volume_probe';
const D = '2026-10-05';
const MENU = Array.from({ length: 60 }, (_, i) => ({ name: `Item de menú número ${i + 1}`, unit: 100 + i }));

// The SDK's REAL encoder (test-only: protobufjs is a transitive dependency of firebase-admin, never runtime).
const admin = require('firebase-admin');
const app = admin.initializeApp({ projectId: 'xpizza-delivery' }, 'stats-volume-probe');   // no network: the serializer is local
const fsReal = app.firestore();
const protobuf = require('protobufjs');
const CommitRequest = protobuf.Root.fromJSON(require('@google-cloud/firestore/build/protos/v1.json')).lookupType('google.firestore.v1.CommitRequest');
const realCommitBytes = (writes) => CommitRequest.encode(CommitRequest.fromObject({
  database: 'projects/xpizza-delivery/databases/(default)', transaction: Buffer.alloc(32),
  writes: writes.map((w) => ({ update: { name: `projects/xpizza-delivery/databases/(default)/documents/${w.path}`, fields: fsReal._serializer.encodeFields(w.data) } })),
})).finish().length;
const estCommitBytes = (writes) => S.COMMIT_OVERHEAD_BYTES + writes.reduce((a, w) => a + S.protoWriteBytes(w.path, w.data), 0);

function daySummary(ordersPerDay, customersPool) {
  const os = [];
  for (let i = 0; i < ordersPerDay; i++) {
    const t = T.dayStartMs(D) + (i * 53000) % 86400000;
    const items = [MENU[i % 60], MENU[(i * 7) % 60]].map((m) => ({ ...m, qty: 1 + (i % 3) }));
    os.push(F.deliver(F.pickup(F.cashOrder({ rid: RID, pm: i % 3 ? 'cash' : 'card_delivery', now: t, phone: String(88000000 + (i % customersPool)), items }), t + 1200000), t + 2400000));
  }
  return { ...B.buildDailies(os, { keyer, restaurants: new Set([RID]), dates: new Set([D]) }).get(RID).get(D), date: D, gen: 1 };
}
function shardsFor(customers, datesEach) {
  const flat = new Map();
  for (let c = 0; c < customers; c++) flat.set(keyer(RID, String(80000000 + c)), Array.from({ length: datesEach }, (_, j) => T.addDays('2024-10-01', (c * 13 + j * 17) % 730)).sort());
  const sh = X.toShards(flat);
  return Object.keys(sh).map((id) => ({ path: S.shardRef(db, RID, id).path, data: { v: 1, shard: id, c: sh[id] } }));
}
const dailyWrite = (s) => ({ path: S.dailyRef(db, RID, D).path, data: s });

// 1. The wire-size estimator matches the SDK's real CommitRequest encoding (never under; ≤ 40 B per
//    write over, the name headroom) — on daily docs and on index shards.
{
  const samples = [[dailyWrite(daySummary(30, 25))], [dailyWrite(daySummary(300, 255))], shardsFor(2000, 4), shardsFor(3000, 30)];
  for (const ws of samples) {
    const real = realCommitBytes(ws), est = estCommitBytes(ws);
    assert(est >= real, `estimator under the real encoding: ${est} < ${real}`);
    assert(est - real <= 40 * ws.length + S.COMMIT_OVERHEAD_BYTES, `estimator too loose: ${est} vs ${real}`);
  }
  const storage = shardsFor(2000, 4).reduce((a, w) => a + S.docBytes(w.path, w.data), 0);
  assert(realCommitBytes(shardsFor(2000, 4)) > storage * 1.2, 'non-vacuity: the request really is larger than the storage-size model');
  ok('commit bytes = the REAL serialized CommitRequest (estimator never under, ≤ 40 B/write over)');
}

// 2. The table.
const rows = [];
for (const v of [30, 100, 300, 1000]) {
  const s = daySummary(v, Math.round(v * 0.85));
  rows.push({ what: `daily doc @ ${v} sales/day`, storage: S.docBytes(dailyWrite(s).path, s), wire: realCommitBytes([dailyWrite(s)]), idx: S.indexEntries(s, exemptFor('stats_daily')), idxDefault: S.indexEntries(s) });
}
const IDX = {};
for (const [c, d] of [[2000, 4], [10000, 6], [25000, 8], [40000, 8], [25000, 30]]) {
  const ws = shardsFor(c, d);
  IDX[`${c}x${d}`] = { wire: realCommitBytes(ws), maxShard: Math.max(...ws.map((w) => S.docBytes(w.path, w.data))), idx: Math.max(...ws.map((w) => S.indexEntries(w.data, exemptFor('stats_customers')))), idxDefault: Math.max(...ws.map((w) => S.indexEntries(w.data))) };
  rows.push({ what: `index ${c} customers × ${d} dates`, storage: IDX[`${c}x${d}`].maxShard, wire: IDX[`${c}x${d}`].wire, idx: IDX[`${c}x${d}`].idx, idxDefault: IDX[`${c}x${d}`].idxDefault, shard: true });
}
console.log('\n  measured — storage = per doc (max shard for the index); wire = REAL CommitRequest bytes (whole index for the index);');
console.log('  index entries = max per document under the deployed exemptions (default indexing in brackets; Firestore refuses > 40,000)');
for (const r of rows) console.log(`    ${r.what.padEnd(32)} storage ${String(r.storage).padStart(8)} B   wire ${String(r.wire).padStart(9)} B   index entries ${String(r.idx).padStart(3)} [${r.idxDefault}]`);

// Ceilings, from the REAL encoding.
const perCustomer8 = IDX['25000x8'].wire / 25000, perCustomer30 = IDX['25000x30'].wire / 25000;
const day300 = realCommitBytes([dailyWrite(daySummary(300, 255))]);
const budget = S.LIMITS.maxCommitBytes - 64 * 1024 - day300 - 2048;
const ceil8 = Math.floor(budget / perCustomer8), ceil30 = Math.floor(budget / perCustomer30);
const storagePer8 = (IDX['25000x8'].maxShard * X.SHARD_COUNT) / 25000;
const shardCeil8 = Math.floor(S.LIMITS.maxDocBytes * X.SHARD_COUNT / storagePer8);
console.log(`\n  CEILING (index + one 300-sale day + meta must fit one ${S.LIMITS.maxCommitBytes} B request):`);
console.log(`    ≈ ${ceil8} customers @ 8 Sale dates each (${perCustomer8.toFixed(0)} B wire/customer); ≈ ${ceil30} @ 30 dates (${perCustomer30.toFixed(0)} B)`);
console.log(`    per-shard storage bound @ 8 dates ≈ ${shardCeil8} customers (not binding); index entries under exemptions: constant (${IDX['40000x8'].idx}/doc)`);
console.log(`    UNDEPLOYED exemptions: a 25k × 30-date index needs ${IDX['25000x30'].idxDefault} entries in one shard (> 40,000 → Firestore refuses the commit) — deploy indexes BEFORE the backfill.`);

// 3. The design point fits with headroom (300 sales/day, 25k customers × 8 dates).
{
  const s = daySummary(300, 255);
  assert(S.docBytes(dailyWrite(s).path, s) < S.LIMITS.maxDocBytes / 10);
  assert(IDX['25000x8'].maxShard < S.LIMITS.maxDocBytes);
  assert(IDX['25000x8'].wire + day300 + 64 * 1024 < S.LIMITS.maxCommitBytes, 'index + one day fits a publication (real wire bytes)');
  assert(IDX['40000x8'].idx < 100 && rows[3].idx < 200, 'index entries tiny under the exemptions');
  assert(IDX['25000x30'].idxDefault > 40000, 'non-vacuity: under DEFAULT indexing a realistic shard exceeds Firestore\'s 40,000-entry limit');
  assert(IDX['25000x30'].idx < 100, '…and under the exemptions the same shard needs a handful');
  ok(`design point fits: index ${IDX['25000x8'].wire} B wire, max shard ${IDX['25000x8'].maxShard} B, ≤ ${IDX['40000x8'].idx} index entries/doc`);
}

// 4. planChunks (on wire bytes) splits a 2-year backfill into publications whose REAL encoding fits;
//    over-volume throws loudly, never partially.
{
  const dates = T.datesBetween('2024-10-06', '2026-10-05');
  const parts = S.planChunks(dates, () => day300, IDX['25000x8'].wire);
  assert.deepStrictEqual([].concat(...parts), dates, 'every date exactly once, in order');
  for (const p of parts) {
    assert(p.length <= S.CHUNK_DATES && p.length + 17 <= S.LIMITS.maxWrites);
    assert(IDX['25000x8'].wire + 64 * 1024 + p.length * day300 <= S.LIMITS.maxCommitBytes);
  }
  console.log(`    2-year backfill @ design point → ${parts.length} publications (≤ ${Math.max(...parts.map((p) => p.length))} dates each)`);
  assert.throws(() => S.planChunks(dates, () => day300, S.LIMITS.maxCommitBytes), /stats_size_preflight_failed[\s\S]*SUPPORTED VOLUME/);
  ok('planChunks splits a 2-year backfill into publications that fit on REAL wire bytes; over-volume throws');
}

// 5. The preflight trips on each limit — writes, document bytes, commit bytes, INDEX ENTRIES — with numbers.
{
  const w = (k, bytes) => Array.from({ length: k }, (_, i) => ({ path: `restaurants/r/stats_daily/d${i}`, data: { blob: 'x'.repeat(bytes) } }));
  assert.throws(() => S.preflight(w(451, 10)), (e) => e.code === 'stats_size_preflight_failed' && /writes 451 > 450/.test(e.message));
  assert.throws(() => S.preflight(w(1, 950 * 1024)), (e) => e.code === 'stats_size_preflight_failed' && /doc restaurants\/r\/stats_daily\/d0/.test(e.message));
  assert.throws(() => S.preflight(w(12, 800 * 1024)), (e) => e.code === 'stats_size_preflight_failed' && /commit \d+ B > 9437184 B/.test(e.message));
  // codex's repro shape: a shard-sized doc with 60k array elements in a NON-exempt field must be refused
  const arr = [{ path: 'restaurants/r/stats_unexempt/x', data: { c: { k: Array.from({ length: 60000 }, (_, i) => `d${i}`) } } }];
  assert.throws(() => S.preflight(arr), (e) => e.code === 'stats_size_preflight_failed' && /index entries/.test(e.message));
  // …while the same payload in the exempt shard field passes the index check
  assert.doesNotThrow(() => S.preflight([{ path: 'restaurants/r/stats_customers/0', data: arr[0].data }]));
  // the preflight's commit figure IS the wire figure (not the smaller storage model)
  const shardWrites = shardsFor(2000, 4);
  assert.strictEqual(S.preflight(shardWrites).commit_bytes, estCommitBytes(shardWrites));
  assert(S.preflight(shardWrites).commit_bytes >= realCommitBytes(shardWrites));
  const m = S.preflight(w(3, 100));
  assert.strictEqual(m.writes, 3); assert(m.commit_bytes > 300 && m.max_doc_bytes > 100 && m.max_index_entries >= 2);
  ok('preflight trips on writes, doc bytes, REAL commit bytes and INDEX ENTRIES (exemption-aware), with the numbers');
}
console.log(`\nstats-volume: ${n} cells passed`);
process.exit(0);
