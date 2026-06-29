'use strict';

/**
 * Pre-send + post-send safety guard for the zero-write prod config-read probe
 * (deploy/config-read-probe.js).
 *
 * The probe relies on createOrder returning 400 (out-of-delivery-zone) AFTER getIdentity + the
 * zone-check but BEFORE any write / rate-limit / WhatsApp / factura / task / PixelPay call. If the
 * payload were accidentally a PICKUP order (zone-check is delivery-only) or IN-ZONE coords, the
 * deployed function would proceed to the WRITE path and create a real order. These guards HARD-FAIL
 * locally before sending unless the request is provably a zero-write out-of-zone delivery probe, and
 * after sending unless the response is exactly the 400 zone-check using the expected radius.
 */

const HUB = { lat: 15.507489753573818, lng: -88.0398486953722 }; // x_pizza hub (constant == seeded)
const EXPECTED_RADIUS_KM = 7;     // x_pizza delivery_radius_km — what the deployed reader must return
const MARGIN_KM = 50;             // coords must exceed radius by this margin (no borderline distances)
const PROBE_PREFIX = 'DEPLOY_PROBE_';

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Throws unless `payload` is a provably-safe zero-write out-of-zone DELIVERY probe (C#5).
function assertSafeProbe(payload) {
  if (!payload || payload.order_type !== 'delivery') {
    throw new Error('probe-guard: order_type must be "delivery" (pickup skips the zone-check and would WRITE)');
  }
  if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') {
    throw new Error('probe-guard: numeric lat/lng required');
  }
  const distKm = haversineKm(HUB.lat, HUB.lng, payload.lat, payload.lng);
  if (distKm < EXPECTED_RADIUS_KM + MARGIN_KM) {
    throw new Error(`probe-guard: coords only ${distKm.toFixed(1)}km from hub — must exceed radius+${MARGIN_KM}km to guarantee a 400 (no borderline coords)`);
  }
  if (typeof payload.order_id !== 'string' || !payload.order_id.startsWith(PROBE_PREFIX)) {
    throw new Error(`probe-guard: order_id must start with "${PROBE_PREFIX}" (high-entropy deploy-probe marker)`);
  }
  return { distKm };
}

// After sending: the response MUST be exactly 400 with the zone message AND the expected radius.
// 200 = a real order was created (ABORT); 503/closed/anything else = the probe did not short-circuit.
function assertProbeResponse(status, body) {
  if (status !== 400) {
    throw new Error(`probe-guard: expected 400, got ${status} — ABORT (non-400 means the probe did NOT short-circuit before the write path)`);
  }
  const detail = `${(body && (body.detail || body.error)) || ''}`;
  if (!/delivery zone/i.test(detail)) {
    throw new Error(`probe-guard: 400 but not the zone-check message: "${detail}"`);
  }
  const m = detail.match(/max\s+([\d.]+)\s*km/i);
  if (!m) throw new Error(`probe-guard: could not parse the radius the deployed reader used from: "${detail}"`);
  const radiusKm = Number(m[1]);
  if (radiusKm !== EXPECTED_RADIUS_KM) {
    throw new Error(`probe-guard: deployed reader used radius ${radiusKm}km, expected ${EXPECTED_RADIUS_KM} — prod config-read mismatch`);
  }
  return { radiusKm };
}

module.exports = { assertSafeProbe, assertProbeResponse, haversineKm, HUB, EXPECTED_RADIUS_KM, MARGIN_KM, PROBE_PREFIX };
