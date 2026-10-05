'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — the PURE summary builder (PLAN-stats rev 4, §S1.1 + §S1.2 "Daily summary").
//
// Orders in → per-(restaurant, service date) daily summaries out. No I/O. The nightly job, the backfill,
// the targeted repair and the live "today" view all run THIS code, so they cannot disagree.
//
// 🔴 EVERY STORED FIELD IS ADDITIVE. A period is the SUM of its days (mergeSummaries), so nothing here
// stores a ratio, an average, a median or a distinct count:
//   averages      → sum + count (average_paid_ticket = cents / (orders − zero_value_orders), at read)
//   medians       → a FIXED-bucket histogram per day (merged, then read)
//   distinct      → the per-customer map, unioned at read
//   new/returning → per-customer {orders, cents} contributions + the customer index (stats-index.js)
// stats-additivity.test.js proves merge(days) == build(range) field by field.
// ---------------------------------------------------------------------------
const { classifyOrder, isFulfilled, CLASS } = require('./stats-classify');
const { serviceMs, dateOf, hourOf } = require('./stats-time');

const SUMMARY_VERSION = 1;
// The three methods as stored, plus `other` for '' / legacy values (index.js:524-525 maps an absent or
// invalid method to ''), so Σ by_payment == sale.orders holds by construction.
const PAYMENT_METHODS = ['cash', 'card_delivery', 'online', 'other'];
const paymentBucket = (m) => (m === 'cash' || m === 'card_delivery' || m === 'online' ? m : 'other');
// The intake validator admits only these two (index.js:517 "order_type must be \"delivery\" or
// \"pickup\""). `other` exists so a legacy/malformed record is COUNTED rather than silently dropped,
// which keeps Σ by_type == sale.orders true by construction.
const ORDER_TYPES = ['delivery', 'pickup', 'other'];

// Duration histogram: 5-minute buckets over [0, 120 min), then ONE overflow bucket. Fixed forever for
// a given SUMMARY_VERSION — merging histograms with different edges would be meaningless, so changing
// these is a version bump + rebuild.
const HIST_BUCKET_MS = 5 * 60000;
const HIST_BUCKETS = 24;                    // + 1 overflow = 25 entries
const HIST_LEN = HIST_BUCKETS + 1;

const REWARD_PREFIX = 'reward:';
const MAX_ITEM_KEY = 200;

const zMoney = () => ({ orders: 0, cents: 0, zero_value_orders: 0 });
const zHist = () => ({ sum_ms: 0, n: 0, eligible: 0, hist: new Array(HIST_LEN).fill(0) });

function emptySummary() {
  return {
    v: SUMMARY_VERSION,
    sale: { orders: 0, cents: 0, subtotal_cents: 0, tax_cents: 0, zero_value_orders: 0, anonymous_orders: 0, items_missing_orders: 0 },
    refunded: { orders: 0, cents: 0 },
    refund_pending: { orders: 0, cents: 0 },
    cancelled: { orders: 0, cents: 0 },
    unresolved: { orders: 0 },
    excluded: { orders: 0 },
    fulfilled: { orders: 0 },
    by_type: Object.fromEntries(ORDER_TYPES.map((t) => [t, zMoney()])),
    by_payment: Object.fromEntries(PAYMENT_METHODS.map((m) => [m, zMoney()])),
    by_hour: Array.from({ length: 24 }, () => ({ orders: 0, cents: 0 })),
    items: {},
    prep: zHist(),
    delivery: zHist(),
    customers: {},
  };
}

const int = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n) : 0; };

function histAdd(h, ms) {
  h.sum_ms += ms;
  h.n += 1;
  const b = Math.min(Math.floor(ms / HIST_BUCKET_MS), HIST_BUCKETS);
  h.hist[b] += 1;
}

// A valid interval, or null. Missing or negative → null (EXCLUDED, never zero-filled).
function interval(start, end) {
  const s = Number(start), e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) return null;
  const d = e - s;
  return d >= 0 ? d : null;
}

// Prep starts at service start: `materialized_at` for a scheduled order (it sat held until release),
// `created_at` otherwise; ends at driver pickup. Delivery orders only — a customer-pickup order has no
// driver timestamps.
const prepStart = (o) => ((o.scheduled_for != null && o.scheduled_for !== '') ? o.materialized_at : o.created_at);

function linesOf(order) {
  const sl = order && order.summary_lines;
  if (Array.isArray(sl)) return sl;
  if (sl && typeof sl === 'object') return Object.keys(sl).sort((a, b) => Number(a) - Number(b)).map((k) => sl[k]);   // RTDB array-as-object
  return [];
}

