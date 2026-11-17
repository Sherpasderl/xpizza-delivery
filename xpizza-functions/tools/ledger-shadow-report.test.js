'use strict';
// LEDGER S6 (PLAN-5f-ledger-shadow-s1-r1 §5, r3 table; Codex #118 r1) — the owner's READ-ONLY shadow report, names / counts only. STATS side:
// stats_daily as the REAL stats/stats-build buildDailies builds it (published after the day); LEDGER side: the PERSISTED journals of the
// projections the REAL S5 runNightly writes over the honest model (SDK orders through the REAL coordinator). Each row is match / mismatch /
// not comparable; bridges are explicit. Run: node tools/ledger-shadow-report.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHonestDb } = require('../_honest-rtdb-model');
const LA = require('../ledger/alloc-snapshot');
const RB = require('../ledger/rebuild');
const B = require('../stats/stats-build');
const { makeCustomerKeyer } = require('../stats/stats-identity');
const { isSale } = require('../stats/stats-classify');
const C = require('./ledger-shadow-report-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
async function cell(label, fn) { try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }

const DAY = 86400000; const HR = 3600000;
const START = Date.parse('2026-11-10T12:00:00Z');                 // the ledger start (S1 deploy), mid-day 11-10 HN
const NOW = Date.parse('2026-11-20T09:00:00Z');                   // 03:00 HN on 11-20
const D1 = Date.parse('2026-11-12T18:00:00Z');                    // 12:00 HN on 11-12
const clone = (v) => JSON.parse(JSON.stringify(v));
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return Object.keys(o).length ? o : null; };
const APP = LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: { app: 'capp', deployment: 'orders-app' } });
const money = (x) => ({ total_cents: 20000, subtotal_cents: 17000, tax_cents: 0, delivery_cents: 3000, tip_cents: 500, order_type: 'delivery', ...x });
const alloc = (o) => stored(LA.snapshotOf(o, APP));
const ord = (id, x) => ({ order_id: id, restaurant_id: 'x_pizza', created_at: D1, status: 'delivered', delivered_at: D1 + HR, ...money({}), ...x });
const RATES = { commission: { _default: { k1: { bp: 1000, effective_from: Date.parse('2026-01-02T00:00:00Z') } } } };
const FOOD = 20000 - 3000 - 500; const CARD_FOOD = 29900 - 4000 - 900;

function world() {
  const orders = {
    CASH1: ord('CASH1', { payment_method: 'cash' }),
    CARD1: ord('CARD1', { payment_method: 'online', payment_status: 'confirmed', active_attempt_id: 'a1', total_cents: 29900, subtotal_cents: 25000, delivery_cents: 5000, promo_discount_cents: 1000, tip_cents: 900 }),
    CDEL: ord('CDEL', { payment_method: 'card_delivery' }),
    GONE: ord('GONE', { payment_method: 'cash', status: 'cancelled', delivered_at: null, cancelled_at: D1 + HR }),
    PRE: ord('PRE', { payment_method: 'cash', created_at: START - 2 * DAY, scheduled_for: D1 }),                 // created BEFORE the start, served in range
    NOPROJ: ord('NOPROJ', { payment_method: 'cash', created_at: D1 + 2 * HR }),                                   // a cohort sale the ledger never projected
  };
  const ledger_alloc = {}; for (const id of ['CASH1', 'CDEL', 'GONE', 'PRE', 'NOPROJ']) ledger_alloc[id] = alloc({ ...orders[id] });
  const payment_attempts = { a1: { order_id: 'CARD1', hosted_state: 'paid', paid_amount_cents: 29900, paid_at: D1 + 60000, ledger: alloc({ ...orders.CARD1 }) } };
  return { orders, ledger_alloc, payment_attempts, ledger_settings: RATES };
}
// the ledger side exactly as the CLI assembles it: S5 projections (journals included) + the sources readSources selects
async function ledgerOf(db, ids, { skip = [] } = {}) {
  for (const id of skip) { db.setAt(`ledger/orders/${id}`, null); db.setAt(`ledger/open/${id}`, null); }
  const snapshots = {}; const sdk = {};
  for (const id of ids) { const s = await RB.readSources(db, id); snapshots[id] = s.alloc; if (s.sdk) sdk[id] = s.sdk; }
  return { projections: db.getAt('ledger/orders') || {}, open: db.getAt('ledger/open') || {}, stale: db.getAt('ledger/stale') || {}, runs: db.getAt('ledger/run') || {}, snapshots, sdk };
}
async function ledgerSide(w, opts) {
  const db = makeHonestDb(w, { now: () => NOW });
  await RB.runNightly({ db, clock: () => NOW }, { slot: 'run' });
  return ledgerOf(db, Object.keys(w.orders), opts);
}
const keyer = makeCustomerKeyer('k'.repeat(40));
// stats_daily as published: the real builder's summary + the publication's computed_at (after the day ended)
const statsOf = (orders, dates, computedAt = NOW) => { const m = B.buildDailies(Object.values(orders), { keyer, restaurants: new Set(['x_pizza']), dates: new Set(dates) }); const out = {}; for (const [rid, byDate] of m) { out[rid] = {}; for (const [d, s] of byDate) out[rid][d] = { ...s, computed_at: computedAt }; } return out; };
const ARGS = { start: START, from: '2026-11-12', to: '2026-11-12', now: NOW, weeks: {} };
const row = (r, date = '2026-11-12') => r.days.find((d) => d.rid === 'x_pizza' && d.date === date);
const jOf = (p, fam) => Object.entries(p.journals).find(([, j]) => j.family === fam);

