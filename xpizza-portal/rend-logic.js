// «Rendimiento» · Ventas — the tab's own DECISIONS (PLAN-portal-rendimiento-r0, advisor ACCEPTED 11-14), DOM-free. Its own module:
// ventas-logic.js is byte-frozen (portalui-guards «the editor, review, render, auth and logic modules are byte-identical to the
// base»), so the shipped page's PRESETS / rangeFor / viewModel are read from there and never edited.
import { rangeFor, addDays, isDate, daysBetween, todayHN, isSingleDay, granularityFor, lempiras, count } from './ventas-logic.js';
import { clock12 } from './portal-time.js';

// Q2: exactly the mockup's set (MOCKUP-portal-map s-rend :866-867), «Últimos 14 días» by default; «Ayer» / «Este mes» stay reachable
// through «Personalizado».
export const REND_PRESETS = [['today', 'Hoy'], ['7d', 'Últimos 7 días'], ['14d', 'Últimos 14 días'], ['30d', 'Últimos 30 días'], ['custom', 'Personalizado']];
export const REND_DEFAULT_PRESET = '14d';
// the shipped rangeFor, plus the one preset it does not know
export const rendRangeFor = (preset, today, custom = null) => (preset === '14d' ? { from: addDays(today, -13), to: today } : rangeFor(preset, today, custom));
// Q3: «Productos más vendidos» counts UNITS (the server's items[].qty, stats-api.js:135-137) — never «Pedidos» (no per-product order
// count exists; an honest label, no new aggregate)
export const TOP_QTY_LABEL = 'Vendidos';

// The same «nothing to show» rule the shipped viewModel applies (its `empty`, ventas-logic.js), for a body not modelled yet
export function bodyEmpty(b) {
  const k = (b && b.kpis) || {}, ca = (b && b.cancellations) || {};
  return !(k.orders > 0) && !((ca.cancelled && ca.cancelled.orders) || (ca.refunded && ca.refunded.orders) || (ca.refund_pending && ca.refund_pending.orders));
}
// A stats answer → the tab's STATE: { state: 'ok' | 'empty' | 'unavailable' | 'denied' | 'error', missing: [YYYY-MM-DD] }.
// `missing` (days the server has not computed, never zero-filled) rides WITH data — the note, not a replacement for it. A 503
// (incl. «Todas» refused as a whole) or a transport failure is `unavailable` (retryable); 401 / 403 `denied`.
export function statsState(res) {
  if (!res || res.error) {
    const st = res && res.error ? res.error.status : 0;
    return { state: st === 503 || st === 0 ? 'unavailable' : st === 401 || st === 403 ? 'denied' : 'error', missing: [] };
  }
  const b = res.body;
  if (!b || typeof b !== 'object' || !b.kpis) return { state: 'error', missing: [] };
  const missing = Array.isArray(b.missing_days) ? b.missing_days.filter(isDate) : [];
  return { state: bodyEmpty(b) ? 'empty' : 'ok', missing };
}

// ═══ V1 · the tab's drawing model (MOCKUP-portal-rendimiento-ventas-delta, owner-APPROVED 11-14; PLAN-portal-ventas-draw-r0) ═════════
// Every figure is the server's (stats-api.js @ d601ce505): series keyed by day / week start (Monday) / month, the heatmap for one day,
// missing_days never zero-filled, days[].computed_at for freshness. Nothing here adds buckets up.
const MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MON_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WD_L = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const HN_MS = 6 * 3600000;
const dnum = (d) => +d.slice(8, 10);
const mix = (d) => +d.slice(5, 7) - 1;
const yr = (d) => +d.slice(0, 4);
const dm = (d) => `${dnum(d)} ${MON[mix(d)]}`;
const dowSun = (d) => new Date(Date.UTC(yr(d), mix(d), dnum(d))).getUTCDay();   // 0 = domingo
const monFirst = (d) => (dowSun(d) + 6) % 7;                                     // the server's heatmap rows: Lun … Dom
const pedidos = (n) => `${count(n)} ${n === 1 ? 'pedido' : 'pedidos'}`;
// the mockup's nice steps, in lempiras: the y-scale is the data rounded UP to 4 of them
export const NICE_STEPS_L = [250, 300, 400, 500, 600, 750, 800, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 8000, 10000, 12000, 15000, 20000, 25000, 30000, 40000, 50000, 60000, 75000, 100000];
export const niceStepL = (q) => NICE_STEPS_L.find((x) => x >= q) || Math.ceil(q / 100000) * 100000;
const TITLE = Object.freeze({ hour: 'Ventas por hora', day: 'Ventas por día', week: 'Ventas por semana', month: 'Ventas por mes' });