// Firestore reserves field names of the form __x__; an empty key is invalid. Neither can come from a
// real menu, but a summary that fails to WRITE is a lost day, so they are made safe rather than trusted.
function itemKey(name, cents) {
  let n = String(name == null ? '' : name).trim().slice(0, MAX_ITEM_KEY);
  if (!n) n = '(sin nombre)';
  if (/^__.*__$/.test(n)) n = `_${n}`;
  // A reward line is cents <= 0 (paid lines are > 0: price-valid.js isValidPrice requires a positive
  // integer price and qty ≥ 1). Kept under its own key so a free Margherita never merges with a paid one.
  return cents <= 0 ? REWARD_PREFIX + n : n;
}

function addSale(s, order, rid, keyer) {
  const cents = int(order.total_cents);
  const zero = cents === 0 ? 1 : 0;
  s.sale.orders += 1;
  s.sale.cents += cents;
  s.sale.subtotal_cents += int(order.subtotal_cents);
  s.sale.tax_cents += int(order.tax_cents);
  s.sale.zero_value_orders += zero;

  const type = ORDER_TYPES.includes(order.order_type) && order.order_type !== 'other' ? order.order_type : 'other';
  const t = s.by_type[type]; t.orders += 1; t.cents += cents; t.zero_value_orders += zero;
  const p = s.by_payment[paymentBucket(order.payment_method)];
  p.orders += 1; p.cents += cents; p.zero_value_orders += zero;

  const h = s.by_hour[hourOf(serviceMs(order))]; h.orders += 1; h.cents += cents;

  if (isFulfilled(order)) s.fulfilled.orders += 1;

  // Items. `cents` is ALREADY qty × unit price, extras folded into the parent (menu-pricing.js:281,
  // :293, :302) — summed as stored, never multiplied again.
  const lines = linesOf(order);
  let used = 0;
  for (const ln of lines) {
    if (!ln || typeof ln !== 'object') continue;
    const qty = int(ln.qty), lc = int(ln.cents);
    if (qty <= 0) continue;
    const k = itemKey(ln.name, lc);
    const it = s.items[k] || (s.items[k] = { qty: 0, cents: 0 });
    it.qty += qty; it.cents += lc;
    used += 1;
  }
  if (!used) s.sale.items_missing_orders += 1;

  if (type === 'delivery') {
    s.prep.eligible += 1;
    const pm = interval(prepStart(order), order.picked_up_at);
    if (pm !== null) histAdd(s.prep, pm);
    s.delivery.eligible += 1;
    const dm = interval(order.picked_up_at, order.delivered_at);
    if (dm !== null) histAdd(s.delivery, dm);
  }

  const ck = keyer(rid, order.customer_phone);
  if (ck) {
    const c = s.customers[ck] || (s.customers[ck] = { orders: 0, cents: 0 });
    c.orders += 1; c.cents += cents;
  } else {
    s.sale.anonymous_orders += 1;
  }
}

// Fold ONE order into a summary. Returns its class (for diagnostics).
function addOrder(s, order, rid, keyer) {
  const cls = classifyOrder(order);
  const cents = int(order.total_cents);
  switch (cls) {
    case CLASS.SALE: addSale(s, order, rid, keyer); break;
    case CLASS.REFUNDED: s.refunded.orders += 1; s.refunded.cents += cents; break;
    case CLASS.REFUND_PENDING: s.refund_pending.orders += 1; s.refund_pending.cents += cents; break;
    case CLASS.CANCELLED: s.cancelled.orders += 1; s.cancelled.cents += cents; break;
    case CLASS.EXCLUDED: s.excluded.orders += 1; break;
    default: s.unresolved.orders += 1; break;
  }
  return cls;
}

// The restaurant an order belongs to. A record with NO restaurant_id is a pre-Phase-0 order of the
// platform's legacy default brand — that is the platform's own existing rule (restaurant-id.js
// sameRestaurant / DEFAULT_RESTAURANT_ID), reused rather than restated, so no brand literal lives here.
const { DEFAULT_RESTAURANT_ID } = require('../restaurant-id');
const ridOf = (order) => (order && typeof order.restaurant_id === 'string' && order.restaurant_id) || DEFAULT_RESTAURANT_ID;

