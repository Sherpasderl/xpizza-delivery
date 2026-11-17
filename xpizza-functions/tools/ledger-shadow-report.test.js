'use strict';
// LEDGER S6 (PLAN-5f-ledger-shadow-s1-r1 §5, r3 table) — the owner's READ-ONLY shadow report, names / counts only. Both sides on the SAME
// cohort (created_at ≥ the ledger start), the same restaurants and the same HN service date: stats_daily (built here by the REAL
// stats/stats-build buildDailies) vs the ledger (projections made by the REAL S5 runNightly over the honest model; food from the S1
// snapshots). Plus the SDK placed-not-captured column, cash coverage (card_delivery apart), S8 driver weeks side by side, completeness and
// the nightly run's coverage. Run: node tools/ledger-shadow-report.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHonestDb } = require('../_honest-rtdb-model');
const LA = require('../ledger/alloc-snapshot');
const RB = require('../ledger/rebuild');
const B = require('../stats/stats-build');
const { makeCustomerKeyer } = require('../stats/stats-identity');
const C = require('./ledger-shadow-report-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
async function cell(label, fn) { try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }

const DAY = 86400000; const HR = 3600000;
const START = Date.parse('2026-11-10T12:00:00Z');                 // the ledger start (S1 deploy), mid-day 11-10 HN
const NOW = Date.parse('2026-11-20T09:00:00Z');                   // 03:00 HN on 11-20
const D1 = Date.parse('2026-11-12T18:00:00Z');                    // 12:00 HN on 11-12
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return Object.keys(o).length ? o : null; };
const APP = LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: { app: 'capp', deployment: 'orders-app' } });
const money = (x) => ({ total_cents: 20000, subtotal_cents: 17000, tax_cents: 0, delivery_cents: 3000, tip_cents: 500, order_type: 'delivery', ...x });
const alloc = (o) => stored(LA.snapshotOf(o, APP));
const ord = (id, x) => ({ order_id: id, restaurant_id: 'x_pizza', created_at: D1, status: 'delivered', delivered_at: D1 + HR, ...money({}), ...x });
const RATES = { commission: { _default: { k1: { bp: 1000, effective_from: Date.parse('2026-01-02T00:00:00Z') } } } };

function world() {
  const orders = {
    CASH1: ord('CASH1', { payment_method: 'cash' }),
    CARD1: ord('CARD1', { payment_method: 'online', payment_status: 'confirmed', active_attempt_id: 'a1', total_cents: 29900, subtotal_cents: 25000, delivery_cents: 5000, promo_discount_cents: 1000, tip_cents: 900 }),
    CDEL: ord('CDEL', { payment_method: 'card_delivery' }),
    GONE: ord('GONE', { payment_method: 'cash', status: 'cancelled', delivered_at: null, cancelled_at: D1 + HR }),
    SDK1: ord('SDK1', { payment_method: 'online', payment_flow: 'sdk_auth_v1', status: 'pending_payment', delivered_at: null, payment_placed: { leg_id: 'l1', at: D1 } }),
    PRE: ord('PRE', { payment_method: 'cash', created_at: START - 2 * DAY, scheduled_for: D1 }),                 // created BEFORE the start, served in range
    NOPROJ: ord('NOPROJ', { payment_method: 'cash', created_at: D1 + 2 * HR }),                                   // a cohort sale the ledger never projected
  };
  const ledger_alloc = {}; for (const id of ['CASH1', 'CDEL', 'GONE', 'PRE', 'NOPROJ']) ledger_alloc[id] = alloc({ ...orders[id] });
  const payment_attempts = { a1: { order_id: 'CARD1', hosted_state: 'paid', paid_amount_cents: 29900, paid_at: D1 + 60000, ledger: alloc({ ...orders.CARD1 }) } };
  return { orders, ledger_alloc, payment_attempts, ledger_settings: RATES };
}
// the ledger side exactly as the CLI assembles it: S5 projections + the snapshots readSources selects
async function ledgerSide(w, { skip = [] } = {}) {
  const db = makeHonestDb(w, { now: () => NOW });
  await RB.runNightly({ db, clock: () => NOW }, { slot: 'run' });
  for (const id of skip) { db.setAt(`ledger/orders/${id}`, null); db.setAt(`ledger/open/${id}`, null); }
  const snapshots = {}; for (const id of Object.keys(w.orders)) snapshots[id] = (await RB.readSources(db, id)).alloc;
  return { projections: db.getAt('ledger/orders') || {}, open: db.getAt('ledger/open') || {}, runs: db.getAt('ledger/run') || {}, snapshots };
}
const keyer = makeCustomerKeyer('k'.repeat(40));
const statsOf = (orders, dates) => { const m = B.buildDailies(Object.values(orders), { keyer, restaurants: new Set(['x_pizza']), dates: new Set(dates) }); const out = {}; for (const [rid, byDate] of m) { out[rid] = {}; for (const [d, s] of byDate) out[rid][d] = s; } return out; };
const ARGS = { start: START, from: '2026-11-12', to: '2026-11-12', now: NOW };

