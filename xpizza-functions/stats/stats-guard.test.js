'use strict';
// Merchant STATS — the NO-ORDER-PATH guard (PLAN-stats rev 4 Non-negotiables; codex r1 #14).
//   • the stats runtime import graph is a CLOSED allowlist — deny by default: a new edge into a payment,
//     materialize, order-writing or identity module fails here until someone looks at it;
//   • no stats module performs an RTDB write, references getDatabase, or registers a trigger/endpoint;
//   • index.js references stats ONLY inside its one export-wiring block, which itself writes nothing;
//   • the stats Firestore paths are deny-by-default to clients (no rule opens them);
//   • test-only helpers never enter the runtime graph;
//   • END TO END, no phone ever appears in any captured output of a real job run + API calls.
// Run: node stats/stats-guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parse } = require('acorn');
const { runtimeImportGraph } = require('../catalog/guard-ast');
// 🔴 A SUITE THAT STOPS EARLY MUST NOT EXIT 0. If an awaited promise never settles, Node drains the event
// loop and exits 0 mid-cell — a silent pass. The suite must reach its last line to succeed.
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing (an awaited promise never settled)'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const rel = (f) => path.relative(ROOT, f);

const RUNTIME_ENTRIES = ['stats/stats-api.js', 'stats/stats-job.js', 'stats/stats-store.js', 'stats/stats-build.js', 'stats/stats-classify.js',
  'stats/stats-index.js', 'stats/stats-identity.js', 'stats/stats-time.js', 'stats/stats-indexing.js', 'tools/stats-rollup.js'];
const ALLOWED_GRAPH = new Set([...RUNTIME_ENTRIES,
  'scheduled-orders.js',           // TZ_OFFSET_MS + DEFAULT_CFG.maxHorizonHours (pure constants/helpers)
  'restaurant-id.js',              // DEFAULT_RESTAURANT_ID for rid-less legacy orders (advisor C2)
  'menu-pricing.js', 'price-valid.js',   // pulled in by restaurant-id.js (pure tables); nothing is called
  'tools/require-project.js',      // the CLI's project pin
  'catalog/restaurant-registry.js',// makeFirestoreRegistryReader (read-only listDocuments)
  'catalog/mirror-rtdb.js',        // the CLI imports RTDB_URL only — see cell 2's call check
]);
const ALLOWED_EXTERNALS = new Set(['crypto', 'firebase-admin', 'fs', 'path', 'dotenv']);

// 1. CLOSED import graph.
{
  const g = runtimeImportGraph(RUNTIME_ENTRIES, ROOT);
  assert.deepStrictEqual(g.unresolved, []); assert.deepStrictEqual(g.dynamic, []);
  const files = g.files.map(rel);
  const extra = files.filter((f) => !ALLOWED_GRAPH.has(f));
  assert.deepStrictEqual(extra, [], `stats runtime reaches modules outside the allowlist: ${extra.join(', ')}`);
  for (const f of files) assert(!/pixelpay|materialize|create-order|charge|cancel|resolve|rewards|whatsapp|factura|identity-|catalog-publish|catalog-edit|edit-catalog|publish-edited/.test(f) || f === 'stats/stats-identity.js', f);
  for (const e of g.externals) assert(ALLOWED_EXTERNALS.has(e), `external ${e}`);
  for (const t of ['stats/stats-fixtures.js', 'stats/stats-gen.js', 'stats/stats-rtdb-fake.js']) assert(!files.includes(t), `${t} is test-only`);
  ok(`runtime import graph is the closed allowlist (${files.length} files): no payment / materialize / order-writer / identity module`);
}