function hourBuckets(b, range, nowMs) {
  const row = (Array.isArray(b.heatmap) && b.heatmap[monFirst(range.from)]) || [];
  let lo = 12, hi = 22;   // the shipped window, widened only by hours that had orders
  row.forEach((c, h) => { if (c && c.orders > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); } });
  const isToday = range.from === todayHN(nowMs);
  const cur = isToday ? Math.floor(((nowMs - HN_MS) % 86400000) / 3600000) : 24;
  const out = [];
  for (let h = lo; h <= hi; h++) {
    const label = `${h}:00`;
    if (h > cur) { out.push({ label, cents: null, orders: null, k: 'future', tip: null }); continue; }
    const c = row[h] || {};
    const k = h === cur ? 'partial' : 'ok';
    out.push({ label, cents: c.cents || 0, orders: c.orders || 0, k, tip: { strong: lempiras(c.cents || 0), rest: `${h}:00 – ${h + 1}:00 · ${pedidos(c.orders || 0)}${k === 'partial' ? ' · en curso' : ''}` } });
  }
  return out;
}
function periodBuckets(b, range, kind, nowMs) {
  const today = todayHN(nowMs);
  const miss = new Set(Array.isArray(b.missing_days) ? b.missing_days : []);
  const series = new Map((Array.isArray(b.series) ? b.series : []).map((x) => [x.key, x]));
  const keyOf = (d) => (kind === 'day' ? d : kind === 'week' ? addDays(d, -monFirst(d)) : d.slice(0, 7));
  const groups = [];   // [{ key, days[] }] in order, each clipped to the range
  for (let d = range.from; daysBetween(d, range.to) >= 0; d = addDays(d, 1)) {
    const k = keyOf(d);
    if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, days: [] });
    groups[groups.length - 1].days.push(d);
  }
  let prevMonth = null;
  return groups.map((g) => {
    const start = g.days[0], end = g.days[g.days.length - 1];
    const full = kind === 'day' ? 1 : kind === 'week' ? 7 : new Date(Date.UTC(yr(start), mix(start) + 1, 0)).getUTCDate();
    const label = kind === 'month' ? `${MON[mix(start)]} ${yr(start)}` : kind === 'week' ? dm(start) : (prevMonth === mix(start) ? String(dnum(start)) : dm(start));
    prevMonth = mix(start);
    const span = kind === 'day' ? dm(start) : kind === 'month' ? `${MON_L[mix(start)]} ${yr(start)}` : (mix(start) === mix(end) ? `${dnum(start)} – ${dm(end)}` : `${dm(start)} – ${dm(end)}`);
    if (g.days.every((d) => miss.has(d))) return { label, cents: null, orders: null, k: 'missing', tip: { strong: span, rest: 'aún sin calcular' } };
    const s = series.get(g.key) || {};
    const running = kind !== 'day' && g.days.includes(today);
    const clipped = kind !== 'day' && g.days.length < full;
    const k = running || clipped ? 'partial' : 'ok';
    const note = running ? ' · en curso' : clipped ? (kind === 'week' ? ' · semana parcial' : ' · mes parcial') : '';
    return { label, cents: s.sales_cents || 0, orders: s.orders || 0, k, tip: { strong: lempiras(s.sales_cents || 0), rest: `${span} · ${pedidos(s.orders || 0)}${note}` } };
  });
}
// a stats body → the chart: { kind, title, buckets: [{ label, cents|null, orders|null, k: ok|partial|missing|future, tip }], ymaxCents,
// ticks (5 values, cents), sparse (> 14 buckets ⇒ a sampled label row) }
export function chartModel(body, { range, nowMs }) {
  const b = body || {};
  const kind = isSingleDay(range) ? 'hour' : granularityFor(range);
  const buckets = kind === 'hour' ? hourBuckets(b, range, nowMs) : periodBuckets(b, range, kind, nowMs);
  const known = buckets.filter((x) => x.k === 'ok' || x.k === 'partial').map((x) => x.cents / 100);
  const step = niceStepL(Math.max(1, ...known) * 1.08 / 4);
  return { kind, title: TITLE[kind], buckets, ymaxCents: step * 4 * 100, ticks: [0, 1, 2, 3, 4].map((t) => t * step * 100), sparse: buckets.length > 14 };
}
// the label row: every bucket up to 14 (the phone hides every other one in CSS); beyond, k sampled (first and last always)
export function shownLabels(n, k) {
  if (n <= 14) return new Set(Array.from({ length: n }, (_, i) => i));
  return new Set(Array.from({ length: k }, (_, j) => Math.round((j * (n - 1)) / (k - 1))));
}

