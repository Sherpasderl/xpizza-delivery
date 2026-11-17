'use strict';
// LEDGER S6 (PLAN-5f-ledger-shadow-s1-r1 §5, r3 table; Codex #118 r1) — the PURE core of the owner's READ-ONLY shadow report. Names / counts /
// cents only: never an order id, a customer, a phone, a driver uid or an attempt id. Plain objects only (no Map / Set / push): the test's
// read-only scan stays exact.
//   rows          per restaurant × completed HN service date (stats-time serviceMs). STATS side = stats_daily sale {orders, cents} as
//                 published, MINUS the validated pre-cohort sales (created before --start; the raw value is kept — #118 #3). LEDGER side =
//                 the PERSISTED journal facts of each cohort sale's projection (#118 #1): the restaurant_payable of its collection /
//                 reversal journals, its commission + ISV checked against commissionOf(food, rate_bp) — never rebuilt from the snapshot.
//                 Explicit BRIDGES carry the classification gaps, each counted and labelled: cash_bridged (a fulfilled cash / card_delivery
//                 sale has no collection journal by design — its S1 snapshot food counts only when its commission journal is right),
//                 cash_awaiting_fulfilment, sdk_authorized_not_captured (decided from the SDK record's legs — #118 #2).
//   status        'match' | 'mismatch' (a difference, or a journal fault) | 'not_comparable' (stats missing / not published after the day
//                 ended, or no finished nightly run started after the day ended — #118 #4); a not-comparable row shows NO difference
//   in_range      completeness of the cohort orders served in range (#118 #6); global = the open set by age / status and the STALE holds
// Every date must be a COMPLETED HN day; a read past MAX_RECORDS or a run past MAX_MS refuses: «report incomplete: budget exceeded» (#118 #5).
const { isSale, isFulfilled } = require('../stats/stats-classify');
const ST = require('../stats/stats-time');
const SB = require('../stats/stats-build');
const { foodParts, commissionOf } = require('../ledger/projector');
const DL = require('../driver-ledger/ledger-core');
const { parseEffectiveFrom } = require('./set-driver-rate-core');   // one source: an ISO time, Honduras time when no zone

const MAX_DAYS = 62;
const MAX_RECORDS = 5000;     // per read
const MAX_MS = 120000;        // the whole run
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

// the range against the clock and the cohort start ⇒ an error string | null
function rangeError({ start, from, to }, now) {
  if (from <= ST.dateOf(start)) return `--from must be after the ledger start day ${ST.dateOf(start)} (a partial first day cannot be matched)`;
  if (to >= ST.dateOf(now)) return `--to must be a COMPLETED HN day (before ${ST.dateOf(now)})`;
  return null;
}
// a read of `records` children after `elapsedMs` ⇒ the refusal string | null
function overBudget({ records, elapsedMs }) {
  if (records > MAX_RECORDS) return `report incomplete: budget exceeded (a read returned more than ${MAX_RECORDS} records)`;
  if (elapsedMs > MAX_MS) return `report incomplete: budget exceeded (more than ${MAX_MS / 1000} s)`;
  return null;
}

const time = (x) => Number.isSafeInteger(x) && x > 0;
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };
const orderFood = (o) => (Number.isSafeInteger(o.total_cents) ? o.total_cents : 0) - SB.envioNetCents(o) - SB.tipCents(o);   // stats-build addSale
const linesOf = (lines) => (Array.isArray(lines) ? lines : Object.values(lines || {})).filter((l) => l && typeof l === 'object');
const amt = (lines, account, side) => linesOf(lines).filter((l) => l.account === account).reduce((s, l) => s + (Number.isSafeInteger(l[side]) ? l[side] : 0), 0);
const sumSide = (lines, side) => linesOf(lines).reduce((s, l) => s + (Number.isSafeInteger(l[side]) ? l[side] : 0), 0);

