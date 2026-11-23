// «Inicio» — the portal home's PURE half (PLAN-portal-inicio-r0, APPROVED 11-13; MOCKUP-portal-map.html v3 s-inicio / s-inicio-ok).
// No clock of its own (every `now` is passed in), no DOM. Honduras time throughout (UTC-6 all year, the server's clock). Rule 8: only
// sourced figures — the money / count formats are Ventas' own (ventas-logic.js), the figures are getSalesStats' (compare previous_week).
import { lempiras, count } from './ventas-logic.js';
import { clock12 } from './portal-time.js';   // THE portal clock («3:10 p. m.»; advisor 11-13)
import { knownControl } from './control-state.js';   // THE known control states (one shared list)
import { SUPPORT_WHATSAPP } from './support-contact.js';

// the frames' words are literal; the two greetings the frame does not draw: owner-APPROVED 11-15 (05:00–11:59 / 19:00–04:59)
export const INICIO_COPY = Object.freeze({ goodMorning: 'Buenos días', goodEvening: 'Buenas noches' });
export const inicioCopy = (k) => (typeof INICIO_COPY[k] === 'string' ? INICIO_COPY[k] : `⟦inicio.${k}⟧`);

const HN_OFFSET_MS = 6 * 3600 * 1000;   // America/Tegucigalpa, UTC-6 all year (no DST)
const local = (ms) => new Date(ms - HN_OFFSET_MS);
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ann 1: the greeting by the Honduras clock — «Buenas tardes» as drawn; never a name (Q-I2: no source for one; never the email)
export function greeting(nowMs) {
  const h = local(nowMs).getUTCHours();
  if (h >= 5 && h < 12) return inicioCopy('goodMorning');
  if (h >= 12 && h < 19) return 'Buenas tardes';
  return inicioCopy('goodEvening');
}
// «Resumen de hoy · jueves 12 de noviembre»
export function dateLine(nowMs) {
  const t = local(nowMs);
  return `Resumen de hoy · ${WEEKDAYS[t.getUTCDay()]} ${t.getUTCDate()} de ${MONTHS[t.getUTCMonth()]}`;
}
export const when = (ms) => (Number.isFinite(ms) ? `desde las ${clock12(ms)}` : '');
export const pendLabel = (n) => `${n} ${n === 1 ? 'pendiente' : 'pendientes'}`;

// the ONE read: today against the same weekday last week (stats-api compare 'previous_week' = a 7-day shift)
export const statsQuery = (today) => ({ from: today, to: today, granularity: 'day', compare: 'previous_week' });
export const money = (cents) => lempiras(Number.isFinite(cents) ? cents : NaN);
const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
// ann 1: three figures; the line under Ventas / Pedidos is the same weekday last week (a fact, not a projection); none under Ticket
// Codex backfill item 5: a day the roll-up never computed comes back as zeros with the day in `missing_days` — UNAVAILABLE, never «L 0» /
// «0»; a body with no kpis is the same. (A COMPUTED day with no sales is a fact and reads «L 0».)
export function figures(body, today) {
  if (!body || !body.kpis || typeof body.kpis !== 'object' || (Array.isArray(body.missing_days) && body.missing_days.includes(today))) return NO_FIGURES;
  const k = body && body.kpis ? body.kpis : {};
  const c = body && body.comparison && body.comparison.kpis ? body.comparison.kpis : null;
  const day = weekdayOf(today);
  const vs = (txt, ok) => (c && ok ? { vs: `${txt} el ${day} pasado` } : {});
  return {
    sales: { value: money(k.sales_cents), ...vs(money(c && c.sales_cents), c && Number.isFinite(c.sales_cents)) },
    orders: { value: count(k.orders), ...vs(count(c && c.orders), c && Number.isFinite(c.orders)) },
    ticket: { value: money(k.average_paid_ticket_cents) },
  };
}
export const NO_FIGURES = Object.freeze({ sales: { value: '—' }, orders: { value: '—' }, ticket: { value: '—' } });
// Codex backfill item 6: «Todo en orden» claims only over KNOWN results — every in-scope branch's control readable (a known state) and its
// pending_count a number (S3; absent / null = unknown). `scopeRid` null = every branch the page shows.
export function allKnown(branches, scopeRid) {
  const bs = (Array.isArray(branches) ? branches : []).filter((b) => b && (scopeRid == null || b.rid === scopeRid));
  return bs.length > 0 && bs.every((b) => knownControl(b.control) && Number.isInteger(b.pending_count));   // r2: the server's enum, whitelisted
}

// ann 3: «Para revisar» — only REAL attention items with a source today: a paused branch (getMyBranches control), with since-when;
// «Reanudar» only where the member may resume (location.pause). `scopeRid` null = every branch the page shows.
// + «Tenés N cambios sin publicar en el menú» from the SERVER's count (S3: branches[i].pending_count = the publish review's line count;
// null = stale ⇒ absent — never a guess, never the editor's session count, never a catalog load on the home). The frame's order.
export function reviewRows(branches, scopeRid) {
  const rows = [];
  for (const b of (Array.isArray(branches) ? branches : [])) {
    if (!b || (scopeRid != null && b.rid !== scopeRid)) continue;
    if (b.control && b.control.state === 'paused') {
      rows.push({ kind: 'pause', rid: b.rid, text: `Sucursal ${b.name} está en pausa`, when: when(b.control.pause_since),
        resume: Array.isArray(b.caps) && b.caps.includes('location.pause') });
    }
  }
  for (const b of (Array.isArray(branches) ? branches : [])) {
    if (!b || (scopeRid != null && b.rid !== scopeRid)) continue;
    const n = b.pending_count;
    if (Number.isInteger(n) && n > 0) rows.push({ kind: 'menu', rid: b.rid, text: `Tenés ${n} ${n === 1 ? 'cambio' : 'cambios'} sin publicar en el menú` });
  }
  return rows;
}

// «Ayuda» (owner 11-14): Sherpa support's WhatsApp from the ONE source (advisor 11-14): platform/sites.json runtime.support_whatsapp,
// generated into support-contact.js by sync-client. wa.me takes the digits; a malformed value ⇒ null ⇒ no «Ayuda» row, never a guess.
export const supportDigits = (v) => (typeof v === 'string' && /^\+[1-9]\d{7,14}$/.test(v) ? v.slice(1) : null);
export const SUPPORT_WA = supportDigits(SUPPORT_WHATSAPP);
