'use strict';
// BUILD-stacked-seq-server r5 T2 — the stack gate: may (incumbent, candidate) be a SEQUENCED pair on this driver?
//
// D7 (RULED (a), 2026-10-25): only SAME-HUB pairs are sequenced. A cross-hub pair — or one whose hub cannot be resolved — is
// "not a sequenced pair", and its caller keeps TODAY's unsequenced rule exactly. So `cross_hub` is checked before prep and
// coords: it is a routing answer, not an ineligibility. Co-located restaurants resolve to the same hub (one pickup).
// The hub test is the existing one (resolvePickupHub / coordsMatchHub, driver-ingest.js), so stacking and the geofence agree.
const { resolvePickupHub, coordsMatchHub } = require('../driver-ingest');
const { vStoredPrep } = require('../merchant/merchant-validate');

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const fullPrep = (o) => !!o && vStoredPrep(o.prep) === 'full' && fin(o.prep.ready_at);
const coords = (o) => !!o && fin(o.lat) && fin(o.lng);

// incumbent / candidate: { oid, order, pickup } (pickup = the order's pickup task); otherCount: the driver's OTHER non-terminal
// orders (the candidate excluded); hubs: { rid → {lat,lng} | null }.
// → { ok:true, hub, hub_rid } | { ok:false, reason: 'not_one' | 'cross_hub' | 'not_delivery' | 'no_prep' | 'missing_coords' }
function stackGate({ incumbent, candidate, otherCount, hubs }) {
  if (otherCount !== 1 || !incumbent || !candidate || incumbent.oid === candidate.oid) return { ok: false, reason: 'not_one' };
  const hi = resolvePickupHub(incumbent.pickup, hubs);
  const hn = resolvePickupHub(candidate.pickup, hubs);
  if (!hi || !hn || !coordsMatchHub(hi, hn.lat, hn.lng)) return { ok: false, reason: 'cross_hub' };
  if ((incumbent.order || {}).order_type !== 'delivery' || (candidate.order || {}).order_type !== 'delivery') return { ok: false, reason: 'not_delivery' };
  if (!fullPrep(incumbent.order) || !fullPrep(candidate.order)) return { ok: false, reason: 'no_prep' };
  if (!coords(incumbent.order) || !coords(candidate.order)) return { ok: false, reason: 'missing_coords' };
  return { ok: true, hub: hubs[incumbent.pickup.restaurant_id], hub_rid: incumbent.pickup.restaurant_id };
}

module.exports = { stackGate };
