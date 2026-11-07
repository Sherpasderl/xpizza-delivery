'use strict';
// S4 C′ (PLAN-capp-S4-r5 §0) — the ONE hours grammar. `hours7Errors` is E7's definition, MOVED here unchanged from O1b's
// branches/branch-ops.js (which now imports it and re-exports the SAME function object). Strict, same-day, all 7 days:
//   each day {open:false} or {open:true, start:'HH:MM', end:'HH:MM'}; two-digit 00:00–23:59; start < end; no other keys.
// Legacy hours readers/parsers (L1-L12) do NOT use this module yet — they stay byte-identical (G1 pins) until the
// HOURS-ONE-SOURCE slice migrates them. New consumers (loadSchedule → schedule_only) validate through it.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// all 7 days, each {open:false} or {open:true, start, end} same-day (start < end), no other keys
function hours7Errors(hours) {
  if (!isObj(hours)) return ['hours must be an object of 7 days'];
  const e = [];
  for (const k of Object.keys(hours)) if (!DAYS.includes(k)) e.push(`unknown day ${k}`);
  for (const d of DAYS) {
    const h = hours[d];
    if (!isObj(h) || typeof h.open !== 'boolean') { e.push(`${d}: {open} required`); continue; }
    if (Object.keys(h).some((k) => !['open', 'start', 'end'].includes(k))) e.push(`${d}: unknown key`);
    if (!h.open) { if ('start' in h || 'end' in h) e.push(`${d}: closed day has times`); continue; }
    // O1b T3d (Codex r1 #7): string times FIRST — an array / object / number never reaches the regex or the comparison
    if (typeof h.start !== 'string' || typeof h.end !== 'string' || !HHMM.test(h.start) || !HHMM.test(h.end) || !(h.start < h.end)) e.push(`${d}: open day needs HH:MM start < end (same day)`);
  }
  return e;
}

module.exports = { hours7Errors, DAYS };
