'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §2) — the ingest mirror updater: live location ONLY, fenced at commit by mode, owner,
// authenticated shift, the epoch read before the transaction, status, and the sampling watermark. Writes the location, the
// watermark and the legacy live shape (is_active_drop:true + the name), never the mode. Pure.
function makeIngestUpdater({ uidTag, shiftId, epoch, sample, dest }) {
  return (cur) => {
    if (cur === null || cur === undefined) return null;   // cold local cache: let the server re-run with the real value
    if (!cur.mx) return undefined;
    const mx = cur.mx, smp = mx.smp || {};
    if (mx.mode !== 'live' || mx.owner_tag !== uidTag || mx.shift_id !== shiftId || mx.epoch !== epoch) return undefined;
    if (cur.status !== 'out_for_delivery') return undefined;
    if (smp.owner_tag !== uidTag || smp.shift_id !== shiftId) return undefined;
    if (!(sample.measured_at > (smp.sample_at || 0))) return undefined;
    const next = { ...cur, driver_location: { lat: sample.lat, lng: sample.lng, at: sample.measured_at }, is_active_drop: true, driver_name: mx.name || null };
    if (dest && Number.isFinite(dest.lat) && Number.isFinite(dest.lng)) { next.dest_lat = dest.lat; next.dest_lng = dest.lng; }
    next.mx = { ...mx, smp: { ...smp, sample_at: sample.measured_at } };
    return next;
  };
}
// a sample is mirrored only if measured ≤ 90 s ago and ≤ 2 s in the future (server clock)
const sampleInWindow = (measuredAt, now) => measuredAt <= now + 2000 && now - measuredAt <= 90000;
module.exports = { makeIngestUpdater, sampleInWindow };
