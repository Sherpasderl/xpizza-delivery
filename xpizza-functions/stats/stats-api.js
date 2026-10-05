'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — `getSalesStats` core (PLAN-stats rev 4 §S1.3). index.js holds only the onRequest
// wrapper (PORTAL_ORIGINS, export wiring); every decision is here, testable without Firebase init.
//
// AUTHORIZATION BEFORE ANY READ: the injected `authorize(rid)` is catalog-edit-auth.js
// authorizeCatalogEdit — the COMPLETE existing policy (owners and kitchen staff restaurant-scoped,
// dispatchers global, customers rejected; RID_RE validation; a throwing lookup → 503). Its statuses pass
// through verbatim. Nothing — not the meta doc, not the clock — is read before it answers ok.
//
// AGGREGATES ONLY: no response field carries a phone, a name, an address or a customer hmac. The
// per-customer maps are consumed here (distinct / new / returning) and never serialized.
//
// REQUEST COST (bounded, documented): with D = days in the period (≤ MAX_RANGE_DAYS) and the same again
// for the comparison: ≤ 2·D daily-doc reads by id + 16 shard reads + 2 meta reads (epoch before/after),
// ×2 on the single epoch-change retry; plus the live view's ONE bounded created_at read
// (today [+ yesterday if not yet settled] − READ_PAD), cached per restaurant for LIVE_TTL_MS.
// The orders CSV reads ONE page (≤ ORDERS_CSV_PAGE records) of a ≤ ORDERS_CSV_MAX_DAYS range per call.
// ---------------------------------------------------------------------------
const T = require('./stats-time');
const B = require('./stats-build');
const { classifyOrder } = require('./stats-classify');
const { firstDatesWithOverlay, newVsReturning } = require('./stats-index');
const S = require('./stats-store');
const { readOrdersBounded } = require('./stats-job');

const MAX_RANGE_DAYS = 731;          // "ranges capped at 2 years"
const ORDERS_CSV_MAX_DAYS = 31;
const ORDERS_CSV_PAGE = 1000;
const LIVE_TTL_MS = 30000;
const LIVE_BUDGET = Object.freeze({ maxRecords: 20000, maxBytes: 32 * 1024 * 1024, chunkSize: 2000 });
const GRANULARITIES = new Set(['day', 'week', 'month']);
const COMPARES = new Set(['previous', 'previous_week', 'none']);

const reply = (status, body) => ({ status, body });
const bad = (error, detail) => reply(400, { error, ...(detail ? { detail } : {}) });

// ── live view ─────────────────────────────────────────────────────────────────────────────────────
// Per-process cache: the throttle. Keyed by rid + live dates, so a day rollover never serves stale.
function makeLiveCache() { return new Map(); }

async function liveSummaries({ rtdb, keyer, cache }, rid, liveDates, nowMs) {
  const key = `${rid}|${liveDates.join(',')}`;
  const hit = cache && cache.get(key);
  if (hit && nowMs - hit.at < LIVE_TTL_MS) return hit.value;
  const fromMs = T.dayStartMs(liveDates[0]) - T.READ_PAD_MS;
  const toMs = T.dayEndMs(liveDates[liveDates.length - 1]);
  const { orders } = await readOrdersBounded(rtdb, fromMs, toMs, LIVE_BUDGET);
  const built = buildFor(orders, rid, liveDates, keyer);
  if (cache) cache.set(key, { at: nowMs, value: built });
  return built;
}
function buildFor(orders, rid, dates, keyer) {
  const m = B.buildDailies(orders, { keyer, restaurants: new Set([rid]), dates: new Set(dates) });
  return m.get(rid) || new Map();
}

// ── shaping ───────────────────────────────────────────────────────────────────────────────────────
const pct = (cur, base) => (base ? Math.round(((cur - base) / base) * 10000) / 100 : null);
const money = (m) => ({ orders: m.orders, cents: m.cents, zero_value_orders: m.zero_value_orders, average_paid_ticket_cents: B.avgPaidTicket(m) });

function times(h) {
  const med = B.histMedian(h);
  return {
    eligible: h.eligible, n: h.n, coverage: h.eligible ? Math.round((h.n / h.eligible) * 10000) / 100 : null,
    avg_ms: h.n ? Math.round(h.sum_ms / h.n) : null,
    median: med ? { lo_ms: med.lo_ms, hi_ms: med.hi_ms, approx_ms: med.approx_ms } : null,
  };
}

