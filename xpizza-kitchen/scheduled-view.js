// Pure, dependency-light (imports railCount). Groups scheduled orders by their LOCAL calendar day in the
// restaurant timezone (Tegucigalpa), each with a make-count roll-up for dough planning. No firebase/DOM.
import { railCount } from './rail-count.js';

const TZ = 'America/Tegucigalpa';
const INVALID = '9999-99-99';   // sorts last under string compare

function dayKey(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function weekdayLabel(ms, tz) {
  const w = new Intl.DateTimeFormat('es-HN', { timeZone: tz, weekday: 'long' }).format(new Date(ms));
  return w.charAt(0).toUpperCase() + w.slice(1);
}
function dateLabel(ms, tz) {
  return new Intl.DateTimeFormat('es-HN', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(ms)).replace(/\./g, '');
}
const finiteMs = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function groupScheduledByDay(orders, nowMs, tz = TZ) {
  const todayKey = dayKey(nowMs, tz);
  const tomorrowKey = dayKey(nowMs + 86400000, tz);
  const buckets = new Map();
  for (const id of Object.keys(orders || {})) {
    const o = { id, ...orders[id] };
    const t = finiteMs(o.scheduled_for);
    const key = t == null ? INVALID : dayKey(t, tz);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }
  const out = [];
  for (const key of [...buckets.keys()].sort()) {
    const dayOrders = buckets.get(key).sort((a, b) => {
      const ta = finiteMs(a.scheduled_for) ?? Infinity;
      const tb = finiteMs(b.scheduled_for) ?? Infinity;
      return ta - tb || String(a.id).localeCompare(String(b.id));
    });
    const makeCount = railCount(dayOrders.map(o => o.items_text));
    const pizzas = makeCount.reduce((s, m) => s + m.qty, 0);
    const anchor = finiteMs(dayOrders[0] && dayOrders[0].scheduled_for);
    const valid = key !== INVALID && anchor != null;
    out.push({
      dayKey: key,
      label: !valid ? 'Sin fecha' : key === todayKey ? 'Hoy' : key === tomorrowKey ? 'Mañana' : weekdayLabel(anchor, tz),
      dateLabel: valid ? dateLabel(anchor, tz) : '',
      count: dayOrders.length,
      pizzas,
      makeCount,
      orders: dayOrders,
    });
  }
  return out;
}
