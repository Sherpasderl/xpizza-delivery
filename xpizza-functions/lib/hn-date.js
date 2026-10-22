'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1 r5 §6) — the Honduras-local calendar date, for the ops group's read of
// counters/order_display_seq/{rid}/{YYYY-MM-DD}. A COPY of factura/build-record.js's hnDateISO (+ the two constants it
// uses), so the portal ops group never loads factura/*. hn-date.guard.test.js compares this function's text (and its
// constants) with the live factura source on every run, and their outputs across the Honduras day / month / year
// boundaries — the allocation trigger (index.js) keys the counter with hnDateISO, so the two must never drift.
const HN_OFFSET_MS = 6 * 3600 * 1000; // America/Tegucigalpa is UTC-6 year-round (no DST)
const pad2 = (n) => String(n).padStart(2, '0');

// epoch ms -> 'YYYY-MM-DD' Honduras-local date (for ISO date comparisons in decideReserve).
function hnDateISO(epochMs) {
  const t = new Date(epochMs - HN_OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

module.exports = { hnDateISO };