// AST helpers
const astOf = (file) => parse(fs.readFileSync(path.join(ROOT, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', locations: true });
function walk(node, f) { if (!node || typeof node.type !== 'string') return; f(node); for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, f)); else if (v && typeof v.type === 'string') walk(v, f); } }
const RTDB_WRITES = new Set(['set', 'update', 'push', 'remove', 'transaction', 'setPriority', 'setWithPriority']);
// An RTDB write = a write method called on a chain that contains a `.ref(` call (db.ref(...)...set()).
function chainHasRefCall(n) {
  while (n) {
    if (n.type === 'CallExpression') { if (n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'ref') return true; n = n.callee; continue; }
    if (n.type === 'MemberExpression') { n = n.object; continue; }
    if (n.type === 'ChainExpression') { n = n.expression; continue; }
    return false;
  }
  return false;
}
function rtdbWrites(ast) {
  const hits = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const c = node.callee;
    if (c.type === 'MemberExpression' && !c.computed && RTDB_WRITES.has(c.property.name) && chainHasRefCall(c.object)) hits.push(node.loc.start.line);
  });
  return hits;
}
const FORBIDDEN_IDS = new Set(['getDatabase', 'onValueWritten', 'onValueCreated', 'onValueUpdated', 'onValueDeleted', 'onSchedule', 'onRequest', 'onCall', 'onDocumentWritten']);