// freshness, never a client clock posing as data: a live day ⇒ when THIS body arrived; else the roll-up's newest stamp
export function freshWords(body, { fetchedAt, nowMs }) {
  const days = body && Array.isArray(body.days) ? body.days : [];
  if (days.some((d) => d && d.computed_at === 'live')) {
    const m = Math.max(0, Math.round((nowMs - fetchedAt) / 60000));
    return `Hoy en vivo · actualizado ${m === 0 ? 'hace un momento' : `hace ${m} min`}`;
  }
  const stamps = days.map((d) => d && Date.parse(d.computed_at)).filter(Number.isFinite);
  if (!stamps.length) return null;
  const t = Math.max(...stamps), day = todayHN(t), today = todayHN(nowMs);
  const when = day === today ? 'hoy' : day === addDays(today, -1) ? 'ayer' : `el ${dm(day)}`;
  return `Calculado ${when}, ${clock12(t)}`;
}
// the range in words: «jueves 12 de noviembre» · «6 – 12 nov 2026» · «30 oct – 12 nov 2026» · «24 dic 2025 – 3 ene 2026»
export function rangeWords(r) {
  if (!r) return '';
  if (r.from === r.to) return `${WD_L[dowSun(r.from)]} ${dnum(r.from)} de ${MON_L[mix(r.from)]}`;
  if (yr(r.from) !== yr(r.to)) return `${dm(r.from)} ${yr(r.from)} – ${dm(r.to)} ${yr(r.to)}`;
  if (mix(r.from) === mix(r.to)) return `${dnum(r.from)} – ${dnum(r.to)} ${MON[mix(r.to)]} ${yr(r.to)}`;
  return `${dm(r.from)} – ${dm(r.to)} ${yr(r.to)}`;
}
// the period pill: the preset's name; a custom range in words, without the year when it is this year
export function pillWords(preset, r, today) {
  const p = REND_PRESETS.find(([id]) => id === preset);
  if (preset !== 'custom') return p ? p[1] : '';
  if (!r) return 'Personalizado';
  const w = rangeWords(r);
  return r.from !== r.to && yr(r.from) === yr(today) && yr(r.to) === yr(today) ? w.replace(/ \d{4}$/, '') : w;
}
export const missingNote = (missing) => (Array.isArray(missing) && missing.length ? `Aún sin calcular: ${missing.map(dm).join(', ')} · los totales de arriba no los incluyen.` : '');
// the three figures on one surface (no deltas on the tab — «Más detalle» carries them); never a number without its answer
export function figures(body, state) {
  if (!body || !['ok', 'empty'].includes(state)) return [['Ventas', '—'], ['Pedidos', '—'], ['Ticket promedio', '—']];
  const k = body.kpis || {};
  return [['Ventas', lempiras(k.sales_cents || 0)], ['Pedidos', count(k.orders || 0)], ['Ticket promedio', k.orders > 0 ? lempiras(k.average_paid_ticket_cents) : '—']];
}
// «Productos más vendidos»: the server's ranking (by sales), rewards dropped as shipped, ≤ 5; units sold + sales; the bar is the sales
// against the top product's (so bar and «Ventas» agree)
export function topProducts(body) {
  const items = ((body && body.items) || []).filter((it) => it && !it.reward && it.cents > 0).slice(0, 5);
  const top = items.length ? items[0].cents : 0;
  return items.map((it) => ({ name: it.name, qty: count(it.qty || 0), sales: lempiras(it.cents), width: top ? Math.round((it.cents / top) * 100) : 0 }));
}
