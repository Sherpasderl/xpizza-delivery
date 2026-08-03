// slot-format.js — PURE Programados slot labelling + grouping (es-HN, America/Tegucigalpa).
// No DOM/Firebase — node-testable. Produces the "Hoy 5:00 PM" / "Mañana 12:30 PM" / "vie 3:00 PM"
// slot headers the spec §3.2 calls for.
const TZ = 'America/Tegucigalpa';

// Stable slot day-key "2026-08-03" (en-CA is YYYY-MM-DD in every ICU build).
const ymd = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(ms));

// Clean "5:00 PM" via formatToParts (deterministic across ICU builds — en-US gives a bare AM/PM
// dayPeriod, so we don't have to normalize the es-HN "p. m." spelling).
function timeStr(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t)?.value || '');
  const period = get('dayPeriod').toUpperCase().replace(/[^APM]/g, ''); // "AM"→"AM", "p. m."→"PM"
  return `${get('hour')}:${get('minute')} ${period}`.trim();
}

export function slotLabel(scheduledFor, now) {
  if (!Number.isFinite(scheduledFor)) return '';
  const dayKey = ymd(scheduledFor);
  const today = ymd(now);
  const tmrw = ymd(now + 24 * 60 * 60 * 1000);
  const t = timeStr(scheduledFor);
  if (dayKey === today) return `Hoy ${t}`;
  if (dayKey === tmrw) return `Mañana ${t}`;
  const wd = new Intl.DateTimeFormat('es-HN', { timeZone: TZ, weekday: 'short' }).format(new Date(scheduledFor));
  return `${wd} ${t}`;
}

export function groupScheduledBySlot(scheduled, now) {
  const byKey = new Map(); // "ymd|h:mm AM" → {key,label,ts,orders[]}
  for (const id of Object.keys(scheduled || {})) {
    const order = scheduled[id];
    const ts = Number(order?.scheduled_for);
    if (!Number.isFinite(ts)) continue;
    const key = `${ymd(ts)}|${timeStr(ts)}`;
    if (!byKey.has(key)) byKey.set(key, { key, label: slotLabel(ts, now), ts, orders: [] });
    byKey.get(key).orders.push({ id, order });
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
}
