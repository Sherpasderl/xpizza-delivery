'use strict';
// S8 — THE DRIVER PAYABLE LEDGER, PURE CORE (PLAN-shared-order-form.FINAL §5 S8; owner rulings: L 70 per delivered order,
// Sherpa collects tips and fees and owes tips to the driver, weekly Mon–Sun America/Tegucigalpa, manual bank transfer,
// FULL settlement only, bank details OFF-platform, net ≤ 0 carries forward).
//
// No I/O here: week keys, the accrual record for one order, a week's statement, and the «Marcar pagado» validation.
// The store (ledger-store.js) does the reads/writes; this file decides.
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

/* The accrual for ONE order: { kind: 'event', driverUid, event } or { kind: 'unresolved', entry } or null.
   `closedWeeks(week)` answers whether that week's statement already exists; a delivery whose own week is closed is
   posted into `currentWeek` as a LATE adjustment that references the original week (statements are immutable). */
function accrualFor(orderId, order, cfg, { currentWeek, isClosed }) {
  if (!isAccruable(order, cfg)) return null;
  const week = weekOf(order.delivered_at);
  const stamp = order.delivered_by_driver_uid;
  if (typeof stamp !== 'string' || !stamp) {
    return { kind: 'unresolved', entry: { order_id: orderId, delivered_at: order.delivered_at, week, restaurant_id: order.restaurant_id || null } };
  }
  const late = isClosed(week);
  const event = {
    order_id: orderId, driver_uid: stamp, delivered_at: order.delivered_at,
    base_cents: cfg.base_cents,                     // tips arrive with S2 (and their fields with them)
    policy_version: cfg.policy_version,
    week: late ? currentWeek : week,
    ...(late ? { original_week: week, kind: 'late' } : { kind: 'delivery' }),
  };
  return { kind: 'event', driverUid: stamp, event };
}

/* A week's statement from that week's events + the previous statement. net = Σ base (deliveries) + adjustments (late
   accruals, referencing their original week) + carry_in. Tips join both sums in S2, when the tip feature exists. carry_in = the previous statement's net when
   it was ≤ 0 and closed without payment (a negative balance offsets the next payable); a positive unpaid week stays
   payable on its OWN statement and never carries. */
function statementFor(week, events, prev) {
  const own = events.filter((e) => e && e.week === week);
  const deliveries = own.filter((e) => e.kind === 'delivery');
  const lates = own.filter((e) => e.kind === 'late');
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const carry_in_cents = prev && !prev.payment && Number.isInteger(prev.net_cents) && prev.net_cents < 0 ? prev.net_cents : 0;
  const base_cents = sum(deliveries, (e) => e.base_cents);
  const adjustments_cents = sum(lates, (e) => e.base_cents);
  const net_cents = base_cents + adjustments_cents + carry_in_cents;
  return {
    week, deliveries: deliveries.length, base_cents, adjustments_cents, carry_in_cents, net_cents,
    order_ids: own.map((e) => e.order_id).sort(),
    adjustments: lates.map((e) => ({ order_id: e.order_id, original_week: e.original_week, cents: e.base_cents })),
    outcome: net_cents > 0 ? 'payable' : 'no_payment',
  };
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

module.exports = { HN_OFFSET_MS, WEEK_RE, weekOf, weekBounds, prevWeek, nextWeek, readPayConfig, isAccruable, accrualFor, statementFor, validatePayment };
