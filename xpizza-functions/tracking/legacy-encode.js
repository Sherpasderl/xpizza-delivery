'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §3) — the gen-1 (legacy) field encoding: only shapes the gen-1 page renders safely.
// gen-1 enters its live branch only with is_active_drop===true AND coordinates; the absent-flag-WITH-name branch runs the
// 12-minute countdown (tracker :769-777), so it must never be produced.
function legacyFields({ mode, hasLocation, name }) {
  if (mode === 'live' && hasLocation) return { is_active_drop: true, driver_name: name || null };
  if (mode === 'waiting') return { is_active_drop: false, driver_name: name || null };
  return { is_active_drop: null, driver_name: null };
}
module.exports = { legacyFields };