// the PERSISTED journal facts of one projection ⇒ { food, commission, isv, unbalanced }
function journalFacts(p) {
  const js = Object.values((p && p.journals) || {}).filter((j) => j && typeof j === 'object');
  const net = (fams, account) => js.filter((j) => fams.includes(j.family)).reduce((s, j) => s + amt(j.lines, account, 'cr') - amt(j.lines, account, 'dr'), 0);
  return {
    food: net(['collection', 'reversal'], 'restaurant_payable'),
    commission: net(['commission', 'commission_reversal'], 'commission_revenue'),
    isv: net(['commission', 'commission_reversal'], 'isv_payable'),
    unbalanced: js.filter((j) => sumSide(j.lines, 'dr') !== sumSide(j.lines, 'cr')).length,
  };
}
const REVERSAL = { reversal: 1, commission_reversal: 1, envio_promo_reversal: 1 };
const lineKey = (ls) => linesOf(ls).map((l) => `${l.account}|${l.dr || 0}|${l.cr || 0}`).sort().join(',');
const flipKey = (ls) => linesOf(ls).map((l) => `${l.account}|${l.cr || 0}|${l.dr || 0}`).sort().join(',');
const capturedOf = (o, rec) => o.payment_flow !== 'sdk_auth_v1' || Object.values((rec && rec.legs) || {}).some((l) => l && l.state === 'captured');
// EVERY projected order's PERSISTED journals, before any exclusion or bridge (Codex #118 r2 #1) ⇒ { fault: n }:
//   unbalanced (Σdr ≠ Σcr) · orphan_reversal (a reversal that mirrors no journal of the order) — always; then, when the projection is
//   final / open with its snapshot, the money it must hold: the collected food (restaurant_payable on collection / reversal) = the snapshot
//   food for a CAPTURED card sale, else 0 (unreversed / collection_missing / collection_amount / collection_unexpected); the commission +
//   ISV = commissionOf(snapshot food, rate_bp) for a captured card sale or a fulfilled non-card sale, else 0 (the projector's own rules)
function validateOrder(o, p, snap, rec) {
  const out = {}; const f = journalFacts(p);
  if (f.unbalanced) inc(out, 'unbalanced', f.unbalanced);
  const js = Object.values((p && p.journals) || {}).filter((j) => j && typeof j === 'object');
  const mirrors = {}; for (const j of js) if (!REVERSAL[j.family]) mirrors[flipKey(j.lines)] = true;
  const orphans = js.filter((j) => REVERSAL[j.family] && !mirrors[lineKey(j.lines)]).length;
  if (orphans) inc(out, 'orphan_reversal', orphans);
  if (!snap || p.status === 'quarantined' || p.status === 'unresolved') return out;
  const snapFood = foodParts(snap).food; const sale = isSale(o);
  const card = o.payment_method === 'online';
  const owesFood = card && sale && capturedOf(o, rec) ? snapFood : 0;
  if (f.food !== owesFood) inc(out, !card ? 'collection_unexpected' : owesFood === 0 ? 'unreversed' : f.food === 0 ? 'collection_missing' : 'collection_amount');
  const accrues = card ? owesFood > 0 : sale && isFulfilled(o);
  if (Number.isSafeInteger(p.rate_bp)) {
    const k = accrues ? commissionOf(snapFood, p.rate_bp) : { commission: 0, isv: 0 };   // the base = the food the customer paid (the snapshot)
    if (f.commission !== k.commission || f.isv !== k.isv) inc(out, 'commission');
  }
  return out;
}