function seriesKey(date, g) { return g === 'day' ? date : g === 'week' ? T.weekStartOf(date) : T.monthOf(date); }
function series(dates, byDate, g) {
  const groups = new Map();
  for (const d of dates) {
    const k = seriesKey(d, g);
    if (!groups.has(k)) groups.set(k, []);
    const s = byDate.get(d); if (s) groups.get(k).push(s);
  }
  return [...groups].map(([k, list]) => { const m = B.mergeSummaries(list); return { key: k, sales_cents: m.sale.cents, orders: m.sale.orders, average_paid_ticket_cents: B.avgPaidTicket(m.sale) }; });
}

function heatmap(dates, byDate) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ orders: 0, cents: 0 })));
  for (const d of dates) {
    const s = byDate.get(d); if (!s) continue;
    const w = T.weekdayOf(d);
    (s.by_hour || []).forEach((h, i) => { grid[w][i].orders += h.orders || 0; grid[w][i].cents += h.cents || 0; });
  }
  return grid;   // [Mon..Sun][0..23]
}

function shapePeriod(m, dates, byDate, firsts, from, g) {
  const c = m.cancelled.orders + m.refunded.orders;
  const denom = m.sale.orders + c;
  const items = Object.entries(m.items).map(([k, v]) => {
    const reward = k.startsWith(B.REWARD_PREFIX);
    return { name: reward ? k.slice(B.REWARD_PREFIX.length) : k, reward, qty: v.qty, cents: v.cents, share_pct: m.sale.cents ? Math.round((v.cents / m.sale.cents) * 10000) / 100 : null };
  }).sort((a, b) => b.cents - a.cents || b.qty - a.qty || (a.name < b.name ? -1 : 1));
  return {
    kpis: { sales_cents: m.sale.cents, orders: m.sale.orders, average_paid_ticket_cents: B.avgPaidTicket(m.sale), subtotal_cents: m.sale.subtotal_cents, tax_cents: m.sale.tax_cents, zero_value_orders: m.sale.zero_value_orders },
    series: series(dates, byDate, g),
    by_type: Object.fromEntries(B.ORDER_TYPES.map((t) => [t, money(m.by_type[t])])),
    by_payment: Object.fromEntries(B.PAYMENT_METHODS.map((p) => [p, money(m.by_payment[p])])),
    heatmap: heatmap(dates, byDate),
    items,
    items_coverage: { sale_orders: m.sale.orders, without_lines: m.sale.items_missing_orders },
    customers: { ...newVsReturning(m.customers, firsts, from), anonymous_orders: m.sale.anonymous_orders },
    cancellations: {
      cancelled: { ...m.cancelled }, refunded: { ...m.refunded }, refund_pending: { ...m.refund_pending },
      unresolved: { ...m.unresolved }, excluded: { ...m.excluded },
      rate_pct: denom ? Math.round((c / denom) * 10000) / 100 : null,
      lost_cents: m.cancelled.cents + m.refunded.cents,
    },
    fulfilled: { orders: m.fulfilled.orders },
    times: { prep: times(m.prep), delivery: times(m.delivery) },
  };
}

// ── CSV ───────────────────────────────────────────────────────────────────────────────────────────
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;   // spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const L = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));

// The per-order CSV ALLOWLIST. Adding a column is a deliberate edit here — never a spread of the order.
// NO phone, address, name, email, rtn, coordinates or tokens.
const ORDER_COLUMNS = ['fecha', 'hora', 'numero', 'tipo', 'metodo_pago', 'clase', 'total_L', 'subtotal_L', 'isv_L', 'articulos'];
function orderRow(o) {
  const ms = T.serviceMs(o);
  const hh = String(T.hourOf(ms)).padStart(2, '0');
  const mm = String(new Date(ms - T.TZ_OFFSET_MS).getUTCMinutes()).padStart(2, '0');
  const items = B.linesOf(o).filter((l) => l && typeof l === 'object').map((l) => `${Number(l.qty) || 0}x ${String(l.name == null ? '' : l.name)}`).join('; ');
  return [T.dateOf(ms), `${hh}:${mm}`, o.display_number == null ? '' : o.display_number, o.order_type || '', o.payment_method || '',
    classifyOrder(o), L(Number(o.total_cents)), L(Number(o.subtotal_cents)), L(Number(o.tax_cents)), items];
}