(async () => {
  await cell('LSR-MATCH: on the same cohort / restaurant / completed service date, the PERSISTED journals (card collection food; cash bridged by its checked commission) equal stats_daily sale — status match, zero difference', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.NOPROJ;
    const L = await ledgerSide(w);
    const r = row(C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L }));
    assert.deepStrictEqual([r.status, r.diff], ['match', { orders: 0, cents: 0 }], `🔴 LSR-MATCH: ${JSON.stringify(r)}`);
    assert.deepStrictEqual([r.ledger, r.cash_bridged], [{ orders: 3, cents: 2 * FOOD + CARD_FOOD }, { orders: 2, cents: 2 * FOOD }], '🔴 LSR-MATCH: card from its journal, cash + card_delivery bridged');
  });

  await cell('LSR-JOURNALS: the ledger side is the PERSISTED journals, never the snapshot (#118 #1) — a wrong, missing, duplicated or unbalanced journal with the snapshot and status kept ⇒ mismatch with its fault', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.NOPROJ;
    const L = await ledgerSide(w); const S = statsOf(w.orders, ['2026-11-12']);
    const run = (mut) => { const P = clone(L.projections); mut(P); return row(C.buildReport({ ...ARGS, orders: w.orders, stats: S, ...L, projections: P })); };
    const wrong = run((P) => { const [, j] = jOf(P.CARD1, 'collection'); for (const l of j.lines) { if (l.account === 'restaurant_payable') l.cr -= 100; if (l.account === 'processor_receivable') l.dr -= 100; } });
    assert.deepStrictEqual([wrong.status, wrong.diff.cents, wrong.journal_faults], ['mismatch', 100, { collection_amount: 1 }], `🔴 LSR-JOURNALS: a wrong collection (${JSON.stringify(wrong)})`);
    const gone = run((P) => { delete P.CARD1.journals[jOf(P.CARD1, 'collection')[0]]; });
    assert.deepStrictEqual([gone.status, gone.diff.orders, gone.journal_faults.collection_missing], ['mismatch', 1, 1], `🔴 LSR-JOURNALS: a missing collection (${JSON.stringify(gone)})`);
    const dup = run((P) => { const [, j] = jOf(P.CARD1, 'collection'); P.CARD1.journals.dup0000 = { ...clone(j), id: 'dup0000' }; });
    assert.deepStrictEqual([dup.status, dup.diff.cents, dup.journal_faults.collection_amount], ['mismatch', -CARD_FOOD, 1], `🔴 LSR-JOURNALS: a duplicated collection (${JSON.stringify(dup)})`);
    const noComm = run((P) => { delete P.CASH1.journals[jOf(P.CASH1, 'commission')[0]]; });
    assert.deepStrictEqual([noComm.status, noComm.diff.orders, noComm.journal_faults], ['mismatch', 1, { commission: 1 }], `🔴 LSR-JOURNALS: cash without its commission journal is not bridged (${JSON.stringify(noComm)})`);
    const unbal = run((P) => { const [, j] = jOf(P.CARD1, 'commission'); j.lines[0].dr += 1; });
    assert.ok(unbal.status === 'mismatch' && unbal.journal_faults.unbalanced === 1, `🔴 LSR-JOURNALS: an unbalanced journal (${JSON.stringify(unbal.journal_faults)})`);
  });

  await cell('LSR-SDK: capture is decided from the SDK record\'s legs (#118 #2) — the REAL coordinator: placed + materialized (a stats sale) but not captured ⇒ the sdk_authorized_not_captured bridge, match; captured at delivery ⇒ its collection journal, match; cancelled ⇒ on neither side', async () => {
    const { makeAdapter } = require('../payments/sdk/psp-adapter'); const { makeFakePsp } = require('../payments/sdk/fake-adapter'); const CO = require('../payments/sdk/coordinator');
    const mk = () => {
      let t = D1;
      const o = { restaurant_id: 'x_pizza', payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'delivery', hub_lat: 14.1, hub_lng: -87.2, items: [{ name: 'tb_item', qty: 1, unit: 100 }], items_text: '1x tb_item', lat: 14.08, lng: -87.19, address_detected: 'tb calle 1', address_details: 'tb casa azul', customer_name: 'tb Cliente', customer_phone: '+50499990000', restaurant_name: 'tb R', restaurant_phone: '+50400000000', total: 100, total_cents: 10000, created_at: t };
      const db = makeHonestDb({ orders: { S: o }, ledger_settings: RATES }, { now: () => t });
      const goLive = (dp, id) => require('../pixelpay-confirm').confirmAndMaterialize({ db, buildMaterializeUpdates: require('../materialize').buildMaterializeUpdates, restaurant: { lat: 14.1, lng: -87.2, name: 'tb R', phone: '+50400000000' } }, { orderId: id, attemptId: null, now: t, trackingToken: 'TT-tb', sdkGoLive: true });
      const deps = { db, psp: makeAdapter(makeFakePsp({}, {}).impl), clock: () => t, voidEligible: () => false, releaseResources: async () => {}, goLive };
      return { db, deps, set: (x) => { t = x; } };
    };
    const report = async (w, at) => { w.set(at); await RB.runNightly({ db: w.db, clock: () => at }, { slot: 'run' }); const orders = { S: w.db.getAt('orders/S') }; return row(C.buildReport({ ...ARGS, now: at, orders, stats: statsOf(orders, ['2026-11-12'], at), ...(await ledgerOf(w.db, ['S'])) })); };
    const w = mk();
    await CO.placeOriginal(w.deps, { attempt_id: 'att_fixed_c00008', orderId: 'S', token: 'T-tb-token', amount_cents: 10000 });
    assert.ok(isSale(w.db.getAt('orders/S')) && !Object.values(w.db.getAt('payment_sdk/S/legs')).some((l) => l.state === 'captured'), 'premise: the real go-live is a stats sale with an authorized, uncaptured leg');
    const placed = await report(w, NOW);
    assert.deepStrictEqual([placed.status, placed.bridges.sdk_authorized_not_captured.orders, placed.ledger.orders], ['match', 1, 0], `🔴 LSR-SDK: placed, not captured (${JSON.stringify(placed)})`);
    await w.db.ref('orders/S/status').set('delivered'); await CO.settleTerminal(w.deps, { orderId: 'S' });
    const cap = await report(w, NOW + DAY);
    assert.deepStrictEqual([cap.status, cap.bridges.sdk_authorized_not_captured.orders, cap.ledger.orders], ['match', 0, 1], `🔴 LSR-SDK: captured (${JSON.stringify(cap)})`);
    const w2 = mk();
    await CO.placeOriginal(w2.deps, { attempt_id: 'att_fixed_c00009', orderId: 'S', token: 'T-tb-token', amount_cents: 10000 });
    await CO.cancelSdkOrder(w2.deps, { orderId: 'S', kind: 'cancel' });
    const can = await report(w2, NOW);
    assert.deepStrictEqual([can.status, can.stats.orders, can.ledger.orders, can.bridges.sdk_authorized_not_captured.orders], ['match', 0, 0, 0], `🔴 LSR-SDK: cancelled (${JSON.stringify(can)})`);
  });

  await cell('LSR-COHORT: validated pre-cohort sales (created before --start, served in range) are SUBTRACTED from the stats side (#118 #3), the raw value kept — the day still matches; a partial first day or an incomplete --to is refused', async () => {
    const w = world(); delete w.orders.NOPROJ;
    const L = await ledgerSide(w);
    const r = row(C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L }));
    assert.deepStrictEqual([r.stats_raw.orders, r.pre_cohort, r.stats.orders, r.status], [4, { orders: 1, cents: FOOD }, 3, 'match'], `🔴 LSR-COHORT: ${JSON.stringify(r)}`);
    const none = { orders: {}, stats: {}, projections: {}, open: {}, stale: {}, runs: {}, snapshots: {}, sdk: {} };
    assert.throws(() => C.buildReport({ ...ARGS, ...none, from: '2026-11-10' }), /after the ledger start day/, '🔴 LSR-COHORT: a partial first day');
    assert.throws(() => C.buildReport({ ...ARGS, ...none, to: '2026-11-20' }), /COMPLETED HN day/, '🔴 LSR-COHORT: an incomplete last day');
  });

  await cell('LSR-NOT-COMPARABLE: missing stats, stats published before the day ended, or no finished nightly run after the day ended ⇒ not comparable, NO difference printed (#118 #4)', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.NOPROJ;
    const L = await ledgerSide(w); const S = statsOf(w.orders, ['2026-11-12']);
    const missing = row(C.buildReport({ ...ARGS, orders: w.orders, stats: {}, ...L }));
    assert.deepStrictEqual([missing.status, missing.not_comparable, missing.diff], ['not_comparable', ['stats_missing'], null], `🔴 LSR-NOT-COMPARABLE: missing (${JSON.stringify(missing)})`);
    const early = row(C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12'], D1 + HR), ...L }));
    assert.deepStrictEqual([early.status, early.not_comparable], ['not_comparable', ['stats_stale']], '🔴 LSR-NOT-COMPARABLE: stale stats');
    const noRun = row(C.buildReport({ ...ARGS, orders: w.orders, stats: S, ...L, runs: { '2026-11-12': { started_at: D1 - HR, finished_at: D1 } } }));
    assert.deepStrictEqual([noRun.status, noRun.not_comparable], ['not_comparable', ['ledger_not_rebuilt']], '🔴 LSR-NOT-COMPARABLE: no rebuild after the day');
  });

  await cell('LSR-BUDGET: a read over 5,000 records or a run over 120 s refuses «report incomplete: budget exceeded» (#118 #5); the CLI bounds every query and checks every read', async () => {
    assert.ok(/budget exceeded/.test(C.overBudget({ records: 5001, elapsedMs: 0 }) || ''), '🔴 LSR-BUDGET: records');
    assert.ok(/budget exceeded/.test(C.overBudget({ records: 1, elapsedMs: 120001 }) || ''), '🔴 LSR-BUDGET: time');
    assert.strictEqual(C.overBudget({ records: 5000, elapsedMs: 120000 }), null, 'at the limits is fine');
    const cli = fs.readFileSync(path.join(__dirname, 'ledger-shadow-report.js'), 'utf8');
    const queries = (cli.match(/\.orderBy(Child|Key)\(/g) || []).length;
    assert.ok(queries >= 4 && (cli.match(/\.limitToFirst\(C\.MAX_RECORDS \+ 1\)/g) || []).length === queries, '🔴 LSR-BUDGET: every query is bounded');
    assert.ok(/const check = \(records\) => \{[^\n]*C\.overBudget\(/.test(cli) && /const read = async \(ref\) => \{[^\n]*\bcheck\(/.test(cli), '🔴 LSR-BUDGET: the read helper applies the budget check');
    assert.ok(!/\.once\('value'\)/.test(cli.replace(/const read = async \(ref\) => \{[^\n]*\n/, '')), '🔴 LSR-BUDGET: every direct read goes through the read helper');
  });

  await cell('LSR-SCOPE: completeness counts only the cohort orders served in range (#118 #6); the open set and the stale holds are a separate, global section', async () => {
    const w = world(); delete w.orders.PRE;
    w.orders.U1 = ord('U1', { payment_method: 'online', status: 'preparing', created_at: NOW - 9 * DAY, delivered_at: null, active_attempt_id: 'aU' });
    w.payment_attempts.aU = { order_id: 'U1', status: 'capture_unverified', hosted_state: 'paid', paid_amount_cents: 29900, paid_at: NOW - 9 * DAY, ledger: alloc({ ...w.orders.U1, total_cents: 29900 }) };
    const L = await ledgerSide(w, { skip: ['NOPROJ'] });
    const r = C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L });
    assert.deepStrictEqual([r.in_range.not_projected, r.in_range.unresolved], [1, {}], `🔴 LSR-SCOPE: in range only (${JSON.stringify(r.in_range)})`);
    assert.deepStrictEqual([r.global.open_status, r.global.open_by_age.d7_21], [{ unresolved: 1 }, 1], `🔴 LSR-SCOPE: the global section (${JSON.stringify(r.global)})`);
  });

  await cell('LSR-STALE: a stale hold (a quarantined / unresolved order unchanged > 60 days — S5, ledger/stale) is listed by reason in the global section', async () => {
    const T0 = Date.parse('2026-09-01T18:00:00Z');
    const db = makeHonestDb({ orders: { Q: ord('Q', { payment_method: 'cash', status: 'preparing', delivered_at: null, created_at: T0 }) }, ledger_settings: RATES }, { now: () => T0 });   // no snapshot ⇒ quarantined
    await RB.runNightly({ db, clock: () => T0 }, { slot: 'run' });
    await RB.runNightly({ db, clock: () => T0 + 61 * DAY }, { slot: 'run' });
    assert.deepStrictEqual(db.getAt('ledger/stale'), { Q: true }, 'premise: S5 made it a stale hold');
    const r = C.buildReport({ ...ARGS, orders: { Q: db.getAt('orders/Q') }, stats: {}, ...(await ledgerOf(db, ['Q'])) });
    assert.deepStrictEqual(r.global.stale_hold, { no_snapshot: 1 }, `🔴 LSR-STALE: ${JSON.stringify(r.global)}`);
  });

  await cell('LSR-CASH: cash sales, the accrual-only ones (cash_not_evidenced), the ones awaiting fulfilment (bridged), card_delivery apart', async () => {
    const w = world(); delete w.orders.PRE; delete w.orders.NOPROJ;
    w.orders.CASH2 = ord('CASH2', { payment_method: 'cash', status: 'preparing', delivered_at: null }); w.ledger_alloc.CASH2 = alloc({ ...w.orders.CASH2 });
    const L = await ledgerSide(w);
    const r = C.buildReport({ ...ARGS, orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L });
    assert.deepStrictEqual(r.cash, { cash_sales: 2, accrual_only: 1, awaiting_fulfilment: 1, card_delivery_sales: 1 }, `🔴 LSR-CASH: ${JSON.stringify(r.cash)}`);
    assert.deepStrictEqual([row(r).status, row(r).bridges.cash_awaiting_fulfilment], ['match', { orders: 1, cents: FOOD }], '🔴 LSR-CASH: the awaiting sale is an explicit bridge');
  });

  await cell('LSR-DRIVER: S8 closed weeks overlapping the range, side by side — drivers, deliveries, net cents, payable / paid counts; no driver id', async () => {
    const weeks = { 'W2026-11-09': { drivers: { u1: { deliveries: ['CASH1', 'CARD1'], net_cents: 14000, outcome: 'payable', paid: { amount_cents: 14000 } }, u2: { deliveries: ['CDEL'], net_cents: 7000, outcome: 'payable' } } },
      'W2026-09-28': { drivers: { u9: { deliveries: ['X'], net_cents: 7000, outcome: 'payable' } } } };
    const r = C.buildReport({ ...ARGS, orders: {}, stats: {}, projections: {}, open: {}, stale: {}, runs: {}, snapshots: {}, sdk: {}, weeks });
    assert.deepStrictEqual(r.driver, [{ week: 'W2026-11-09', drivers: 2, deliveries: 3, net_cents: 21000, payable: 2, paid: 1 }], `🔴 LSR-DRIVER: ${JSON.stringify(r.driver)}`);
  });

  await cell('LSR-COVERAGE + NO-PII: the run records of the range and the dates with none; the report carries no order id, customer, phone, uid or attempt id', async () => {
    const w = world(); w.orders.CASH1.customer_name = 'Ana Cliente'; w.orders.CASH1.customer_phone = '+50499998888';
    const L = await ledgerSide(w);
    const r = C.buildReport({ ...ARGS, to: '2026-11-19', orders: w.orders, stats: statsOf(w.orders, ['2026-11-12']), ...L, weeks: { 'W2026-11-09': { drivers: { uSECRET: { deliveries: ['CASH1'], net_cents: 7000, outcome: 'payable' } } } } });
    assert.deepStrictEqual([r.coverage.runs.length, r.coverage.missing_run_dates.length, r.coverage.last_finished_run_start], [0, 8, NOW], `🔴 LSR-COVERAGE: ${JSON.stringify(r.coverage)}`);
    const s = JSON.stringify(r);
    for (const bad of ['CASH1', 'CARD1', 'Ana', '9999', 'uSECRET', '"a1"']) assert.ok(!s.includes(bad), `🔴 LSR-NO-PII: ${bad} in the report`);
  });

  await cell('LSR-CLI: the project guard first, then the arguments, both before any client (the platform CLI contract); refuses without --project; the CLI and core never write', async () => {
    assert.deepStrictEqual(C.parseArgs(['--project', 'x', '--start', '2026-11-10T12:00:00Z', '--from', '2026-11-12', '--to', '2026-11-13']), { start: START, from: '2026-11-12', to: '2026-11-13', json: false });
    for (const a of [['--from', '2026-11-12'], ['--start', 'nope', '--from', '2026-11-12', '--to', '2026-11-13'], ['--start', '2026-11-10', '--from', '2026-11-13', '--to', '2026-11-12'], ['--start', '2026-11-10', '--from', '2026-11-12', '--to', '2026-11-13', '--apply']]) {
      assert.ok(C.parseArgs(a).error, `🔴 LSR-CLI: accepted ${a.join(' ')}`);
    }
    const cli = fs.readFileSync(path.join(__dirname, 'ledger-shadow-report.js'), 'utf8');
    const iParse = cli.indexOf('parseArgs(process.argv'); const iGuard = cli.indexOf('requireProject({'); const iAdmin = cli.indexOf("require('firebase-admin')");
    assert.ok(iGuard > 0 && iGuard < iParse && iParse < iAdmin, '🔴 LSR-CLI: requireProject → parseArgs → firebase-admin, in that order');
    for (const f of ['ledger-shadow-report.js', 'ledger-shadow-report-core.js']) {
      const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert.ok(!/\.(set|update|push|remove|transaction|delete|add|create)\(/.test(s), `🔴 LSR-CLI: ${f} writes (no Map / Set / push either: plain objects keep this scan exact)`);
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
