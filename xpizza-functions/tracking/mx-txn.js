'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1 Step 4) — the transaction updater for ONE order_tracking/{token} node. Pure.
//   - a missing node → null (RTDB transactions first run on the LOCAL cache: returning null keeps it absent if truly absent and
//     lets the server re-run the updater with the real value otherwise; it never creates a node), aborts (undefined) on a newer committed seq (cur.mx.seq > s), and when the node is
//     terminal but the new mode is not (terminal is never regressed);
//   - epoch +1 iff (mode, owner_tag, shift_id) changed;
//   - smp (the SAMPLING identity) = the legs' common owner + shift INDEPENDENT of the public mode; sample_at preserved while that
//     identity is unchanged, reset to 0 otherwise;
//   - public location (driver_location, dest_lat, dest_lng) cleared on leaving live or on an smp identity change;
//   - status + step timestamps from the CURRENT order (fields absent on the order are left as they are);
//   - legacy fields per legacy-encode.js; mx.name for gen 2;
//   - E1 (§E1, additive — droppable by removing `pins` below): mx.pins = {hub, dest} from the order's immutable hub snapshot and
//     destination while live, only with all four coordinates finite; null otherwise. It lives under mx, so gen-1 pages never see it.
const { legacyFields } = require('./legacy-encode');

function pinsFor(mode, order) {
  if (mode !== 'live' || !order) return null;
  const c = [order.hub_lat, order.hub_lng, order.lat, order.lng];
  if (!c.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  return { hub: { lat: c[0], lng: c[1] }, dest: { lat: c[2], lng: c[3] } };
}

function makeNodeUpdater({ s, derived, smp, name, order }) {
  return (cur) => {
    if (cur === null || cur === undefined) return null;
    const mx0 = cur.mx || {};
    if (typeof mx0.seq === 'number' && mx0.seq > s) return undefined;
    if (mx0.mode === 'terminal' && derived.mode !== 'terminal') return undefined;
    const changed = mx0.mode !== derived.mode || mx0.owner_tag !== derived.owner_tag || (mx0.shift_id || null) !== (derived.shift_id || null);
    const epoch = (typeof mx0.epoch === 'number' ? mx0.epoch : 0) + (changed ? 1 : 0);
    const prevSmp = mx0.smp || {};
    const sameSmp = prevSmp.owner_tag === smp.owner_tag && (prevSmp.shift_id || null) === (smp.shift_id || null);
    const nextSmp = { owner_tag: smp.owner_tag, shift_id: smp.shift_id || null, sample_at: sameSmp ? (prevSmp.sample_at || 0) : 0 };
    const clearLoc = derived.mode !== 'live' || !sameSmp;
    const next = { ...cur };
    if (clearLoc) { next.driver_location = null; next.dest_lat = null; next.dest_lng = null; }
    if (order) {
      for (const k of ['status', 'picked_up_at', 'delivered_at', 'cancelled_at']) if (order[k] !== undefined) next[k] = order[k];
    }
    const hasLocation = !!(next.driver_location && Number.isFinite(next.driver_location.lat) && Number.isFinite(next.driver_location.lng));
    Object.assign(next, legacyFields({ mode: derived.mode, hasLocation, name }));
    next.mx = { seq: s, mode: derived.mode, owner_tag: derived.owner_tag, shift_id: derived.shift_id || null, epoch, name: name || null, smp: nextSmp, pins: pinsFor(derived.mode, order) };
    return next;
  };
}
module.exports = { makeNodeUpdater };
