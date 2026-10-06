// Stats S2 — the "Ventas" page's DECISIONS, in a module free of DOM and SDK imports (same split as
// portal-logic.js): periods, Spanish formatting, the view model built from the S1 getSalesStats response,
// and the CSV header allowlist. ventas.js does only the DOM plumbing.
//
// Nothing here computes a sale. Every number comes from the server (PLAN-stats S1: sales = the platform's
// [[Sale]]); this module only chooses what to ask for and how to say it.

const DAY_MS = 86400000;
const TZ_OFFSET_MS = 6 * 3600000;   // America/Tegucigalpa, fixed UTC−6 (the S1 API is pinned to it too)

export const DAYS_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DAYS_LONG = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const PRESETS = [
  ['today', 'Hoy'], ['yesterday', 'Ayer'], ['7d', 'Últimos 7 días'], ['30d', 'Últimos 30 días'],
  ['month', 'Este mes'], ['custom', 'Personalizado'],
];
export const COMPARES = [['previous', 'Período anterior'], ['previous_week', 'Mismo día, semana pasada'], ['none', 'Sin comparar']];
export const MAX_RANGE_DAYS = 731;        // the API caps a request at two years
export const ORDERS_CSV_MAX_DAYS = 31;    // the API serves per-order CSV ≤ 31 days per export

