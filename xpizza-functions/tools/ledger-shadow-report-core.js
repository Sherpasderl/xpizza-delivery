'use strict';
// LEDGER S6 (PLAN-5f-ledger-shadow-s1-r1 §5, r3 table) — the PURE core of the owner's READ-ONLY shadow report. Names / counts / cents only:
// never an order id, a customer, a phone, a driver uid or an attempt id.
//   days          per restaurant × HN service date (stats-time serviceMs: scheduled_for || created_at): stats_daily sale {orders, cents}
//                 vs the ledger {orders, cents} on the SAME cohort (created_at ≥ the ledger start) and the SAME class (stats-classify
//                 isSale on the order at report time); the ledger side counts a sale only when it is PROJECTED, not quarantined, and has
//                 its S1 snapshot — its food = projector foodParts (total − net envío − tip), the formula stats-build uses on the order
//   pre_cohort    sales served in range but created BEFORE the start: stats_daily cannot be split by created_at, so they explain the diff
//   sdk column    an SDK order placed but not captured (not a sale yet): on neither side — auth → capture timing, never a mismatch
//   cash          cash sales, the accrual-only ones (cash_not_evidenced), card_delivery apart (it is not physical cash)
//   driver        S8 closed weeks overlapping the range: drivers / deliveries / net cents / payable / paid — earnings stay OUT of the ledger
//   completeness  cohort orders in range with no projection, quarantine and unresolved by reason, pending (open / unresolved) by age, and
//                 the STALE holds (S5: unchanged > 60 days, out of the open set — ledger/stale) by reason, for a person to resolve
//   coverage      the nightly run records of the range, and the dates with none
// Plain objects only (no Map / Set): the read-only scan in the test stays exact.
const { isSale } = require('../stats/stats-classify');
const ST = require('../stats/stats-time');
const SB = require('../stats/stats-build');
const { foodParts } = require('../ledger/projector');
const DL = require('../driver-ledger/ledger-core');
const { parseEffectiveFrom } = require('./set-driver-rate-core');   // one source: an ISO time, Honduras time when no zone

const MAX_DAYS = 62;
const DAY = ST.DAY_MS;

// argv (without node + script) → { start, from, to, json } | { error }
function parseArgs(argv) {
  const known = { '--project': 1, '--start': 1, '--from': 1, '--to': 1, '--json': 0 };
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const eq = a.indexOf('='); const name = eq > 0 ? a.slice(0, eq) : a;
    if (!(name in known)) return { error: `unknown argument ${a} (this report is read-only)` };
    if (!known[name]) { if (eq > 0) return { error: `${name} takes no value` }; out.json = true; continue; }
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined) return { error: `${name} needs a value` };
    out[name.slice(2)] = v;
  }
  if (out.start === undefined) return { error: '--start is required: the ledger start (the S1 deploy time; ISO, Honduras time when no zone)' };
  const start = parseEffectiveFrom(out.start);
  if (start === null) return { error: `--start ${JSON.stringify(out.start)} is not a valid ISO date / time` };
  if (!ST.isDate(out.from) || !ST.isDate(out.to)) return { error: '--from and --to are required: YYYY-MM-DD (HN service dates)' };
  if (out.from > out.to) return { error: '--from is after --to' };
  if (ST.daysBetween(out.from, out.to) + 1 > MAX_DAYS) return { error: `at most ${MAX_DAYS} days per report` };
  return { start, from: out.from, to: out.to, json: out.json };
}

const time = (x) => Number.isSafeInteger(x) && x > 0;
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };
const orderFood = (o) => (Number.isSafeInteger(o.total_cents) ? o.total_cents : 0) - SB.envioNetCents(o) - SB.tipCents(o);   // stats-build addSale

