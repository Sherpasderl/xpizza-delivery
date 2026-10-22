'use strict';
// S8 — THE DRIVER PAYABLE LEDGER, PURE CORE (PLAN-shared-order-form.FINAL §5 S8; owner rulings: L 70 per delivered order,
// Sherpa collects tips and fees and owes tips to the driver, weekly Mon–Sun America/Tegucigalpa, manual bank transfer,
// FULL settlement only, bank details OFF-platform, net ≤ 0 carries forward).
//
// No I/O here: week keys, a whole week computed from /orders (computeWeek), and the «Marcar pagado» validation.
// The store (ledger-store.js) does the reads and the ONE write per week; this file decides. r3 (codex r2, advisor
// redesign): NO incremental ledger — /orders is the source of truth; a week is closed by one create-if-absent write.
//
// ATTRIBUTION is ONLY the protected stamp `delivered_by_driver_uid` (database.rules.json: write-once, == the writer's uid,
// assigned driver only; written atomically with `delivered_at = serverTimestamp()` by xpizza-driver/driver-complete.js).
// The async best-effort `delivered_by_uid` is never used for money. An order delivered without the stamp is UNRESOLVED:
// listed for the admin and held out of every balance.
//
// REFUNDS (plan §5 S8): the L 70 base is retained on any refund (the delivery happened); only a tip-inclusive refund
// reverses the tip. Tips do not exist until S2, so no refund can move a payable today — the refund-adjustment hook is
// DEFERRED to S2 (advisor ruling 2026-10-22). Hook point: cancel-order-core.js, where the refund outcome is final
// (`const refund = …` near :208), which S2 wires to a current-week adjustment referencing the original week.

const HN_OFFSET_MS = 6 * 3600 * 1000;           // America/Tegucigalpa = UTC−6, no DST
const DAY_MS = 86400000;
const WEEK_RE = /^W\d{4}-\d{2}-\d{2}$/;

// The week a moment belongs to, keyed by its MONDAY's Honduras date: "W2026-10-19". Mon 00:00 … Sun 23:59:59.999 HN.
function weekOf(ms) {
  const hn = new Date(ms - HN_OFFSET_MS);
  const dow = (hn.getUTCDay() + 6) % 7;          // 0 = Monday
  const monday = Date.UTC(hn.getUTCFullYear(), hn.getUTCMonth(), hn.getUTCDate()) - dow * DAY_MS;
  return `W${new Date(monday).toISOString().slice(0, 10)}`;
}
// [start, end) of a week in UTC epoch ms
function weekBounds(key) {
  if (!WEEK_RE.test(String(key))) throw new Error(`driver-ledger: bad week key ${key}`);
  const start = Date.parse(`${key.slice(1)}T00:00:00Z`) + HN_OFFSET_MS;
  return { start, end: start + 7 * DAY_MS };
}
const prevWeek = (key) => weekOf(weekBounds(key).start - 1);
const nextWeek = (key) => weekOf(weekBounds(key).end);

// The platform's driver-pay config (platform_config/driver_pay; Sherpa-only). Absent or incomplete → the ledger is OFF.
function readPayConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = raw.base_cents, start = raw.ledger_start_at, pv = raw.policy_version;
  if (!Number.isInteger(base) || base <= 0 || !Number.isFinite(start) || start <= 0 || !Number.isInteger(pv) || pv < 1) return null;
  return { base_cents: base, ledger_start_at: start, policy_version: pv };
}

// Does this order earn a delivery accrual at all? A DELIVERY that was delivered (has delivered_at) on/after the start.
function isAccruable(order, cfg) {
  return !!(order && cfg && order.order_type === 'delivery' && typeof order.delivered_at === 'number' && order.delivered_at >= cfg.ledger_start_at);
}

const LATE_WINDOW_MS = 14 * DAY_MS;          // a delivery syncing later than this is out of scope (owner rule)

// The [from, to) delivered_at range a week's computation reads: the week itself plus the 14 days before it, so a delivery
// that synced after its own week closed is picked up by the next close as a LATE adjustment.
function windowOf(week) { const b = weekBounds(week); return { from: b.start - LATE_WINDOW_MS, to: b.end }; }

// The earlier weeks whose closed nodes cover that window (what "already included / already listed" is checked against).
function priorWeeksOf(week) { const p1 = prevWeek(week); return [p1, prevWeek(p1)]; }

const list = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

