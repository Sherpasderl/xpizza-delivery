'use strict';
// BUILD-stacked-seq-server r5 T2 / D8 — the Routes element budget. ONE node per Honduras month,
// counters/routes_elements/{YYYY-MM} = { total, days: { DD: n } }; ONE transaction reserves a call's 6 elements and checks the
// day cap AND the month cap together. Null-first-safe; over a cap (or a malformed node) → undefined, i.e. abort (fail closed).
const ELEMENTS_PER_CALL = 6;   // origins [hub, I, N] × destinations [I, N]
const DAY_CAP = 400;
const MONTH_CAP = 4800;
const HN_OFFSET_MS = -6 * 3600 * 1000;   // America/Tegucigalpa: UTC−6, no DST

function budgetKeys(nowMs) {
  const d = new Date(nowMs + HN_OFFSET_MS);
  const p2 = (x) => String(x).padStart(2, '0');
  return { month: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`, day: p2(d.getUTCDate()) };
}

const count = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function reserve(cur, day, n = ELEMENTS_PER_CALL) {
  let total = 0; let days = {};
  if (cur !== null && cur !== undefined) {
    if (typeof cur !== 'object' || !count(cur.total)) return undefined;
    if (cur.days !== undefined && (cur.days === null || typeof cur.days !== 'object' || Array.isArray(cur.days))) return undefined;
    total = cur.total; days = { ...(cur.days || {}) };
    if (days[day] !== undefined && !count(days[day])) return undefined;
  }
  const today = (days[day] || 0) + n;
  if (today > DAY_CAP || total + n > MONTH_CAP) return undefined;
  days[day] = today;
  return { total: total + n, days };
}

module.exports = { reserve, budgetKeys, ELEMENTS_PER_CALL, DAY_CAP, MONTH_CAP };
