'use strict';

// X. Pizza's hub coordinates — the historical auto-assign origin AND the driver-geofence fallback.
// EQUAL to seed_identity.js IDENTITIES.x_pizza.hub_lat/lng to full float precision (assign-hub.test.js
// pins that equality — the C1 byte-identity hinge). Also the fallback hub for an order with no stamped
// hub (legacy/pre-Phase-0), mirroring the existing `?? RESTAURANT_LAT` pattern in index.js.
const X_PIZZA_HUB = { lat: 15.507489753573818, lng: -88.0398486953722 };

// La Musa's hub — EQUAL to seed_identity.js IDENTITIES.la_musa.hub_lat/lng (assign-hub.test.js pins it).
const LA_MUSA_HUB = { lat: 15.50414, lng: -88.03848 };

// ALLOWED_HUBS — the driver-geofence resolvable-hub allowlist (S1), keyed by restaurant_id. A driver's
// persisted current_hub snapshot is trusted by isHubResolvable ONLY when its restaurant_id is a key here
// AND its coords match this entry — defending the geofence against a stale/corrupt/unknown hub. Pinned
// to the seeded identities by assign-hub.test.js (keys + coords) so it can't silently drift.
const ALLOWED_HUBS = { x_pizza: X_PIZZA_HUB, la_musa: LA_MUSA_HUB };

// Resolve the hub the auto-assign distance is measured FROM, for an order. Uses the order's STAMPED
// hub (hubSnapshot, per-restaurant) when present; falls back to X. Pizza's hub for a legacy order
// with no (or malformed) stamped hub. An x_pizza order carries a hub equal to the fallback, so the
// distance — and therefore the chosen driver — is byte-identical to the pre-C1 behavior.
function resolveAssignHub(order) {
  const o = order || {};
  return {
    hubLat: typeof o.hub_lat === 'number' ? o.hub_lat : X_PIZZA_HUB.lat,
    hubLng: typeof o.hub_lng === 'number' ? o.hub_lng : X_PIZZA_HUB.lng,
  };
}

module.exports = { resolveAssignHub, X_PIZZA_HUB, LA_MUSA_HUB, ALLOWED_HUBS };