/**
 * buildDailies(orders, { keyer, restaurants?, dates? }) → Map<rid, Map<date, summary>>.
 *   restaurants: optional Set — only these rids are built (others ignored).
 *   dates:       optional Set — only orders whose SERVICE date is in it are built; every date in it gets
 *                a summary (an empty day is a real zero, written so a stale doc cannot survive).
 */
function buildDailies(orders, { keyer, restaurants = null, dates = null } = {}) {
  if (typeof keyer !== 'function') throw new Error('stats_build_needs_keyer');
  const out = new Map();
  const bucket = (rid, date) => {
    let m = out.get(rid);
    if (!m) { m = new Map(); out.set(rid, m); }
    let s = m.get(date);
    if (!s) { s = emptySummary(); m.set(date, s); }
    return s;
  };
  if (restaurants && dates) for (const rid of restaurants) for (const d of dates) bucket(rid, d);
  let skippedNoTime = 0;
  for (const o of orders) {
    if (!o || typeof o !== 'object') continue;
    const rid = ridOf(o);
    if (restaurants && !restaurants.has(rid)) continue;
    const ms = serviceMs(o);
    if (ms === null) { skippedNoTime += 1; continue; }
    const date = dateOf(ms);
    if (dates && !dates.has(date)) continue;
    addOrder(bucket(rid, date), o, rid, keyer);
  }
  out.skippedNoTime = skippedNoTime;
  return out;
}

// Σ of summaries. Pure; never mutates its inputs.
function mergeSummaries(list) {
  const acc = emptySummary();
  const addObj = (a, b) => { for (const k of Object.keys(b)) if (typeof b[k] === 'number') a[k] = (a[k] || 0) + b[k]; };
  for (const s of list) {
    if (!s) continue;
    for (const k of ['sale', 'refunded', 'refund_pending', 'cancelled', 'unresolved', 'excluded', 'fulfilled']) if (s[k]) addObj(acc[k], s[k]);
    for (const t of ORDER_TYPES) if (s.by_type && s.by_type[t]) addObj(acc.by_type[t], s.by_type[t]);
    for (const m of PAYMENT_METHODS) if (s.by_payment && s.by_payment[m]) addObj(acc.by_payment[m], s.by_payment[m]);
    if (Array.isArray(s.by_hour)) s.by_hour.forEach((h, i) => { if (h && i < 24) addObj(acc.by_hour[i], h); });
    for (const [k, v] of Object.entries(s.items || {})) { const it = acc.items[k] || (acc.items[k] = { qty: 0, cents: 0 }); it.qty += v.qty || 0; it.cents += v.cents || 0; }
    for (const k of ['prep', 'delivery']) {
      const h = s[k]; if (!h) continue;
      acc[k].sum_ms += h.sum_ms || 0; acc[k].n += h.n || 0; acc[k].eligible += h.eligible || 0;
      (h.hist || []).forEach((c, i) => { if (i < HIST_LEN) acc[k].hist[i] += c || 0; });
    }
    for (const [k, v] of Object.entries(s.customers || {})) { const c = acc.customers[k] || (acc.customers[k] = { orders: 0, cents: 0 }); c.orders += v.orders || 0; c.cents += v.cents || 0; }
  }
  return acc;
}

// Median from a merged histogram: the bucket holding the ⌈n/2⌉-th value. Exact to within ONE bucket
// (that is the stored resolution, and the test's tolerance). null when n = 0.
function histMedian(h) {
  if (!h || !h.n) return null;
  const target = Math.ceil(h.n / 2);
  let seen = 0;
  for (let i = 0; i < HIST_LEN; i++) {
    seen += h.hist[i] || 0;
    if (seen >= target) {
      const lo = i * HIST_BUCKET_MS;
      const hi = i < HIST_BUCKETS ? lo + HIST_BUCKET_MS : null;   // overflow bucket is open-ended
      return { bucket: i, lo_ms: lo, hi_ms: hi, approx_ms: hi === null ? lo : lo + HIST_BUCKET_MS / 2 };
    }
  }
  return null;
}

const avgPaidTicket = (m) => { const d = (m.orders || 0) - (m.zero_value_orders || 0); return d > 0 ? Math.round(m.cents / d) : null; };

module.exports = {
  SUMMARY_VERSION, PAYMENT_METHODS, ORDER_TYPES, HIST_BUCKET_MS, HIST_BUCKETS, HIST_LEN, REWARD_PREFIX,
  paymentBucket, emptySummary, addOrder, buildDailies, mergeSummaries, histMedian, avgPaidTicket, ridOf, linesOf, itemKey, interval, prepStart,
};