// ── the core ──────────────────────────────────────────────────────────────────────────────────────
function parseParams(q, nowMs) {
  const p = {
    from: q.from, to: q.to,
    granularity: q.granularity || 'day', compare: q.compare || 'previous',
    format: q.format || 'json', kind: q.kind || 'daily', cursor: q.cursor || null,
  };
  if (!T.isDate(p.from) || !T.isDate(p.to)) return { error: bad('bad_range', 'from/to must be YYYY-MM-DD') };
  if (p.to < p.from) return { error: bad('bad_range', 'to < from') };
  const today = T.dateOf(nowMs);
  if (p.to > today) return { error: bad('bad_range', 'to is in the future') };
  if (T.daysBetween(p.from, p.to) + 1 > MAX_RANGE_DAYS) return { error: bad('range_too_long', `max ${MAX_RANGE_DAYS} days`) };
  if (!GRANULARITIES.has(p.granularity)) return { error: bad('bad_granularity') };
  if (!COMPARES.has(p.compare)) return { error: bad('bad_compare') };
  if (!['json', 'csv'].includes(p.format)) return { error: bad('bad_format') };
  if (!['daily', 'orders'].includes(p.kind)) return { error: bad('bad_kind') };
  if (p.cursor != null && !/^\d{1,16}:[A-Za-z0-9_-]{1,80}$/.test(p.cursor)) return { error: bad('bad_cursor') };
  p.today = today;
  return { p };
}

function compareRange(p) {
  if (p.compare === 'none') return null;
  const len = T.daysBetween(p.from, p.to) + 1;
  const shift = p.compare === 'previous_week' ? 7 : len;
  return { from: T.addDays(p.from, -shift), to: T.addDays(p.to, -shift) };
}

