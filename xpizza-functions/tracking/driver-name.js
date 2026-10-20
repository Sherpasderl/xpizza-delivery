'use strict';
// TRACKER FIXES r2.10.1 (C) — the driver name from a driver RECORD already read (the recompute's one drivers/{owner} read), with the
// IDENTICAL precedence of driver-attribution.js resolveDriverName (which stays unchanged for its other callers):
//   DRIVER_DISPLAY_NAMES[uid] → record.display_name (a truthy string, as-is: no trim) → record.name capitalised (first upper, rest
//   lower) → null. Proven equal over every record shape in tracking/driver-name.test.js.
const { DRIVER_DISPLAY_NAMES } = require('../driver-attribution');

function driverNameFrom(uid, record) {
  if (!uid) return null;
  if (DRIVER_DISPLAY_NAMES[uid]) return DRIVER_DISPLAY_NAMES[uid];
  const r = record && typeof record === 'object' ? record : {};
  const dn = r.display_name;
  if (dn && typeof dn === 'string') return dn;
  const raw = r.name;
  if (raw && typeof raw === 'string') return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return null;
}
module.exports = { driverNameFrom };