(async () => {
  await cell('LSR-MATCH: on the same cohort / restaurant / service date, the ledger food (S1 snapshots) of every sale equals stats_daily sale.cents (both exclude net envío and tip) — a matched day has zero difference', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.NOPROJ; delete w.ledger_alloc.PRE; delete w.ledger_alloc.NOPROJ;
    const L = await ledgerSide(w);
    const r = C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L, weeks: {} });
    const row = r.days.find((d) => d.rid === 'x_pizza' && d.date === '2026-11-12');
    assert.deepStrictEqual([row.stats.orders, row.ledger.orders], [3, 3], `🔴 LSR-MATCH: sales counted alike (cash, card, card_delivery) ${JSON.stringify(row)}`);
    assert.deepStrictEqual([row.ledger.cents, row.diff.orders, row.diff.cents], [row.stats.cents, 0, 0], `🔴 LSR-MATCH: ledger food = stats cents (${JSON.stringify(row)})`);
    assert.strictEqual(row.ledger.cents, (20000 - 3000 - 500) * 2 + (29900 - 4000 - 900), '🔴 LSR-MATCH: food = total − net envío − tip per sale');
  });

  await cell('LSR-COHORT: an order created BEFORE the ledger start never counts on the ledger side; one served in range is reported in pre_cohort (the stats side cannot be split); a range starting on or before the start day is refused', async () => {
    const w = world(); delete w.orders.NOPROJ; delete w.ledger_alloc.NOPROJ;
    const L = await ledgerSide(w);
    const r = C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L, weeks: {} });
    const row = r.days.find((d) => d.date === '2026-11-12');
    assert.deepStrictEqual([row.ledger.orders, row.pre_cohort.orders, row.stats.orders], [3, 1, 4], `🔴 LSR-COHORT: ${JSON.stringify(row)}`);
    assert.deepStrictEqual([row.diff.orders, row.diff.cents], [1, 16500], 'the difference is exactly the pre-cohort order, and the row says so');
    assert.throws(() => C.buildReport({ ...ARGS, from: '2026-11-10', orders: {}, stats: {}, projections: {}, open: {}, runs: {}, snapshots: {}, weeks: {} }), /after the ledger start day/, '🔴 LSR-COHORT: a partial first day is refused');
  });

  await cell('LSR-SDK: an SDK order placed but not captured is its own column, on neither side (auth → capture timing, never a mismatch)', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.NOPROJ;
    const L = await ledgerSide(w);
    const row = C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L, weeks: {} }).days[0];
    assert.deepStrictEqual([row.sdk_placed_not_captured, row.diff.orders], [1, 0], `🔴 LSR-SDK: ${JSON.stringify(row)}`);
  });

  await cell('LSR-COMPLETENESS: a cohort sale with no projection is a gap (and its food is missing from the ledger side, never invented); quarantine and unresolved by reason; pending (open / unresolved) by age', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.SDK1;   // SDK1 (no record here) would add an unrelated no_snapshot quarantine
    const L = await ledgerSide(w, { skip: ['NOPROJ'] });
    L.projections.Q1 = { status: 'quarantined', reasons: ['app_pickup_cash'] }; w.orders.Q1 = ord('Q1', { payment_method: 'cash', order_type: 'pickup' });
    L.projections.U1 = { status: 'unresolved', reasons: ['capture_unproven'] }; L.open.U1 = true; w.orders.U1 = ord('U1', { payment_method: 'online', status: 'preparing', created_at: NOW - 9 * DAY });
    const r = C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L, weeks: {} });
    assert.strictEqual(r.completeness.not_projected, 1, `🔴 LSR-COMPLETENESS: the gap ${JSON.stringify(r.completeness)}`);
    assert.deepStrictEqual([r.completeness.quarantined, r.completeness.unresolved], [{ app_pickup_cash: 1 }, { capture_unproven: 1 }], '🔴 LSR-COMPLETENESS: by reason');
    assert.deepStrictEqual(r.completeness.pending_age, { under_1d: 0, d1_7: 0, d7_21: 1, over_21d: 0 }, '🔴 LSR-COMPLETENESS: pending by age');
    const row = r.days.find((d) => d.date === '2026-11-12');
    assert.ok(row.diff.orders >= 1 && row.diff.cents >= 16500, `🔴 LSR-COMPLETENESS: the gap shows as a difference ${JSON.stringify(row)}`);
  });

  await cell('LSR-CASH: cash sales and the accrual-only ones (no collection evidence: cash_not_evidenced) are counted; card_delivery is NOT physical cash', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.NOPROJ;
    const L = await ledgerSide(w);
    const r = C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L, weeks: {} });
    assert.deepStrictEqual(r.cash, { cash_sales: 1, accrual_only: 1, card_delivery_sales: 1 }, `🔴 LSR-CASH: ${JSON.stringify(r.cash)}`);
  });

  await cell('LSR-DRIVER: S8 closed weeks overlapping the range, side by side — drivers, deliveries, net cents, payable / paid counts; no driver id', async () => {
    const weeks = { 'W2026-11-09': { week: 'W2026-11-09', drivers: { u1: { deliveries: ['CASH1', 'CARD1'], net_cents: 14000, outcome: 'payable', paid: { amount_cents: 14000 } }, u2: { deliveries: ['CDEL'], net_cents: 7000, outcome: 'payable' } } },
      'W2026-09-28': { week: 'W2026-09-28', drivers: { u9: { deliveries: ['X'], net_cents: 7000, outcome: 'payable' } } } };
    const r = C.buildReport({ ...ARGS, orders: {}, stats: {}, projections: {}, open: {}, runs: {}, snapshots: {}, weeks });
    assert.deepStrictEqual(r.driver, [{ week: 'W2026-11-09', drivers: 2, deliveries: 3, net_cents: 21000, payable: 2, paid: 1 }], `🔴 LSR-DRIVER: ${JSON.stringify(r.driver)}`);
  });

  await cell('LSR-COVERAGE + NO-PII: the nightly run records of the range (finished / stopped / counts) are listed; the report carries no order id, customer, phone, uid or attempt id', async () => {
    const w = world(); w.orders.CASH1.customer_name = 'Ana Cliente'; w.orders.CASH1.customer_phone = '+50499998888';
    const L = await ledgerSide(w);
    const r = C.buildReport({ ...ARGS, to: '2026-11-20', orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L, weeks: { 'W2026-11-09': { drivers: { uSECRET: { deliveries: ['CASH1'], net_cents: 7000, outcome: 'payable' } } } } });
    assert.deepStrictEqual(r.coverage.runs.map((x) => [x.date, x.finished, x.counts.touched]), [['2026-11-20', true, L.runs['2026-11-20'].counts.touched]], `🔴 LSR-COVERAGE: ${JSON.stringify(r.coverage)}`);
    assert.deepStrictEqual(r.coverage.missing_run_dates.length, 8, '🔴 LSR-COVERAGE: the dates with no run record are listed (11-12 … 11-19)');
    const s = JSON.stringify(r);
    for (const bad of ['CASH1', 'CARD1', 'Ana', '9999', 'uSECRET', 'a1']) assert.ok(!s.includes(`"${bad}`) && !s.includes(bad === 'a1' ? '"a1"' : bad), `🔴 LSR-NO-PII: ${bad} in the report`);
  });

  await cell('LSR-CLI: the project guard first, then the arguments, both before any client (the platform CLI contract); the CLI refuses without --project; the CLI and core never write (no set / update / push / remove / transaction)', async () => {
    assert.deepStrictEqual(C.parseArgs(['--project', 'x', '--start', '2026-11-10T12:00:00Z', '--from', '2026-11-12', '--to', '2026-11-13']), { start: START, from: '2026-11-12', to: '2026-11-13', json: false });
    for (const a of [['--from', '2026-11-12'], ['--start', 'nope', '--from', '2026-11-12', '--to', '2026-11-13'], ['--start', '2026-11-10', '--from', '2026-11-13', '--to', '2026-11-12'], ['--start', '2026-11-10', '--from', '2026-11-12', '--to', '2026-11-13', '--apply']]) {
      assert.ok(C.parseArgs(a).error, `🔴 LSR-CLI: accepted ${a.join(' ')}`);
    }
    const cli = fs.readFileSync(path.join(__dirname, 'ledger-shadow-report.js'), 'utf8');
    const iParse = cli.indexOf('parseArgs(process.argv'); const iGuard = cli.indexOf('requireProject({'); const iAdmin = cli.indexOf("require('firebase-admin')");
    assert.ok(iGuard > 0 && iGuard < iParse && iParse < iAdmin, '🔴 LSR-CLI: requireProject → parseArgs → firebase-admin, in that order');
    for (const f of ['ledger-shadow-report.js', 'ledger-shadow-report-core.js']) {
      const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert.ok(!/\.(set|update|push|remove|transaction|delete|add|create)\(/.test(s), `🔴 LSR-CLI: ${f} writes (no Map / Set either: plain objects keep this scan exact)`);
    }
    const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json' };
    delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, [path.join(__dirname, 'ledger-shadow-report.js'), '--start', '2026-11-10T12:00:00Z', '--from', '2026-11-12', '--to', '2026-11-13'], { env, encoding: 'utf8', timeout: 20000 });
    assert.ok(r.status !== 0 && !/LEDGER SHADOW REPORT/.test(r.stdout), `🔴 LSR-CLI: refuses without --project (${r.status})`);
    const envProd = { ...env }; delete envProd.FIREBASE_DATABASE_EMULATOR_HOST;
    const r2 = spawnSync(process.execPath, [path.join(__dirname, 'ledger-shadow-report.js'), '--project', require('./require-project').expectedProject(), '--from', '2026-11-12'], { env: envProd, encoding: 'utf8', timeout: 20000 });
    assert.ok(r2.status === 2 && /--start/.test(r2.stderr) && !/LEDGER SHADOW REPORT/.test(r2.stdout), `🔴 LSR-CLI: a bad argument exits 2 before any client (${r2.status} ${r2.stderr})`);
  });
  console.log(`\nledger-shadow-report: OK (${n})`);
})().catch((e) => { console.error('ledger-shadow-report FAILED:', e && e.message); process.exit(1); });