async function getSalesStatsCore(deps, req) {
  const { authorize, fsdb, rtdb, getKeyer, nowMs = Date.now(), liveCache = null } = deps;
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  const q = req.query || {};
  const rid = q.restaurantId;

  const auth = await authorize(rid, req);   // 🔴 FIRST. Nothing is read before this answers.
  if (!auth || !auth.ok) return reply((auth && auth.status) || 403, { error: (auth && auth.error) || 'not_authorized' });

  const { p, error } = parseParams(q, nowMs);
  if (error) return error;

  let keyer;
  try { keyer = getKeyer(); } catch (e) { return reply(503, { error: 'stats_unavailable', retryable: false }); }   // secret fails CLOSED

  if (p.format === 'csv' && p.kind === 'orders') return ordersCsv({ rtdb }, rid, p);

  const cmp = compareRange(p);
  const read = async () => {
    const meta1 = await S.readMeta(fsdb, rid);
    const periodDates = T.datesBetween(p.from, p.to);
    const cmpDates = cmp ? T.datesBetween(cmp.from, cmp.to) : [];
    const stored = [...new Set([...periodDates, ...cmpDates])].filter((d) => d < p.today);
    const [byDateStored, shards] = await Promise.all([S.readDailies(fsdb, rid, stored), S.readShards(fsdb, rid)]);
    const meta2 = await S.readMeta(fsdb, rid);
    return { meta1, meta2, periodDates, cmpDates, byDateStored, shards };
  };
  let r;
  try {
    r = await read();
    if (((r.meta1 || {}).epoch || 0) !== ((r.meta2 || {}).epoch || 0)) {
      r = await read();
      if (((r.meta1 || {}).epoch || 0) !== ((r.meta2 || {}).epoch || 0)) return reply(503, { error: 'stats_publishing', retryable: true });
    }
  } catch (e) {
    console.warn('stats_read_unavailable', JSON.stringify({ rid, error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'stats_unavailable', retryable: true });
  }

  // LIVE: today, plus yesterday while it is not yet settled (00:00 → the nightly run).
  const yesterday = T.addDays(p.today, -1);
  const wantsLive = (d) => r.periodDates.includes(d) || r.cmpDates.includes(d);
  const liveDates = [];
  if (wantsLive(yesterday) && !r.byDateStored.has(yesterday)) liveDates.push(yesterday);
  liveDates.push(p.today);
  let live = new Map();
  try { live = await liveSummaries({ rtdb, keyer, cache: liveCache }, rid, liveDates, nowMs); }
  catch (e) {
    console.warn('stats_live_unavailable', JSON.stringify({ rid, code: e.code || null }));
    return reply(503, { error: 'stats_live_unavailable', retryable: true });
  }
  const byDate = new Map(r.byDateStored);
  for (const d of liveDates) byDate.set(d, live.get(d) || B.emptySummary());

  // Index with the live overlay (in memory): every live date's stored membership is replaced.
  const firsts = firstDatesWithOverlay(r.shards, new Map(liveDates.map((d) => [d, Object.keys((byDate.get(d) || {}).customers || {})])));

  const dayInfo = (d) => (liveDates.includes(d) ? 'live' : byDate.has(d) ? isoOf(byDate.get(d).computed_at) : null);
  const periodMerged = B.mergeSummaries(r.periodDates.map((d) => byDate.get(d)));
  const period = shapePeriod(periodMerged, r.periodDates, byDate, firsts, p.from, p.granularity);
  let comparison = null;
  if (cmp) {
    const cm = B.mergeSummaries(r.cmpDates.map((d) => byDate.get(d)));
    comparison = { range: cmp, ...shapePeriod(cm, r.cmpDates, byDate, firsts, cmp.from, p.granularity) };
    period.deltas = {
      sales_pct: pct(period.kpis.sales_cents, comparison.kpis.sales_cents),
      orders_pct: pct(period.kpis.orders, comparison.kpis.orders),
      average_paid_ticket_pct: pct(period.kpis.average_paid_ticket_cents || 0, comparison.kpis.average_paid_ticket_cents || 0),
    };
  }

  if (p.format === 'csv') {
    const rows = [['fecha', 'ventas_L', 'pedidos', 'ticket_promedio_L', 'subtotal_L', 'isv_L', 'efectivo_L', 'tarjeta_entrega_L', 'en_linea_L', 'otro_L', 'domicilio_pedidos', 'recoger_pedidos', 'cancelados', 'reembolsados', 'reembolso_pendiente', 'sin_resolver', 'clientes', 'clientes_nuevos', 'calculado']];
    for (const d of r.periodDates) {
      const s = byDate.get(d);
      if (!s) { rows.push([d, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'pendiente']); continue; }
      const nv = newVsReturning(s.customers, firsts, d);
      rows.push([d, L(s.sale.cents), s.sale.orders, L(B.avgPaidTicket(s.sale)), L(s.sale.subtotal_cents), L(s.sale.tax_cents),
        L(s.by_payment.cash.cents), L(s.by_payment.card_delivery.cents), L(s.by_payment.online.cents), L((s.by_payment.other || { cents: 0 }).cents),
        s.by_type.delivery.orders, s.by_type.pickup.orders, s.cancelled.orders, s.refunded.orders, s.refund_pending.orders, s.unresolved.orders,
        nv.distinct, nv.new.customers, dayInfo(d) || '']);
    }
    return { status: 200, contentType: 'text/csv; charset=utf-8', body: csv(rows), filename: `ventas_${rid}_${p.from}_${p.to}.csv` };
  }

  return reply(200, {
    restaurantId: rid, range: { from: p.from, to: p.to, granularity: p.granularity, compare: p.compare },
    timezone: 'UTC-6 (Honduras, fixed)', epoch: (r.meta2 || {}).epoch || 0,
    days: r.periodDates.map((d) => ({ date: d, computed_at: dayInfo(d) })),
    missing_days: r.periodDates.filter((d) => !byDate.has(d)),
    ...period,
    comparison,
  });
}

function isoOf(ts) { try { return ts && typeof ts.toDate === 'function' ? ts.toDate().toISOString() : (ts ? String(ts) : null); } catch (_) { return null; } }

async function ordersCsv({ rtdb }, rid, p) {
  if (T.daysBetween(p.from, p.to) + 1 > ORDERS_CSV_MAX_DAYS) return bad('range_too_long', `orders CSV: max ${ORDERS_CSV_MAX_DAYS} days per export`);
  const fromMs = T.dayStartMs(p.from) - T.READ_PAD_MS, toMs = T.dayEndMs(p.to);
  let q = rtdb.ref('orders').orderByChild('created_at');
  if (p.cursor) { const [v, k] = p.cursor.split(':'); q = q.startAfter(Number(v), k); } else q = q.startAt(fromMs);
  let snap;
  try { snap = await q.endBefore(toMs).limitToFirst(ORDERS_CSV_PAGE).once('value'); }
  catch (e) { return reply(503, { error: 'stats_unavailable', retryable: true }); }
  const rows = [ORDER_COLUMNS];
  let got = 0, last = null;
  snap.forEach((child) => {
    got += 1;
    const o = child.val();
    last = `${o && o.created_at}:${child.key}`;
    if (!o || B.ridOf(o) !== rid) return;
    const ms = T.serviceMs(o); if (ms === null) return;
    const d = T.dateOf(ms); if (d < p.from || d > p.to) return;
    rows.push(orderRow(o));
  });
  const next = got === ORDERS_CSV_PAGE ? last : null;
  return { status: 200, contentType: 'text/csv; charset=utf-8', body: csv(rows), filename: `pedidos_${rid}_${p.from}_${p.to}.csv`, headers: next ? { 'X-Next-Cursor': next } : {} };
}

module.exports = { getSalesStatsCore, makeLiveCache, parseParams, compareRange, csvCell, orderRow, ORDER_COLUMNS, MAX_RANGE_DAYS, ORDERS_CSV_MAX_DAYS, ORDERS_CSV_PAGE, LIVE_TTL_MS };
