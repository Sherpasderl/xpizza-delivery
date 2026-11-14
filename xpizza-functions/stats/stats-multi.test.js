'use strict';
// S2 (PLAN-portal-inicio-server-r0, advisor-approved 11-13) — getSalesStats over SEVERAL branches (`restaurantIds`), merged on the
// server. The REAL authorizeCatalogEdit over a membership double; data from a REAL rollup over real-writer fixtures (stats-api.test.js's
// world); the expected money comes from the server's own B.mergeSummaries / B.avgPaidTicket over the REAL stored dailies — never a
// formula in the test. The single-branch path is pinned byte-for-byte against the base module (604e96ab5) loaded from git.
// Run: node stats/stats-multi.test.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const T = require('./stats-time');
const S = require('./stats-store');
const J = require('./stats-job');
const A = require('./stats-api');
const B = require('./stats-build');
const F = require('./stats-fixtures');
const { makeRtdb } = require('./stats-rtdb-fake');
const { makeDb } = require('../catalog/firestore-fake');
const { makeCustomerKeyer } = require('./stats-identity');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing'); process.exit(1); } });
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const BASE_REF = '604e96ab5';   // train/asm9 — the single-branch module before S2
const keyer = makeCustomerKeyer('s'.repeat(40));
const NOW = T.dayStartMs('2026-10-20') + 15 * 3600000;
const TODAY = '2026-10-20';
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const legacyBrand = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
function members(owners) {   // owners: [[rid, uid], …]
  const vals = new Map();
  for (const [rid, uid] of owners) { vals.set(`brand_members/${rid}/owners/${uid}`, { granted_at: 1, granted_by: 'x' }); vals.set(`brands/${rid}`, legacyBrand(rid)); }
  return { ref: (p) => ({ once: async () => { const v = vals.has(p) ? vals.get(p) : null; return { exists: () => v !== null, val: () => v }; } }) };
}
const MEMBERS = members([['r_a', 'uM'], ['r_b', 'uM'], ['r_a', 'uA']]);
const TOKENS = { both: { uid: 'uM' }, onlyA: { uid: 'uA' } };
const verifyIdToken = async (t) => { if (!TOKENS[t]) throw new Error('bad token'); return TOKENS[t]; };
const req = (query, token) => ({ method: 'GET', query, get: (h) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined) });