function buildReport({ start, from, to, now, orders, snapshots, projections, open, runs, stats, weeks, stale }) {
  if (from <= ST.dateOf(start)) throw new Error(`--from must be after the ledger start day ${ST.dateOf(start)} (a partial first day cannot be matched)`);
  const dates = ST.datesBetween(from, to);
  const inRange = {}; for (const d of dates) inRange[d] = true;
  const rows = {};
  const row = (rid, date) => {
    const k = `${rid}|${date}`;
    return rows[k] || (rows[k] = { rid, date, stats: { orders: 0, cents: 0 }, ledger: { orders: 0, cents: 0 }, pre_cohort: { orders: 0, cents: 0 }, sdk_placed_not_captured: 0 });
  };
  for (const [rid, byDate] of Object.entries(stats || {})) {
    for (const [date, s] of Object.entries(byDate || {})) {
      if (!inRange[date]) continue;
      const r = row(rid, date); r.stats.orders += (s && s.sale && s.sale.orders) || 0; r.stats.cents += (s && s.sale && s.sale.cents) || 0;
    }
  }
  const cash = { cash_sales: 0, accrual_only: 0, card_delivery_sales: 0 };
  const completeness = { not_projected: 0, no_snapshot: 0, quarantined: {}, unresolved: {}, stale_hold: {}, pending_age: { under_1d: 0, d1_7: 0, d7_21: 0, over_21d: 0 } };
  for (const [id, o] of Object.entries(orders || {})) {
    if (!o || typeof o !== 'object') continue;
    const ms = ST.serviceMs(o); if (ms === null) continue;
    const date = ST.dateOf(ms); if (!inRange[date]) continue;
    const r = row(SB.ridOf(o), date); const sale = isSale(o);
    if (!(time(o.created_at) && o.created_at >= start)) { if (sale) { r.pre_cohort.orders += 1; r.pre_cohort.cents += orderFood(o); } continue; }
    if (o.payment_flow === 'sdk_auth_v1' && o.payment_placed && !sale) r.sdk_placed_not_captured += 1;
    const p = projections && projections[id];
    if (!p) { completeness.not_projected += 1; continue; }
    if (!sale) continue;
    if (o.payment_method === 'cash') { cash.cash_sales += 1; if ((p.reasons || []).includes('cash_not_evidenced')) cash.accrual_only += 1; }
    if (o.payment_method === 'card_delivery') cash.card_delivery_sales += 1;
    const snap = snapshots && snapshots[id];
    if (p.status === 'quarantined') continue;
    if (!snap) { completeness.no_snapshot += 1; continue; }
    r.ledger.orders += 1; r.ledger.cents += foodParts(snap).food;
  }
  for (const id of Object.keys(stale || {})) { const p = projections && projections[id]; for (const why of (p && p.reasons) || ['unknown']) inc(completeness.stale_hold, why); }
  for (const [id, p] of Object.entries(projections || {})) {
    if (!p) continue;
    if (p.status === 'quarantined') for (const why of p.reasons || []) inc(completeness.quarantined, why);
    if (p.status === 'unresolved') for (const why of p.reasons || []) inc(completeness.unresolved, why);
    if (p.status === 'open' || p.status === 'unresolved') {
      const o = orders && orders[id]; const age = o && time(o.created_at) ? now - o.created_at : null;
      if (age === null) continue;
      inc(completeness.pending_age, age < DAY ? 'under_1d' : age < 7 * DAY ? 'd1_7' : age < 21 * DAY ? 'd7_21' : 'over_21d');
    }
  }
  const days = Object.values(rows).sort((a, b) => (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((r) => ({ ...r, diff: { orders: r.stats.orders - r.ledger.orders, cents: r.stats.cents - r.ledger.cents } }));
  const lo = ST.dayStartMs(from); const hi = ST.dayEndMs(to);
  const overlaps = (key) => { if (!DL.WEEK_RE.test(key)) return false; const b = DL.weekBounds(key); return b.start < hi && b.end > lo; };
  const driver = Object.keys(weeks || {}).sort().filter(overlaps).map((key) => {
    const ds = Object.values((weeks[key] && weeks[key].drivers) || {});
    return { week: key, drivers: ds.length, deliveries: ds.reduce((s, d) => s + DL.list(d && d.deliveries).length, 0),
      net_cents: ds.reduce((s, d) => s + (d && Number.isSafeInteger(d.net_cents) ? d.net_cents : 0), 0),
      payable: ds.filter((d) => d && d.outcome === 'payable').length, paid: ds.filter((d) => d && d.paid).length };
  });
  const has = (d) => !!(runs && runs[d]);
  const missing = dates.filter((d) => !has(d));
  const runList = dates.filter(has).map((d) => { const x = runs[d]; return { date: d, finished: time(x.finished_at), attempt: x.attempt || null, stopped: x.stopped || null, counts: x.counts || {} }; });
  return { cohort: { start, start_day: ST.dateOf(start), from, to }, days, cash, driver, completeness, coverage: { runs: runList, missing_run_dates: missing } };
}

module.exports = { parseArgs, buildReport, MAX_DAYS };