// 2. No RTDB write, no getDatabase, no trigger, no firebase-functions — in ANY stats runtime module.
{
  // non-vacuity first: the detector flags the shapes it exists for
  const probe = parse("db.ref('orders/x').set(1); rtdb.ref('orders').child(id).update({}); getDatabase().ref(p).push(v); tx.set(ref, d); ref.set(d);", { ecmaVersion: 'latest', locations: true });
  assert.deepStrictEqual(rtdbWrites(probe).length, 3, 'detector catches the three RTDB writes and ignores the Firestore ones');
  for (const f of RUNTIME_ENTRIES) {
    const ast = astOf(f);
    assert.deepStrictEqual(rtdbWrites(ast), [], `${f}: RTDB write at line(s) ${rtdbWrites(ast)}`);
    walk(ast, (node) => {
      if (node.type === 'Identifier') assert(!FORBIDDEN_IDS.has(node.name), `${f}:${node.loc.start.line} references ${node.name}`);
      if (node.type === 'Literal' && typeof node.value === 'string') assert(!/^firebase-functions/.test(node.value), `${f} imports firebase-functions`);
    });
  }
  // The only /orders access is a READ: every `.ref('orders')` call chain ends in once('value').
  for (const f of RUNTIME_ENTRIES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const refs = src.match(/\.ref\((['"`])[^'"`]*\1\)/g) || [];
    for (const r of refs) assert(/\.ref\('orders'\)/.test(r), `${f}: unexpected RTDB path ${r}`);
  }
  // mirror-rtdb is imported by the CLI for a constant only.
  const cli = fs.readFileSync(path.join(ROOT, 'tools/stats-rollup.js'), 'utf8');
  assert(/const \{ RTDB_URL \} = require\('\.\.\/catalog\/mirror-rtdb'\)/.test(cli) && !/makeRtdbMirror|writeMirror/.test(cli), 'CLI uses mirror-rtdb for RTDB_URL only');
  ok('stats modules: zero RTDB writes (detector proven), no getDatabase, no trigger/endpoint registration, /orders only');
}

// 3. index.js: stats appears ONLY in its export-wiring block; the block writes nothing.
{
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const start = src.indexOf('// ── Merchant STATS S1');
  assert(start > 0, 'stats block present');
  const endMarker = 'exports.getSalesStats = onRequest(';
  const endIdx = src.indexOf('\n);\n', src.indexOf(endMarker));
  assert(endIdx > start);
  const block = src.slice(start, endIdx + 4);
  const outside = src.slice(0, start) + src.slice(endIdx + 4);
  for (const id of ['stats/', 'runStatsRollup', 'getSalesStatsCore', 'statsKeyer', 'loadStatsSecret', 'makeCustomerKeyer', '_statsLiveCache']) {
    assert(!outside.includes(id), `index.js references ${id} outside the stats block`);
  }
  const blockAst = parse(block.replace(/^[\s\S]*?(const \{ runStatsRollup)/, '$1'), { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, locations: true });
  assert.deepStrictEqual(rtdbWrites(blockAst), [], 'the wiring block performs no RTDB write');
  const exportsIn = block.match(/exports\.(\w+)\s*=/g).map((s) => s.replace(/exports\.|\s*=/g, ''));
  assert.deepStrictEqual(exportsIn, ['rollupDailyStats', 'getSalesStats']);
  assert(/cors: PORTAL_ORIGINS/.test(block), 'getSalesStats uses the existing PORTAL_ORIGINS');
  assert(/authorizeCatalogEdit\(\{ db: getDatabase\(\), verifyIdToken/.test(block), 'the existing catalog-edit authorization');
  // the job's timeout stays under the lease
  const { LEASE_MS } = require('./stats-store');
  const t = Number((block.match(/rollupDailyStats[\s\S]*?timeoutSeconds: (\d+)/) || [])[1]);
  assert(t * 1000 < LEASE_MS, `job timeout ${t}s must be < lease ${LEASE_MS / 1000}s`);
  ok('index.js: stats referenced only in the export block (2 exports, PORTAL_ORIGINS, existing auth, timeout < lease)');
}

// 4. Firestore rules: no rule opens a stats path (deny-by-default), and no recursive wildcard does it implicitly.
{
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  assert(!/stats_/.test(rules), 'no rule mentions stats_*');
  const restaurantsBlock = rules.slice(rules.indexOf('match /restaurants/{restaurantId}'));
  assert(!/match \/\{[^}]*=\*\*\}[\s\S]*allow read: if true/.test(restaurantsBlock.split('match /{document=**}')[0]), 'no public recursive wildcard under restaurants');
  assert(/match \/\{document=\*\*\} \{ allow read, write: if false; \}/.test(rules), 'global default-deny present');
  ok('stats_daily / stats_customers / stats_meta are deny-by-default to clients');
}

// 4b. INDEX EXEMPTIONS (codex build r1 #4): firestore.indexes.json is exactly stats-indexing.js's list,
//     firebase.json deploys it, and under the exemptions a realistic daily doc / a full shard need only a
//     handful of index entries (they would need thousands under default indexing).
{
  const { fieldOverrides, exemptFor } = require('./stats-indexing');
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  /* 🔴 firestore.indexes.json IS THE WHOLE-DATABASE INVENTORY (codex build r2 B4'), not a stats file: the
     CLI deletes/resets whatever it omits. So this asserts only what stats OWNS — every stats exemption is
     present, as a full exemption — and NOT that the file is otherwise empty: other features' composite
     indexes and overrides belong in it too. Deploy safety is NOT asserted from this file: it comes from
     the only sanctioned deploy, `npm run deploy:indexes` (--non-interactive, deletion never forced), under which
     the Firebase CLI skips — never deletes — remote definitions the file omits (tools/deploy-indexes.test.js
     pins that, against the installed CLI). tools/firestore-indexes-report.js is advisory only. */
  assert(Array.isArray(cfg.indexes) && Array.isArray(cfg.fieldOverrides), 'a valid inventory file');
  for (const want of fieldOverrides()) {
    const got = cfg.fieldOverrides.filter((o) => o.collectionGroup === want.collectionGroup && o.fieldPath === want.fieldPath);
    assert.strictEqual(got.length, 1, `stats exemption ${want.collectionGroup}.${want.fieldPath} present exactly once`);
    assert.deepStrictEqual(got[0].indexes, [], `${want.collectionGroup}.${want.fieldPath} must be a full exemption`);
  }
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  assert.strictEqual(fb.firestore.indexes, 'firestore.indexes.json', 'firebase.json deploys the index config');
  // the advisory report describes exactly the file firebase.json deploys
  const rp = fs.readFileSync(path.join(ROOT, 'tools', 'firestore-indexes-report.js'), 'utf8');
  assert(/fb\.firestore\.indexes/.test(rp), 'the report reads the deployed inventory path from firebase.json');
  const S = require('./stats-store'); const B = require('./stats-build');
  const day = B.emptySummary();
  for (let i = 0; i < 5000; i++) day.customers[`h1:${String(i).padStart(32, '0')}`] = { orders: 1, cents: 100 };
  for (let i = 0; i < 300; i++) day.items[`item ${i}`] = { qty: 1, cents: 100 };
  const shard = { v: 1, shard: '0', c: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`h1:${i}`, Array.from({ length: 20 }, (_, j) => `2026-01-${String(j + 1).padStart(2, '0')}`)])) };
  const dailyExempt = S.indexEntries({ ...day, date: 'd', gen: 1 }, exemptFor('stats_daily'));
  const shardExempt = S.indexEntries(shard, exemptFor('stats_customers'));
  assert(dailyExempt < 200, `daily doc under exemptions needs ${dailyExempt} entries`);
  assert(shardExempt < 20, `shard under exemptions needs ${shardExempt} entries`);
  assert(S.indexEntries(shard) > 40000, 'non-vacuity: the same shard under DEFAULT indexing exceeds Firestore\'s 40,000 limit');
  ok(`stats exemptions present in the whole-DB inventory (no emptiness assumed), the report reads the deployed file; daily ${dailyExempt} / shard ${shardExempt} entries (default indexing: ${S.indexEntries(shard)})`);
}

// 5. 🔴 END TO END: run a REAL job + API over phone-bearing orders with EVERY output channel captured;
//    no phone (raw or normalized) and no hmac appears anywhere.
(async () => {
  const T = require('./stats-time');
  const J = require('./stats-job'); const A = require('./stats-api'); const F = require('./stats-fixtures');
  const { makeRtdb } = require('./stats-rtdb-fake'); const { makeDb } = require('../catalog/firestore-fake');
  const { makeCustomerKeyer, normalizePhoneSilent } = require('./stats-identity');
  const keyer = makeCustomerKeyer('g'.repeat(40));
  const NOW = T.dayStartMs('2026-10-20') + 12 * 3600000;
  const orders = {};
  const phones = ['+504 9911-2233', '99112244', 'not a phone 9911', '(504) 9911-2255', '1'];
  phones.forEach((p, i) => { const o = F.cashOrder({ rid: 'r_a', pm: 'cash', now: T.dayStartMs('2026-10-1' + (i + 1)) + 3600000, phone: p, totalCents: 100 }); orders[o.order_id] = o; });
  const fsdb = makeDb(); const rtdb = makeRtdb(orders);
  const seen = [];
  const keep = {}; for (const k of ['log', 'warn', 'error', 'info', 'debug']) { keep[k] = console[k]; console[k] = (...a) => seen.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }
  const so = process.stdout.write, se = process.stderr.write;
  process.stdout.write = (c) => { seen.push(String(c)); return true; }; process.stderr.write = (c) => { seen.push(String(c)); return true; };
  let bodies = [];
  try {
    await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a'] }, { nowMs: NOW, mode: 'nightly', commit: true });   // default logger = console
    await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a'] }, { nowMs: NOW, mode: 'nightly', commit: false });
    const authorize = async () => ({ ok: true, role: 'owner' });
    for (const q of [{ from: '2026-10-11', to: '2026-10-20' }, { from: '2026-10-11', to: '2026-10-19', format: 'csv' }, { from: '2026-10-11', to: '2026-10-19', format: 'csv', kind: 'orders' }]) {
      const r = await A.getSalesStatsCore({ authorize, fsdb, rtdb, getKeyer: () => keyer, nowMs: NOW }, { method: 'GET', query: { restaurantId: 'r_a', ...q } });
      bodies.push(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    }
    // a failing run logs too — capture its output as well
    await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a'] }, { nowMs: NOW, mode: 'nightly', commit: true, limits: { maxDocBytes: 10, maxWrites: 450, maxCommitBytes: 1e9 } }).catch((e) => seen.push(e.message));
  } finally { Object.assign(console, keep); process.stdout.write = so; process.stderr.write = se; }
  assert(seen.length > 0, 'non-vacuity: the run produced captured output');
  const hay = seen.join('\n') + '\n' + bodies.join('\n');
  const needles = [];
  for (const p of phones) { needles.push(p); const nrm = normalizePhoneSilent(p); if (nrm) needles.push(nrm, nrm.slice(3)); }
  for (const x of needles.filter((s) => s.length >= 4)) assert(!hay.includes(x), `phone ${x} appeared in output`);
  assert(!/h1:[0-9a-f]{8}/.test(hay), 'no customer hmac in any output');
  ok(`end-to-end log capture (${seen.length} lines + ${bodies.length} responses): no phone, no hmac`);
  console.log(`\nstats-guard: ${n} cells passed`);
  __finished = true;
})().catch((e) => { console.error(e); process.exit(1); });
