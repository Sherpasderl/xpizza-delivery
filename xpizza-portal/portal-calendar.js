// THE portal's date picker (one source): Sunday-first, Spanish, ‹ month ▾ year ▾ ›, today dotted, days outside [min, max] inert, a
// chosen day ringed, a range painted (its start / end and the days between; while hovering, up to the hovered day). Built for «Ventas»
// › «Personalizado» (MOCKUP-portal-rendimiento-ventas-delta frame 4: «the portal's standard calendar»); the Ofertas builder's calendar
// (marketing-builder.js, MOCKUP-portal-marketing v5) is the same picker and moves onto this module when the two branches meet.
// Every visual state is a real element (the ring, the dot) — no colour on a pseudo-element. Dates are 'YYYY-MM-DD'.
import { el, svg } from './ops-dom.js';

export const MONTHS_CAL = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const WK = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá'];
const PREV = 'M15 18l-6-6 6-6', NEXT = 'M9 6l6 6-6 6', DOWN = 'M6 9l6 6 6-6';
const pad = (n) => String(n).padStart(2, '0');
export const ymdOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const dowSun = (date) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10))).getUTCDay();

// the month's cells → { lead, days: [{ date, n, disabled, today, on, rs, re, inr, hov }] }. st: { y, m, min, max, today, sel, from, to, hover }
export function monthModel(st) {
  const first = ymdOf(st.y, st.m, 1);
  const len = new Date(Date.UTC(st.y, st.m + 1, 0)).getUTCDate();
  const end = st.to || (st.from && st.hover && st.hover >= st.from ? st.hover : null);
  const days = [];
  for (let n = 1; n <= len; n++) {
    const date = ymdOf(st.y, st.m, n);
    const span = !!(st.from && end && end > st.from);
    days.push({ date, n, disabled: (st.min && date < st.min) || (st.max && date > st.max) || false, today: date === st.today, on: date === st.sel,
      rs: span && date === st.from, re: span && date === end, inr: span && date >= st.from && date <= end, hov: !st.to && date === st.hover });
  }
  return { lead: dowSun(first), days };
}
// st (above) + years: [y…]; h: { nav(±1), month(m), year(y), pick(date), hover(date|null) } → the popover element
export function calendarPopover(st, h, label = 'Elegir fecha') {
  const pop = el('div', 'cal-pop'); pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', label);
  const hd = el('div', 'cal-hd');
  const nav = (dir, d, aria) => { const b = el('button', 'cal-nav'); b.type = 'button'; b.setAttribute('aria-label', aria); b.append(svg(d)); b.addEventListener('click', () => h.nav(dir)); return b; };
  const minYm = st.min ? st.min.slice(0, 7) : null, maxYm = st.max ? st.max.slice(0, 7) : null, ym = `${st.y}-${pad(st.m + 1)}`;
  const prev = nav(-1, PREV, 'Mes anterior'); prev.disabled = !!(minYm && ym <= minYm);
  const next = nav(1, NEXT, 'Mes siguiente'); next.disabled = !!(maxYm && ym >= maxYm);
  const sels = el('div', 'cal-sels');
  const select = (aria, opts, cur, on) => {
    const w = el('span', 'cal-selw'); const s = el('select', 'cal-select'); s.setAttribute('aria-label', aria);
    for (const [v, t] of opts) { const o = el('option', null, t); o.value = String(v); if (v === cur) o.selected = true; s.append(o); }
    s.addEventListener('change', () => on(Number(s.value)));
    w.append(s, svg(DOWN)); return w;
  };
  sels.append(select('Mes', MONTHS_CAL.map((t, i) => [i, t]), st.m, h.month), select('Año', st.years.map((y) => [y, String(y)]), st.y, h.year));
  hd.append(prev, sels, next);
  const wk = el('div', 'cal-wk'); wk.setAttribute('aria-hidden', 'true'); for (const d of WK) wk.append(el('span', null, d));
  const grid = el('div', 'cal-grid'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Días del mes');
  const mm = monthModel(st);
  for (let i = 0; i < mm.lead; i++) grid.append(el('span', 'cal-lead'));
  for (const d of mm.days) {
    const cls = ['cal-d', d.on && 'cal-on', d.inr && 'cal-inr', d.rs && 'cal-rs', d.re && 'cal-re', d.hov && 'cal-hov'].filter(Boolean).join(' ');
    const b = el('button', cls); b.type = 'button'; b.disabled = !!d.disabled; b.dataset.date = d.date;
    if (d.inr) b.append(el('span', 'cal-band'));
    b.append(el('span', 'cal-ring'), el('span', 'cal-num', String(d.n)));
    if (d.today) b.append(el('i', 'cal-tdot'));
    b.addEventListener('click', () => { if (!b.disabled) h.pick(d.date); });
    b.addEventListener('mouseover', () => { if (!b.disabled && h.hover) h.hover(d.date); });
    grid.append(b);
  }
  pop.append(hd, wk, grid);
  return pop;
}
