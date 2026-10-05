'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — `getSalesStats` core (PLAN-stats rev 4 §S1.3). index.js holds only the onRequest
// wrapper (PORTAL_ORIGINS, export wiring); every decision is here, testable without Firebase init.
//
// AUTHORIZATION BEFORE ANY READ: the injected `authorize(rid)` is catalog-edit-auth.js
// authorizeCatalogEdit (RID_RE validation; customers rejected; a throwing lookup → 503), its statuses
// passed through verbatim; then OWNER-ONLY (owner ruling 2026-10-05): a staff or dispatcher grant is 403
// not_owner. Nothing — not the meta doc, not the clock — is read before both answer.
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
/* 🔴 ONE SCAN SERVES EVERY RESTAURANT, AND CONCURRENT REQUESTS SHARE IT (codex build r1 #2).
   The live read is a created_at range over ALL restaurants' orders — RTDB cannot filter by restaurant
   and time at once — so the cache is keyed by the LIVE DATES alone, never by rid: ten merchants opening
   the dashboard at once cost ONE read, not ten. The cache holds the in-flight PROMISE, so a request that
   arrives while a scan is running waits for it (single-flight) instead of starting another. A failed
   scan is remembered for LIVE_BACKOFF_MS: requests inside that window fail fast (503, retryable) rather
   than re-hammering /orders. At most LIVE_MAX_CONCURRENT scans run per process. Per-restaurant builds
   are memoized on the shared entry. Per-process, by design: across instances the bound is
   maxInstances × LIVE_MAX_CONCURRENT scans per LIVE_TTL_MS. */
const LIVE_BACKOFF_MS = 10000;
const LIVE_MAX_CONCURRENT = 1;
/* 🔴 TIMES ARE MEASURED AT COMPLETION, ON THE CACHE'S CLOCK (codex build r2, B2'). An entry is one of:
     pending — a scan in flight: ALWAYS shared, however long it runs (a slow scan crossing the TTL must not
               start a second one);
     ok      — fresh for LIVE_TTL_MS counted from when the scan FINISHED;
     failed  — refused (503, retryable) for LIVE_BACKOFF_MS counted from when the scan FAILED (a 20 s
               failure must still back off for the full window).
   The clock is the cache's (Date.now in production; injected in tests), never the request's nowMs,
   which only decides business dates. */
function makeLiveCache({ clock = Date.now } = {}) { return { entries: new Map(), running: 0, waiters: [], scans: 0, clock }; }

async function withScanSlot(cache, fn) {
  if (cache.running >= LIVE_MAX_CONCURRENT) await new Promise((r) => cache.waiters.push(r));
  cache.running += 1;
  try { return await fn(); } finally { cache.running -= 1; const next = cache.waiters.shift(); if (next) next(); }
}