/* THE WEEK, computed from /orders alone. `rows` = [[order_id, order]] with delivered_at in windowOf(week); `prior` = the
   closed nodes of priorWeeksOf(week) (missing = not closed). Pure and deterministic: the close commits it once, the
   read shows it for the open week. An order is PAID at most once, in the first close that sees it with a stamp:
     · own week                          → deliveries
     · an earlier week, never included   → adjustments (late sync, or a stamp that arrived late)
     · already included in a prior week  → never again; if its CURRENT stamp is another driver → attribution_review
     · no protected stamp                → unresolved (held out of every balance)
   carry_in = the previous week's net for a driver when it was < 0 and unpaid. Review lists are de-duplicated against the
   same lists of the prior closed weeks. */
function computeWeek(week, rows, prior, cfg) {
  const { start, end } = weekBounds(week);
  const paidTo = new Map(), listedUnres = new Set(), listedReview = new Set();
  for (const node of prior) {
    if (!node) continue;
    for (const [uid, d] of Object.entries(node.drivers || {})) {
      for (const oid of list(d.deliveries)) paidTo.set(oid, { uid, week: node.week });
      for (const a of list(d.adjustments)) paidTo.set(a.order_id, { uid, week: node.week });
    }
    for (const oid of list(node.unresolved)) listedUnres.add(oid);
    for (const r of list(node.attribution_review)) listedReview.add(r.order_id);
  }
  const drivers = {}, unresolved = [], review = [];
  const entry = (uid) => (drivers[uid] = drivers[uid] || { deliveries: [], adjustments: [] });
  for (const [oid, o] of [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!isAccruable(o, cfg) || !(o.delivered_at < end)) continue;
    const stamp = typeof o.delivered_by_driver_uid === 'string' && o.delivered_by_driver_uid ? o.delivered_by_driver_uid : null;
    const was = paidTo.get(oid);
    if (was) {
      if (stamp !== was.uid && !listedReview.has(oid)) review.push({ order_id: oid, paid_to: was.uid, paid_week: was.week, stamp_now: stamp });
      continue;
    }
    if (!stamp) { if (!listedUnres.has(oid)) unresolved.push(oid); continue; }
    if (o.delivered_at >= start) entry(stamp).deliveries.push(oid);
    else entry(stamp).adjustments.push({ order_id: oid, original_week: weekOf(o.delivered_at) });
  }
  const prev = prior.find((n) => n && n.week === prevWeek(week));
  for (const [uid, d] of Object.entries((prev && prev.drivers) || {})) if (!d.paid && d.net_cents < 0) entry(uid);
  for (const [uid, d] of Object.entries(drivers)) {
    const p = prev && prev.drivers && prev.drivers[uid];
    const carry_in_cents = p && !p.paid && Number.isInteger(p.net_cents) && p.net_cents < 0 ? p.net_cents : 0;
    const base_cents = d.deliveries.length * cfg.base_cents;
    const adjustments_cents = d.adjustments.length * cfg.base_cents;    // tips join both in S2
    const net_cents = base_cents + adjustments_cents + carry_in_cents;
    drivers[uid] = { ...d, base_cents, adjustments_cents, carry_in_cents, net_cents, outcome: net_cents > 0 ? 'payable' : 'no_payment' };
  }
  return { week, policy_version: cfg.policy_version, base_cents: cfg.base_cents, drivers, unresolved, attribution_review: review };
}

// «Marcar pagado»: FULL settlement only; records amount / date / transfer reference — nothing else, no bank data.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]{2,59}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validatePayment(statement, req) {
  if (!statement) return { ok: false, reason: 'not_closed' };
  if (statement.outcome !== 'payable' || !(statement.net_cents > 0)) return { ok: false, reason: 'nothing_to_pay' };
  if (!Number.isInteger(req.amount_cents) || req.amount_cents !== statement.net_cents) return { ok: false, reason: 'amount_must_equal_net' };
  if (typeof req.reference !== 'string' || !REF_RE.test(req.reference.trim())) return { ok: false, reason: 'bad_reference' };
  if (typeof req.paid_on !== 'string' || !DATE_RE.test(req.paid_on)) return { ok: false, reason: 'bad_date' };
  if (typeof req.op_key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(req.op_key)) return { ok: false, reason: 'bad_op_key' };
  return { ok: true, payment: { amount_cents: req.amount_cents, paid_on: req.paid_on, reference: req.reference.trim(), op_key: req.op_key } };
}

module.exports = { HN_OFFSET_MS, WEEK_RE, LATE_WINDOW_MS, weekOf, weekBounds, prevWeek, nextWeek, windowOf, priorWeeksOf, readPayConfig, isAccruable, computeWeek, validatePayment, list };
