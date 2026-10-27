// Customer app S4 (PLAN-capp-S4 r1 §3.1 + r5; the owner's N3 / N4) — the scheduling picker's days and slots, computed from the
// SERVED schedule (the directory entry's `schedule`, revalidated by quoteOrder's `schedule_only`; never the device's clock zone).
// Pure, UMD, brand-agnostic. DARK: used only when the app runtime carries schedulingLive.
//
//   The generator MIRRORS the server's validateScheduledFor (the functions' scheduled-orders module) exactly, so every slot the app
//   offers is accepted at placement: the schedule's own zone (tz_offset_min); slot_min epoch grain; start ≥ ceil(now + lead of
//   the fulfilment); ≤ now + horizon; the slot START inside [start, end) of its local day (end exclusive); a malformed or
//   inverted day is closed. N4: 7 local dates (offsets 0…6) — the 168 h window's partial 8th date is not offered. N3: every slot
//   of the day (no cap).
//   schedule = { tz_offset_min, slot_min, lead_min: { pickup, delivery }, horizon_h, hours: { sun…sat: { open, start, end } } }
//   valid(s)                        the shape is usable (else: no slots — «Sin horarios disponibles»)
//   slots(s, nowMs, mode)           every offerable slot START (epoch ms), ascending, inside the 7 local dates
//   days(s, nowMs, mode)            7 × { off, key 'YYYY-MM-DD', dow, date, month, slots[] } from today's LOCAL date
//   offered(s, nowMs, mode, ms)     is this exact slot still offered (the pre-dispatch re-check)
//   dayKey(s, ms) / dayOff(s, nowMs, ms)   the local date of an instant / its chip offset (−1 outside the 7)
//   labels: chipDay(day), chipSub(day), slotTime(s, ms), slotWhen(s, nowMs, ms) — the prototype's dayLabel / slotLabel / slotWhen
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappSchedule = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  // the app's established formatters / day names (capp-ui.js:41-43, capp-home.js:26-28; the prototype's P:1188-1189)
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtT = (h, m) => `${((h + 11) % 12) + 1}:${pad2(m)} ${h < 12 ? 'a.m.' : 'p.m.'}`;
  const fmtMin = (mins) => fmtT(Math.floor(mins / 60) % 24, mins % 60);
  const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const HORIZON_DAYS = 7;   // N4 (owner): 7 chips
  const MIN = 60000, DAY = 86400000;
  const capFirst = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  // the server's parseHM, verbatim in behaviour: H or HH : MM, h 0…24, m 0…59
  const parseHM = (x) => {
    if (typeof x !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(x);
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    return h >= 0 && h <= 24 && mi >= 0 && mi < 60 ? h * 60 + mi : null;
  };
  function valid(s) {
    return !!s && typeof s === 'object' && isNum(s.tz_offset_min) && isNum(s.slot_min) && s.slot_min > 0 && isNum(s.horizon_h) && s.horizon_h > 0
      && !!s.lead_min && isNum(s.lead_min.pickup) && isNum(s.lead_min.delivery) && !!s.hours && typeof s.hours === 'object';
  }
  const offMs = (s) => s.tz_offset_min * MIN;   // local = utc + offset (−360 ⇒ UTC−6)
  function local(s, ms) {
    const d = new Date(ms + offMs(s));
    return { dow: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), y: d.getUTCFullYear(), mo: d.getUTCMonth(), date: d.getUTCDate() };
  }
  const keyOf = (l) => `${l.y}-${pad2(l.mo + 1)}-${pad2(l.date)}`;
  const dayKey = (s, ms) => keyOf(local(s, ms));
  // the open window of the local day of `ms` — the server's hoursForDay
  function windowOf(s, ms) {
    const hd = s.hours[DAY_KEYS[local(s, ms).dow]];
    if (!hd || hd.open === false) return null;
    const a = parseHM(hd.start), b = parseHM(hd.end);
    return a === null || b === null || b <= a ? null : { a, b };
  }
  // the server's isOpenAt: the slot START inside [start, end)
  function openAt(s, ms) { const w = windowOf(s, ms); if (!w) return false; const m = local(s, ms).mins; return m >= w.a && m < w.b; }
  const leadOf = (s, mode) => (mode === 'delivery' ? s.lead_min.delivery : s.lead_min.pickup);
  // the 7 local dates, from today's: [key…]
  function dateKeys(s, nowMs) { const out = []; for (let i = 0; i < HORIZON_DAYS; i++) out.push(dayKey(s, nowMs + i * DAY)); return out; }
  function slots(s, nowMs, mode) {
    if (!valid(s) || !isNum(nowMs)) return [];
    const step = s.slot_min * MIN;
    const start = Math.ceil((nowMs + leadOf(s, mode) * MIN) / step) * step;
    const end = nowMs + s.horizon_h * 3600000;
    const inDays = new Set(dateKeys(s, nowMs));
    const out = [];
    for (let ms = start; ms <= end; ms += step) if (openAt(s, ms) && inDays.has(dayKey(s, ms))) out.push(ms);
    return out;
  }
  function days(s, nowMs, mode) {
    const all = valid(s) && isNum(nowMs) ? slots(s, nowMs, mode) : [];
    return (valid(s) && isNum(nowMs) ? dateKeys(s, nowMs) : []).map((key, off) => {
      const l = local(s, nowMs + off * DAY);
      return { off, key, dow: l.dow, date: l.date, month: l.mo, slots: all.filter((ms) => dayKey(s, ms) === key) };
    });
  }
  const offered = (s, nowMs, mode, ms) => isNum(ms) && slots(s, nowMs, mode).includes(ms);
  function dayOff(s, nowMs, ms) { if (!valid(s)) return -1; const i = dateKeys(s, nowMs).indexOf(dayKey(s, ms)); return i; }
  // labels (the prototype P:1259-1270 / P:1840): «Hoy» / «Mañana» / «Jue»; the sub «22 oct» — or «Sin horarios» (today) / «Cerrado»
  const chipDay = (d) => (d.off === 0 ? 'Hoy' : d.off === 1 ? 'Mañana' : capFirst(DAYS[d.dow].slice(0, 3)));
  const chipSub = (d) => (d.slots.length ? `${d.date} ${MONTHS[d.month]}` : d.off === 0 ? 'Sin horarios' : 'Cerrado');
  const slotTime = (s, ms) => fmtMin(local(s, ms).mins);
  const slotLabel = (s, ms) => `${fmtMin(local(s, ms).mins)} – ${fmtMin(local(s, ms).mins + 30)}`;
  function dayLabel(s, nowMs, ms) {
    const off = dayOff(s, nowMs, ms), l = local(s, ms);
    return off === 0 ? 'Hoy' : off === 1 ? 'Mañana' : `${capFirst(DAYS[l.dow].slice(0, 3))} ${l.date}`;
  }
  const slotWhen = (s, nowMs, ms) => `${dayLabel(s, nowMs, ms)} · ${slotLabel(s, ms)}`;

  return { HORIZON_DAYS, valid, slots, days, offered, dayKey, dayOff, chipDay, chipSub, slotTime, slotLabel, slotWhen, openAt, parseHM };
});