const pad2 = (n) => String(n).padStart(2, '0');
const parse = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
const fmt = (u) => { const t = new Date(u); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`; };
export const isDate = (d) => { const u = parse(d); return u !== null && fmt(u) === d; };
export const addDays = (d, n) => fmt(parse(d) + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY_MS);
export const todayHN = (nowMs) => fmt(Math.floor((nowMs - TZ_OFFSET_MS) / DAY_MS) * DAY_MS);
const weekday = (d) => (new Date(parse(d)).getUTCDay() + 6) % 7;   // 0 = Monday
const dayNum = (d) => new Date(parse(d)).getUTCDate();
const monthIx = (d) => new Date(parse(d)).getUTCMonth();

// The date range a preset means, today being `today` (Honduras). custom → the caller's validated pair.
export function rangeFor(preset, today, custom = null) {
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
    case 'custom': return custom;
    default: return null;
  }
}

// A custom range a merchant typed: both dates, in order, not in the future, ≤ the API cap.
export function validateCustom(from, to, today) {
  if (!isDate(from) || !isDate(to)) return { ok: false, error: 'Elegí las dos fechas.' };
  if (to < from) return { ok: false, error: 'La fecha final es anterior a la inicial.' };
  if (to > today) return { ok: false, error: 'La fecha final no puede ser futura.' };
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return { ok: false, error: 'Elegí un período de hasta dos años.' };
  return { ok: true, range: { from, to } };
}

export const isSingleDay = (r) => !!r && r.from === r.to;
// The comparison a preset opens with (mockup): one day → the same weekday last week; otherwise the period before.
export const defaultCompare = (r) => (isSingleDay(r) ? 'previous_week' : 'previous');
// Day buckets read best up to a quarter; then weeks; past ~13 months, months.
export function granularityFor(r) {
  const n = daysBetween(r.from, r.to) + 1;
  return n <= 92 ? 'day' : n <= 400 ? 'week' : 'month';
}

// ── Spanish formatting (es-HN) ──────────────────────────────────────────────────────────────────
const group = (n) => {   // 38146 → "38,146" (es-HN, comma thousands)
  const d = String(Math.abs(Math.round(n)));
  let out = '';
  for (let i = 0; i < d.length; i++) out += (i && (d.length - i) % 3 === 0 ? ',' : '') + d[i];
  return out;
};
export const lempiras = (cents) => (Number.isFinite(cents) ? `L ${cents < 0 ? '-' : ''}${group(cents / 100)}` : '—');
export const count = (n) => (Number.isFinite(n) ? group(n) : '—');
export const pct1 = (p) => (Number.isFinite(p) ? `${(Math.round(Math.abs(p) * 10) / 10).toFixed(1)}%` : '—');
export const pct0 = (p) => (Number.isFinite(p) ? `${Math.round(p)}%` : '—');
export const minutes = (ms) => (Number.isFinite(ms) ? Math.round(ms / 60000) : null);
export const dayLabel = (d) => `${DAYS_SHORT[weekday(d)]} ${dayNum(d)} ${MONTHS[monthIx(d)]}`;          // "Lun 5 oct"
export const dayShort = (d) => `${DAYS_SHORT[weekday(d)]} ${dayNum(d)}`;                                // "Lun 29"
export function rangeLabel(r) {
  if (!r) return 'Elegir fechas…';
  if (r.from === r.to) return dayLabel(r.from);
  const sameMonth = r.from.slice(0, 7) === r.to.slice(0, 7);
  return sameMonth
    ? `${dayNum(r.from)} – ${dayNum(r.to)} ${MONTHS[monthIx(r.to)]}`
    : `${dayNum(r.from)} ${MONTHS[monthIx(r.from)]} – ${dayNum(r.to)} ${MONTHS[monthIx(r.to)]}`;
}
export function vsLabel(compare, r) {
  if (compare === 'none') return '';
  if (compare === 'previous_week') return isSingleDay(r) ? `vs. ${DAYS_LONG[weekday(r.from)]} pasado` : 'vs. semana anterior';
  return 'vs. período anterior';
}
// "Actualizado: …" from the server's per-day computed_at — "en vivo" when the period includes today.
export function updatedLabel(days, nowMs) {
  const list = Array.isArray(days) ? days : [];
  if (list.some((d) => d && d.computed_at === 'live')) return 'en vivo';
  const stamps = list.map((d) => d && Date.parse(d.computed_at)).filter(Number.isFinite);
  if (!stamps.length) return null;
  const t = Math.max(...stamps);
  const local = new Date(t - TZ_OFFSET_MS);
  const hhmm = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  const day = todayHN(t), today = todayHN(nowMs);
  if (day === today) return `hoy ${hhmm}`;
  if (day === addDays(today, -1)) return `ayer ${hhmm}`;
  return `${dayNum(day)} ${MONTHS[monthIx(day)]} ${hhmm}`;
}
// Days the server has not computed yet (never zero-filled) — the stale-data note.
export const missingLabel = (missing) => (Array.isArray(missing) && missing.length ? missing.map((d) => `${dayNum(d)} ${MONTHS[monthIx(d)]}`).join(', ') : '');

// ── the view model ──────────────────────────────────────────────────────────────────────────────
function delta(p) {
  if (!Number.isFinite(p)) return { text: '—', up: false, down: false };
  return { text: pct1(p), up: p >= 0, down: p < 0 };
}

// Chart points in the mockup's 1000×260 box (y: 258 = zero, 8 = the 115% headroom top).
export function points(values, max) {
  const n = values.length;
  if (!n || !(max > 0)) return values.map((_, i) => `${n > 1 ? Math.round(i * 1000 / (n - 1)) : 500},258`).join(' ');
  return values.map((v, i) => `${n > 1 ? Math.round(i * 1000 / (n - 1)) : 500},${Math.round(258 - (v / max) * 250)}`).join(' ');
}

// The hours that had orders in ANY of the given heatmaps (12–22 when none did). The single-day chart
// passes both periods: a window taken from today alone flattens a comparison whose orders fell at
// other hours to zero.
function hourWindow(...heatmaps) {
  let lo = 24, hi = -1;
  for (const hm of heatmaps) for (const row of hm || []) (row || []).forEach((c, h) => { if (c && c.orders > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); } });
  return hi < 0 ? [12, 22] : [lo, hi];
}

export function viewModel(body, { range, compare, metric, nowMs }) {
  const b = body || {};
  const k = b.kpis || {};
  const d = b.deltas || {};
  const cmp = compare !== 'none' && b.comparison ? b.comparison : null;
  const vs = vsLabel(compare, range);
  const kpis = [
    ['Ventas', lempiras(k.sales_cents), d.sales_pct],
    ['Pedidos', count(k.orders), d.orders_pct],
    ['Ticket promedio', lempiras(k.average_paid_ticket_cents), d.average_paid_ticket_pct],
  ].map(([label, value, p]) => ({ label, value, vs, showDelta: !!cmp, ...delta(p) }));

  // Trend: one point per bucket; a single day reads by HOUR (that day's row of the heatmap).
  const metricKey = metric === 'orders' ? 'orders' : 'sales_cents';
  let cur, prev, labels;
  if (isSingleDay(range)) {
    const wd = weekday(range.from);
    const [lo, hi] = hourWindow(b.heatmap, cmp && cmp.heatmap);
    const hrs = []; for (let h = lo; h <= hi; h++) hrs.push(h);
    const val = (hm, wdx, h) => { const c = hm && hm[wdx] && hm[wdx][h]; return c ? (metric === 'orders' ? c.orders : c.cents) : 0; };
    cur = hrs.map((h) => val(b.heatmap, wd, h));
    prev = cmp ? hrs.map((h) => val(cmp.heatmap, weekday(cmp.range.from), h)) : [];
    labels = hrs.map((h) => `${h}:00`);
  } else {
    const s = Array.isArray(b.series) ? b.series : [];
    cur = s.map((x) => x[metricKey] || 0);
    prev = cmp ? (cmp.series || []).map((x) => x[metricKey] || 0) : [];
    labels = s.map((x) => (/^\d{4}-\d{2}-\d{2}$/.test(x.key) ? dayShort(x.key) : `${MONTHS[+x.key.slice(5, 7) - 1]} ${x.key.slice(0, 4)}`));
  }
  const max = Math.max(0, ...cur, ...prev) * 1.15;
  // ≤ 7 x labels, evenly sampled, first and last always shown (the mockup's 7-column label row)
  const nl = Math.min(7, labels.length);
  const xLabels = nl <= 1 ? labels.slice(0, nl) : Array.from({ length: nl }, (_, i) => labels[Math.round((i * (labels.length - 1)) / (nl - 1))]);

  const items = (b.items || []).filter((it) => it && !it.reward && it.cents > 0).slice(0, 5);
  // ranked by revenue (server order); each bar is its units against the most units shown (mockup)
  const topQty = Math.max(0, ...items.map((it) => it.qty || 0));
  const topItems = items.map((it) => ({ name: it.name, qty: `${count(it.qty)} u.`, amount: lempiras(it.cents), width: topQty ? Math.round(((it.qty || 0) / topQty) * 100) : 0 }));

  const bt = b.by_type || {};
  const typeTotal = ['delivery', 'pickup'].reduce((a, t) => a + ((bt[t] && bt[t].cents) || 0), 0);
  const typeSplit = ['delivery', 'pickup'].map((t) => {
    const c = (bt[t] && bt[t].cents) || 0;
    return { label: t === 'delivery' ? 'A domicilio' : 'Para recoger', share: typeTotal ? Math.round((c / typeTotal) * 100) : 0, amount: lempiras(c) };
  });

  const bp = b.by_payment || {};
  const payTotal = ['cash', 'card_delivery', 'online', 'other'].reduce((a, m) => a + ((bp[m] && bp[m].cents) || 0), 0);
  const payments = [['cash', 'Efectivo'], ['card_delivery', 'Tarjeta al entregar'], ['online', 'En línea'], ['other', 'Otro']]
    .filter(([m]) => m !== 'other' || ((bp.other && bp.other.orders) || 0) > 0)
    .map(([m, label]) => { const c = (bp[m] && bp[m].cents) || 0; const share = payTotal ? Math.round((c / payTotal) * 100) : 0; return { label, value: `${share}% · ${lempiras(c)}`, width: share }; });

  // Heatmap: Mon..Sun × the hours that had orders (12–22 when there are none).
  const [lo, hi] = hourWindow(b.heatmap);
  const hours = []; for (let h = lo; h <= hi; h++) hours.push(h);
  let peak = null, peakMax = 0;
  for (let w = 0; w < 7; w++) for (const h of hours) { const o = (((b.heatmap || [])[w] || [])[h] || {}).orders || 0; if (o > peakMax) { peakMax = o; peak = { w, h }; } }
  const heat = DAYS_SHORT.map((day, w) => ({
    day,
    cells: hours.map((h) => {
      const o = (((b.heatmap || [])[w] || [])[h] || {}).orders || 0;
      return { orders: o, alpha: o === 0 ? 0.05 : Math.min(1, 0.12 + (o / Math.max(1, peakMax)) * 0.88), label: `${day} ${h}:00, ${count(o)} pedidos` };
    }),
  }));
  const peakNote = peak ? `Pedidos por día y hora · hora de Honduras · pico: ${DAYS_LONG[peak.w]} ${peak.h}:00, ${count(peakMax)} pedidos` : 'Pedidos por día y hora · hora de Honduras';

  const cu = b.customers || {};
  const nw = cu.new || {}, rt = cu.returning || {};
  const idCents = (nw.cents || 0) + (rt.cents || 0);
  const customers = [
    { label: 'Nuevos', value: count(nw.customers || 0), share: `${pct0(idCents ? ((nw.cents || 0) / idCents) * 100 : 0)} de las ventas` },
    { label: 'Recurrentes', value: count(rt.customers || 0), share: `${pct0(idCents ? ((rt.cents || 0) / idCents) * 100 : 0)} de las ventas` },
  ];

  const ca = b.cancellations || {};
  const cell = (x) => `${count((x && x.orders) || 0)} · ${lempiras((x && x.cents) || 0)}`;
  const cancellations = {
    rate: Number.isFinite(ca.rate_pct) ? pct1(ca.rate_pct) : '0.0%',
    rows: [{ label: 'Canceladas', value: cell(ca.cancelled) }, { label: 'Reembolsadas', value: cell(ca.refunded) }, { label: 'Reembolso pendiente', value: cell(ca.refund_pending), warn: true }],
  };

  const tm = b.times || {};
  const timeRow = (label, t) => ({ label, value: t && minutes(t.avg_ms) !== null ? `${minutes(t.avg_ms)} min` : '—', typical: t && t.median ? `típico ${minutes(t.median.approx_ms)}` : '' });
  const covs = [tm.prep, tm.delivery].map((t) => t && t.coverage).filter(Number.isFinite);
  const times = { rows: [timeRow('Preparación', tm.prep), timeRow('Entrega', tm.delivery)], coverage: covs.length ? `Pedidos a domicilio con tiempos completos: ${pct0(Math.min(...covs))}` : '' };

  const updated = updatedLabel(b.days, nowMs);
  const missing = missingLabel(b.missing_days);
  const empty = !(k.orders > 0) && !((ca.cancelled && ca.cancelled.orders) || (ca.refunded && ca.refunded.orders) || (ca.refund_pending && ca.refund_pending.orders));

  return {
    kpis, chart: { cur: points(cur, max), prev: cmp ? points(prev, max) : '', xLabels, aria: `${metric === 'orders' ? 'Pedidos' : 'Ventas'} por ${isSingleDay(range) ? 'hora' : ({ week: 'semana', month: 'mes' }[granularityFor(range)] || 'día')}, período actual${cmp ? ' y comparación' : ''}` },
    showCompare: !!cmp, topItems, typeSplit, payments, hours, heat, peakNote, customers, cancellations, times, updated, missing, empty,
  };
}

// ── the CSV allowlist (defence in depth for the S1 server allowlist) ────────────────────────────
// The portal saves a CSV only if its header is EXACTLY the reviewed column list for that kind. The
// server already enforces this (stats-api.js ORDER_COLUMNS + the daily writer); a mismatch here means the
// contract changed, and the file is not handed to the merchant (no phone/name/address can leak into one).
export const CSV_HEADERS = {
  daily: ['fecha', 'ventas_L', 'pedidos', 'ticket_promedio_L', 'subtotal_L', 'isv_L', 'efectivo_L', 'tarjeta_entrega_L', 'en_linea_L', 'otro_L', 'domicilio_pedidos', 'recoger_pedidos', 'cancelados', 'reembolsados', 'reembolso_pendiente', 'sin_resolver', 'clientes', 'clientes_nuevos', 'calculado'],
  orders: ['fecha', 'hora', 'numero', 'tipo', 'metodo_pago', 'clase', 'total_L', 'subtotal_L', 'isv_L', 'articulos'],
};
export function csvHeaderOk(kind, text) {
  const want = CSV_HEADERS[kind];
  if (!want || typeof text !== 'string') return false;
  const first = text.split(/\r?\n/, 1)[0];
  return first === want.join(',');
}
// Pages of the per-order CSV joined into one file: the header once, then every page's rows.
export function joinCsvPages(pages) {
  const out = [];
  pages.forEach((t, i) => { const lines = t.replace(/\r\n$/, '').split('\r\n'); out.push(...(i === 0 ? lines : lines.slice(1))); });
  return `${out.join('\r\n')}\r\n`;
}
export const csvFilename = (kind, rid, r) => `${kind === 'orders' ? 'pedidos' : 'ventas'}_${rid}_${r.from}_${r.to}.csv`;

// A typed API failure → a sentence (Ventas wording; same shape as portal-logic.js messageFor).
export function ventasMessage(kind, code) {
  if (kind === 'NotAuthorized') return code === 'not_owner'
    ? ['Solo el dueño ve las ventas', 'Esta sección es para la cuenta dueña del local.']
    : ['No tenés acceso a este local', 'Tu cuenta no administra este local.'];
  return {
    NotSignedIn: ['Tu sesión expiró', 'Ingresá de nuevo para continuar.'],
    BadRequest: ['Ese período no es válido', 'Elegí otras fechas.'],
    Unavailable: ['No pudimos cargar las ventas', 'Es un problema nuestro, no tuyo. Probá de nuevo en un momento.'],
  }[kind] || ['Algo salió mal', 'Probá de nuevo en un momento.'];
}