async function liveSummaries({ rtdb, keyer, cache }, rid, liveDates, nowMs) {
  void nowMs;
  const c = cache || makeLiveCache();
  const key = liveDates.join(',');
  const t = c.clock();
  let e = c.entries.get(key);
  if (e && e.state === 'failed' && t - e.doneAt < LIVE_BACKOFF_MS) {
    throw Object.assign(new Error('stats_live_backoff'), { code: 'stats_live_backoff' });
  }
  const reusable = e && (e.state === 'pending' || (e.state === 'ok' && t - e.doneAt < LIVE_TTL_MS));
  if (!reusable) {
    const fromMs = T.dayStartMs(liveDates[0]) - T.READ_PAD_MS;
    const toMs = T.dayEndMs(liveDates[liveDates.length - 1]);
    const entry = { state: 'pending', startedAt: t, doneAt: null, built: new Map() };
    entry.orders = withScanSlot(c, () => { c.scans += 1; return readOrdersBounded(rtdb, fromMs, toMs, LIVE_BUDGET); })
      .then((r) => { entry.state = 'ok'; entry.doneAt = c.clock(); return r.orders; },
        (err) => { entry.state = 'failed'; entry.doneAt = c.clock(); throw err; });
    entry.orders.catch(() => {});
    e = entry;
    c.entries.set(key, e);
    for (const [k, x] of c.entries) if (k !== key && x.state !== 'pending' && t - x.doneAt >= Math.max(LIVE_TTL_MS, LIVE_BACKOFF_MS)) c.entries.delete(k);   // bounded
  }
  const orders = await e.orders;
  if (!e.built.has(rid)) e.built.set(rid, buildFor(orders, rid, liveDates, keyer));
  return e.built.get(rid);
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
  if (p.cursor != null && !CURSOR_RE.test(p.cursor)) return { error: bad('bad_cursor') };
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
  // OWNER RULING 2026-10-05 (supersedes the plan's "complete existing policy"): sales stats are
  // OWNER-ONLY — kitchen staff and dispatchers are refused, in every form (JSON, daily CSV, orders CSV).
  // Same shape as catalog/portal-reads.js getEditableCatalogCore.
  if (auth.role !== 'owner') return reply(403, { error: 'not_owner', detail: 'sales stats are visible to restaurant owners' });

  const { p, error } = parseParams(q, nowMs);
  if (error) return error;

  let keyer;
  try { keyer = getKeyer(); } catch (e) { return reply(503, { error: 'stats_unavailable', retryable: false }); }   // secret fails CLOSED

  if (p.format === 'csv' && p.kind === 'orders') return ordersCsv({ rtdb, keyer }, rid, p);

  const cmp = compareRange(p);
  const yesterday = T.addDays(p.today, -1);
  const read = async () => {
    const meta1 = await S.readMeta(fsdb, rid);
    const periodDates = T.datesBetween(p.from, p.to);
    const cmpDates = cmp ? T.datesBetween(cmp.from, cmp.to) : [];
    // YESTERDAY IS ALWAYS READ (codex build r1 #1): whether it is settled decides the live overlay even
    // when the request does not include it (a customer who bought yesterday and again today is RETURNING).
    const stored = [...new Set([...periodDates, ...cmpDates, yesterday])].filter((d) => d < p.today);
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

  // LIVE: today, plus yesterday while it is NOT yet settled (00:00 → the nightly run) — decided from the
  // stored doc, independently of the requested period.
  const liveDates = [];
  if (!r.byDateStored.has(yesterday)) liveDates.push(yesterday);
  liveDates.push(p.today);
  // The scan runs ONLY when it can change the answer: when the period or comparison includes a live
  // date. A purely historical request is fully determined by stored days — a customer buying inside it
  // has a stored Sale there, so a later live date can never be their first.
  const requested = new Set([...r.periodDates, ...r.cmpDates]);
  const needLive = liveDates.some((d) => requested.has(d));
  let live = new Map();
  if (needLive) {
    try { live = await liveSummaries({ rtdb, keyer, cache: liveCache }, rid, liveDates, nowMs); }
    catch (e) {
      console.warn('stats_live_unavailable', JSON.stringify({ rid, code: e.code || null }));
      return reply(503, { error: 'stats_live_unavailable', retryable: true });
    }
  }
  const byDate = new Map(r.byDateStored);
  if (!requested.has(yesterday) && r.byDateStored.has(yesterday)) byDate.delete(yesterday);   // read only for the settlement check
  if (needLive) for (const d of liveDates) byDate.set(d, live.get(d) || B.emptySummary());

  // Index with the live overlay (in memory): every live date's stored membership is replaced.
  const firsts = firstDatesWithOverlay(r.shards, needLive ? new Map(liveDates.map((d) => [d, Object.keys((byDate.get(d) || {}).customers || {})])) : new Map());

  const dayInfo = (d) => (needLive && liveDates.includes(d) ? 'live' : byDate.has(d) ? isoOf(byDate.get(d).computed_at) : null);
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

/* 🔴 CONTINUATION CURSORS ARE AUTHENTICATED, BOUND AND RANGE-CHECKED (codex build r1 #7, r2 S7').
   A cursor is `<created_at>:<key>:<tag>`, tag = HMAC(server-secret-derived cursor key,
   "csv-cursor-v1|rid|from|to|created_at|key") — a client cannot recompute it, so it cannot move a
   cursor, or re-target it at another restaurant or range. It is accepted only for the SAME restaurant
   and range, and only if created_at lies inside that range's padded read window. */
const CURSOR_RE = /^(\d{1,16}):([A-Za-z0-9_-]{1,80}):([0-9a-f]{32})$/;
const cursorTag = (keyer, rid, p, v, k) => keyer.cursorTag(`${rid}|${p.from}|${p.to}|${v}|${k}`);
const makeCursor = (keyer, rid, p, v, k) => `${v}:${k}:${cursorTag(keyer, rid, p, v, k)}`;
const tagEq = (a, b) => a.length === b.length && require('crypto').timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function ordersCsv({ rtdb, keyer }, rid, p) {
  if (T.daysBetween(p.from, p.to) + 1 > ORDERS_CSV_MAX_DAYS) return bad('range_too_long', `orders CSV: max ${ORDERS_CSV_MAX_DAYS} days per export`);
  const fromMs = T.dayStartMs(p.from) - T.READ_PAD_MS, toMs = T.dayEndMs(p.to);
  let q = rtdb.ref('orders').orderByChild('created_at');
  if (p.cursor) {
    const [, vs, k, tag] = CURSOR_RE.exec(p.cursor);
    const v = Number(vs);
    if (!tagEq(tag, cursorTag(keyer, rid, p, vs, k))) return bad('bad_cursor', 'cursor was issued for another restaurant or range');
    if (!(v >= fromMs && v < toMs)) return bad('bad_cursor', 'cursor outside the export range');
    q = q.startAfter(v, k);
  } else q = q.startAt(fromMs);
  let snap;
  try { snap = await q.endBefore(toMs).limitToFirst(ORDERS_CSV_PAGE).once('value'); }
  catch (e) { return reply(503, { error: 'stats_unavailable', retryable: true }); }
  const rows = [ORDER_COLUMNS];
  let got = 0, last = null;
  snap.forEach((child) => {
    got += 1;
    const o = child.val();
    last = (o && Number.isFinite(o.created_at)) ? makeCursor(keyer, rid, p, o.created_at, child.key) : last;
    if (!o || B.ridOf(o) !== rid) return;
    const ms = T.serviceMs(o); if (ms === null) return;
    const d = T.dateOf(ms); if (d < p.from || d > p.to) return;
    rows.push(orderRow(o));
  });
  const next = got === ORDERS_CSV_PAGE ? last : null;
  return { status: 200, contentType: 'text/csv; charset=utf-8', body: csv(rows), filename: `pedidos_${rid}_${p.from}_${p.to}.csv`, headers: next ? { 'X-Next-Cursor': next } : {} };
}

module.exports = { getSalesStatsCore, makeLiveCache, liveSummaries, makeCursor, LIVE_BACKOFF_MS, LIVE_MAX_CONCURRENT, parseParams, compareRange, csvCell, orderRow, ORDER_COLUMNS, MAX_RANGE_DAYS, ORDERS_CSV_MAX_DAYS, ORDERS_CSV_PAGE, LIVE_TTL_MS };