async function world() {
  const orders = {}; const add = (o) => { orders[o.order_id] = o; return o; };
  add(F.cashOrder({ rid: 'r_a', pm: 'card_delivery', now: at('2026-10-14', 13), phone: '88880001', totalCents: 20000 }));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-15', 19), phone: '88880002', totalCents: 30000 }));
  add(F.cancel(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-15', 20), phone: '88880003', totalCents: 4000 })));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-08', 12), phone: '88880005', totalCents: 7000 }));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 10), phone: '88880009', totalCents: 1500 }));
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at('2026-10-15', 12), phone: '88880001', totalCents: 99900 }));
  add(F.cashOrder({ rid: 'r_b', pm: 'card_delivery', now: at('2026-10-16', 12), phone: '88880007', totalCents: 4500 }));
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at(TODAY, 9), phone: '88880008', totalCents: 2200 }));
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at('2026-10-12', 13), phone: '88880006', totalCents: 5100 }));   // r_b inside the comparison window (MS-LIVE-COMPARE)
  const fs = makeDb(); const rtdb = makeRtdb(orders);
  await J.runStatsRollup({ rtdb, fsdb: fs, keyer, listRestaurants: async () => ['r_a', 'r_b'], log: () => {} }, { nowMs: NOW, mode: 'range', from: '2026-09-25', to: '2026-10-19', commit: true });
  return { fs, rtdb };
}
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
function core(w, { mod = A, fsdb = null, log = null } = {}) {
  return (query, token) => { const r = req(query, token); return quiet(() => mod.getSalesStatsCore({
    authorize: (rid) => authorizeCatalogEdit({ db: MEMBERS, verifyIdToken }, r, rid),
    fsdb: fsdb || (log ? spyFs(w.fs, log) : w.fs), rtdb: w.rtdb, getKeyer: () => keyer, nowMs: NOW, liveCache: mod.makeLiveCache() }, r)); };
}
function spyFs(fs, log) {
  const wrapRef = (ref) => ({ ...ref, get: async () => { log.push(`fs:${ref.path}`); return ref.get(); } });
  const col = (base) => ({ doc: (id) => { const r = base.doc(id); return { ...wrapRef(r), path: r.path, collection: (c) => col(r.collection(c)) }; } });
  return { collection: (c) => col(fs.collection(c)), runTransaction: fs.runTransaction };
}
// the base module, compiled from git at its own path (its relative requires resolve to this tree's stats modules, unchanged by S2)
function baseModule() {
  const file = path.join(__dirname, 'stats-api.js');
  const src = execFileSync('git', ['show', `${BASE_REF}:xpizza-functions/stats/stats-api.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, file); return m.exports;
}
const H = { from: '2026-10-14', to: '2026-10-16' };   // historical: fully determined by the stored dailies
const both = (o = {}) => ({ restaurantIds: 'r_a,r_b', ...H, compare: 'none', ...o });

(async () => {
  const w = await world();
  const c = core(w);

  await cell('MS-EQUIV: the merged kpis are the server\'s own merge of both branches\' stored days (B.mergeSummaries + B.avgPaidTicket), and additive over the single responses', async (L) => {
    const r = await c(both(), 'both');
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body)}`);
    const dates = T.datesBetween(H.from, H.to);
    const per = await Promise.all(['r_a', 'r_b'].map((rid) => S.readDailies(w.fs, rid, dates)));
    const m = B.mergeSummaries(per.flatMap((byDate) => dates.map((d) => byDate.get(d)).filter(Boolean)));
    assert.deepStrictEqual([r.body.kpis.sales_cents, r.body.kpis.orders, r.body.kpis.average_paid_ticket_cents], [m.sale.cents, m.sale.orders, B.avgPaidTicket(m.sale)], `${L}: the server's merge`);
    const [a, b] = await Promise.all(['r_a', 'r_b'].map((rid) => c({ restaurantId: rid, ...H, compare: 'none' }, 'both')));
    assert.strictEqual(r.body.kpis.sales_cents, a.body.kpis.sales_cents + b.body.kpis.sales_cents, `${L}: additive sales`);
    assert.strictEqual(r.body.kpis.orders, a.body.kpis.orders + b.body.kpis.orders, `${L}: additive orders`);
    assert.deepStrictEqual(r.body.branches.map((x) => [x.restaurantId, x.kpis]), [['r_a', a.body.kpis], ['r_b', b.body.kpis]], `${L}: the per-branch rows ARE the single answers' kpis`);
    assert.deepStrictEqual(r.body.restaurantIds, ['r_a', 'r_b'], L);
  });
  await cell('MS-AUTH: one branch the member cannot read ⇒ 403 for the whole request, and ZERO reads', async (L) => {
    const log = [];
    const r = await core(w, { log })(both(), 'onlyA');
    assert.deepStrictEqual([r.status, r.body.restaurantId], [403, 'r_b'], `${L}: ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(log, [], `${L}: nothing read (${log.join(',')})`);
  });
  await cell('MS-PARTIAL: one branch unavailable ⇒ 503 (never a partial total)', async (L) => {
    const broken = { collection: (cn) => { const real = w.fs.collection(cn); return { doc: (id) => { if (id === 'r_b') throw new Error('rtdb down'); return real.doc(id); } }; }, runTransaction: w.fs.runTransaction };
    const r = await core(w, { fsdb: broken })(both(), 'both');
    assert.deepStrictEqual([r.status, r.body.error], [503, 'stats_unavailable'], `${L}: ${JSON.stringify(r.body)}`);
  });
  await cell('MS-NO-CUSTOMERS: the multi form omits `customers` (one person at two branches would count twice); the single form keeps it', async (L) => {
    const r = await c(both({ compare: 'previous' }), 'both');
    assert.ok(!('customers' in r.body) && !('customers' in r.body.comparison), L);
    assert.ok('customers' in (await c({ restaurantId: 'r_a', ...H }, 'both')).body, `${L}: single keeps it`);
  });
  await cell('MS-LIVE-COMPARE: a range with today merges the live overlay too; the comparison and its deltas are the merged ones', async (L) => {
    const r = await c(both({ from: '2026-10-15', to: TODAY, compare: 'previous' }), 'both');
    const [a, b] = await Promise.all(['r_a', 'r_b'].map((rid) => c({ restaurantId: rid, from: '2026-10-15', to: TODAY, compare: 'previous' }, 'both')));
    assert.strictEqual(r.body.kpis.sales_cents, a.body.kpis.sales_cents + b.body.kpis.sales_cents, `${L}: period`);
    assert.ok(b.body.comparison.kpis.sales_cents > 0, `${L}: premise — r_b sold in the comparison window`);
    assert.strictEqual(r.body.comparison.kpis.sales_cents, a.body.comparison.kpis.sales_cents + b.body.comparison.kpis.sales_cents, `${L}: comparison`);
    assert.ok(r.body.days.some((d) => d.computed_at === 'live'), `${L}: today is live`);
    assert.ok(r.body.deltas && 'sales_pct' in r.body.deltas, `${L}: deltas`);
  });
  await cell('MS-BOUNDS: 1 id / 21 ids / a duplicate / both forms / a CSV ⇒ 400', async (L) => {
    const st = async (q) => (await c({ ...H, ...q }, 'both')).status;
    assert.strictEqual(await st({ restaurantIds: 'r_a' }), 400, `${L}: one`);
    assert.strictEqual(await st({ restaurantIds: Array.from({ length: 21 }, (_, i) => `r_${i}`).join(',') }), 400, `${L}: 21`);
    assert.strictEqual(await st({ restaurantIds: 'r_a,r_a' }), 400, `${L}: duplicate`);
    assert.strictEqual(await st({ restaurantIds: 'r_a,r_b', restaurantId: 'r_a' }), 400, `${L}: both forms`);
    const csv = await c(both({ format: 'csv' }), 'both');
    assert.deepStrictEqual([csv.status, csv.body.error], [400, 'csv_single_branch'], `${L}: csv`);
  });
  await cell('MS-SINGLE-IDENTICAL: the single-branch answer is byte-identical to the base module\'s (JSON, compare, live, daily CSV, a refusal)', async (L) => {
    const base = core(w, { mod: baseModule() });
    for (const q of [{ restaurantId: 'r_a', ...H }, { restaurantId: 'r_a', from: '2026-10-15', to: TODAY, compare: 'previous_week' }, { restaurantId: 'r_b', ...H, format: 'csv' }, { restaurantId: 'r_b', ...H }]) {
      assert.strictEqual(JSON.stringify(await c(q, 'both')), JSON.stringify(await base(q, 'both')), `${L}: ${JSON.stringify(q)}`);
    }
    assert.strictEqual(JSON.stringify(await c({ restaurantId: 'r_b', ...H }, 'onlyA')), JSON.stringify(await base({ restaurantId: 'r_b', ...H }, 'onlyA')), `${L}: a refusal`);
  });

  __finished = true;
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`stats-multi: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