function buildReport({ start, from, to, now, orders, snapshots, sdk, projections, open, stale, runs, stats, weeks }) {
  const err = rangeError({ start, from, to }, now); if (err) throw new Error(err);
  const dates = ST.datesBetween(from, to);
  const inRange = {}; for (const d of dates) inRange[d] = true;
  const rids = {}; for (const o of Object.values(orders || {})) if (o && typeof o === 'object') rids[SB.ridOf(o)] = true;
  for (const rid of Object.keys(stats || {})) rids[rid] = true;
  const zero = () => ({ orders: 0, cents: 0 });
  const rows = {};
  for (const rid of Object.keys(rids).sort()) for (const date of dates) {
    const doc = stats && stats[rid] && stats[rid][date];
    rows[`${rid}|${date}`] = { rid, date, stats_published: !!doc, stats_computed_at: doc && time(doc.computed_at) ? doc.computed_at : null,
      stats_raw: { orders: (doc && doc.sale && doc.sale.orders) || 0, cents: (doc && doc.sale && doc.sale.cents) || 0 },
      pre_cohort: zero(), ledger: zero(), cash_bridged: zero(), bridges: { cash_awaiting_fulfilment: zero(), sdk_authorized_not_captured: zero() },
      journal_faults: {} };
  }
  const add = (z, cents) => { z.orders += 1; z.cents += cents; };
  const cash = { cash_sales: 0, accrual_only: 0, awaiting_fulfilment: 0, card_delivery_sales: 0 };
  const in_range = { not_projected: 0, no_snapshot: 0, quarantined: {}, unresolved: {}, journal_faults: {} };
  const journal_faults_outside = {};
  for (const [id, o] of Object.entries(orders || {})) {
    if (!o || typeof o !== 'object') continue;
    const ms = ST.serviceMs(o); const date = ms === null ? null : ST.dateOf(ms);
    const cohort = time(o.created_at) && o.created_at >= start;
    const r = date !== null && inRange[date] ? rows[`${SB.ridOf(o)}|${date}`] : null;
    const p = projections && projections[id]; const snap = snapshots && snapshots[id]; const rec = sdk && sdk[id];
    const faults = p ? validateOrder(o, p, snap, rec) : {};
    for (const [k, c] of Object.entries(faults)) { if (r && cohort) { inc(r.journal_faults, k, c); inc(in_range.journal_faults, k, c); } else inc(journal_faults_outside, k, c); }
    if (!r) continue;
    const sale = isSale(o);
    if (!cohort) { if (sale) add(r.pre_cohort, orderFood(o)); continue; }
    if (!p) { in_range.not_projected += 1; continue; }
    if (p.status === 'quarantined' || p.status === 'unresolved') { for (const why of p.reasons || ['unknown']) inc(in_range[p.status], why); continue; }
    if (!sale) continue;
    if (!snap) { in_range.no_snapshot += 1; continue; }
    const snapFood = foodParts(snap).food; const f = journalFacts(p);
    if (o.payment_method === 'online') {
      if (!capturedOf(o, rec)) { add(r.bridges.sdk_authorized_not_captured, snapFood); continue; }
      if (f.food > 0 || snapFood === 0) add(r.ledger, f.food);
      continue;
    }
    if (o.payment_method === 'cash') cash.cash_sales += 1;
    if (o.payment_method === 'card_delivery') cash.card_delivery_sales += 1;
    if (!isFulfilled(o)) { add(r.bridges.cash_awaiting_fulfilment, snapFood); if (o.payment_method === 'cash') cash.awaiting_fulfilment += 1; continue; }
    if (o.payment_method === 'cash' && (p.reasons || []).includes('cash_not_evidenced')) cash.accrual_only += 1;
    if (!Object.keys(faults).length) { add(r.ledger, snapFood); add(r.cash_bridged, snapFood); }   // the bridge only for a clean order
  }
  const lastRun = Object.values(runs || {}).filter((x) => x && time(x.finished_at) && time(x.started_at)).reduce((m, x) => Math.max(m, x.started_at), 0);
  const days = Object.values(rows).map((r) => {
    const end = ST.dayEndMs(r.date);
    const why = [!r.stats_published && 'stats_missing', r.stats_published && !(r.stats_computed_at >= end) && 'stats_stale', !(lastRun >= end) && 'ledger_not_rebuilt'].filter(Boolean);
    const stats = { orders: r.stats_raw.orders - r.pre_cohort.orders, cents: r.stats_raw.cents - r.pre_cohort.cents };
    const b = r.bridges;
    const expected = { orders: stats.orders - b.cash_awaiting_fulfilment.orders - b.sdk_authorized_not_captured.orders,
      cents: stats.cents - b.cash_awaiting_fulfilment.cents - b.sdk_authorized_not_captured.cents };
    const diff = why.length ? null : { orders: expected.orders - r.ledger.orders, cents: expected.cents - r.ledger.cents };
    const status = why.length ? 'not_comparable' : (diff.orders || diff.cents || Object.keys(r.journal_faults).length) ? 'mismatch' : 'match';
    return { ...r, stats, diff, status, not_comparable: why };
  });
  const global = { open_by_age: { under_1d: 0, d1_7: 0, d7_21: 0, over_21d: 0 }, open_status: {}, stale_hold: {} };
  for (const id of Object.keys(open || {})) {
    const p = projections && projections[id]; const o = orders && orders[id];
    inc(global.open_status, (p && p.status) || 'not_projected');
    const age = o && time(o.created_at) ? now - o.created_at : null;
    if (age !== null) inc(global.open_by_age, age < DAY ? 'under_1d' : age < 7 * DAY ? 'd1_7' : age < 21 * DAY ? 'd7_21' : 'over_21d');
  }
  for (const id of Object.keys(stale || {})) { const p = projections && projections[id]; for (const why of (p && p.reasons) || ['unknown']) inc(global.stale_hold, why); }
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
  return { cohort: { start, start_day: ST.dateOf(start), from, to }, days, cash, driver, in_range, journal_faults_outside, global,
    coverage: { runs: runList, missing_run_dates: missing, last_finished_run_start: lastRun || null } };
}

module.exports = { parseArgs, rangeError, overBudget, journalFacts, validateOrder, buildReport, MAX_DAYS, MAX_RECORDS, MAX_MS };
