// «Rendimiento» · Ventas — the tab's own DECISIONS (PLAN-portal-rendimiento-r0, advisor ACCEPTED 11-14), DOM-free. Its own module:
// ventas-logic.js is byte-frozen (portalui-guards «the editor, review, render, auth and logic modules are byte-identical to the
// base»), so the shipped page's PRESETS / rangeFor / viewModel are read from there and never edited.
import { rangeFor, addDays, isDate } from './ventas-logic.js';

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
