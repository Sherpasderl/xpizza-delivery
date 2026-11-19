'use strict';
// ENVÍO STEP 2 — drawn no-delivery zones, PURE (PLAN-envio-zones-step2-r2 §2, §4.2; owner decisions D3/D5 2026-11-11).
// ONE module for the writer (normalizeInput) and the order path's reader (storedProblem / inZone), so what is saved is
// exactly what is enforced.
//
// Stored: platform_config/delivery_pricing.no_delivery_zones = [ { id, name, points: [ [lat, lng], … ] }, … ]
//   · compact [lat, lng] pairs at 6 decimals (≈ 0.1 m); the callables speak { lat, lng } (toPortal / normalizeInput)
//   · an EMPTY list is the field ABSENT (RTDB prunes empty arrays): every reader and comparison uses the LOGICAL list
//   · every shape rule runs AFTER rounding, so a rounding-made duplicate, zero area or crossing is refused
// A point ON an edge or vertex is INSIDE (owner D5: the safe side for drivers).
// Z2 §A (PLAN-portal-zones-protocol-v3-r4, advisor 11-19): the pure shape check of ONE zone (rounding, the grid, distinct points, |lat|,
// box + span, area, simple) and the exact geometry live in ./zone-shape (the portal runs the same bytes); behaviour-identical to this
// file before the move (zone-shape-equivalence.test.js). The list rules (ids, names, caps) and inZone stay here.
const crypto = require('crypto');
const S = require('./zone-shape');

const CAPS = Object.freeze({ zones_max: 8, points_max: S.CAPS.points_max, points_min: S.CAPS.points_min, name_max: 30, bbox_max_km: S.CAPS.bbox_max_km });   // owner D3, measured (plan §6); the shape caps: ./zone-shape
const ID_RE = /^z_[a-z0-9]{8}$/;
const { isObj, exactKeys, isLat, isLng, gridPt, orient, onSeg, exact, LAT_ABS_MAX } = S;
const logical = (list) => (Array.isArray(list) ? list : []);

// a name: 1..30 UTF-16 units after trimming, no control characters, no unpaired surrogate (one would JSON-escape to 6 bytes)
function nameOk(s) {
  if (typeof s !== 'string' || s.length < 1 || s.length > CAPS.name_max) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(i + 1); if (!(d >= 0xdc00 && d <= 0xdfff)) return false; i++; continue; }
    if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

// the rules every zone list obeys, on the COMPACT normalized form → null | { problem, zone_id?, field }
function compactProblem(zones) {
  if (!Array.isArray(zones)) return { problem: 'zones', field: 'no_delivery_zones' };
  if (zones.length > CAPS.zones_max) return { problem: 'zone_caps', field: 'no_delivery_zones' };
  const ids = new Set(), names = new Set();
  for (let i = 0; i < zones.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(zones, i)) return { problem: 'zones', field: 'no_delivery_zones' };
    const z = zones[i];
    const zid = isObj(z) && typeof z.id === 'string' ? z.id : null;
    const fail = (problem, field) => ({ problem, ...(zid ? { zone_id: zid } : {}), field });
    if (!exactKeys(z, ['id', 'name', 'points'])) return fail('zones', 'zone');
    if (typeof z.id !== 'string' || !ID_RE.test(z.id) || ids.has(z.id)) return fail('zones', 'id');   // a STRING first (Codex build r1 #3)
    ids.add(z.id);
    if (!nameOk(z.name) || z.name !== z.name.trim()) return fail('zones', 'name');
    const folded = z.name.toLowerCase();
    if (names.has(folded)) return fail('zones', 'name');
    names.add(folded);
    const sp = S.pointsProblem(z.points);   // ./zone-shape: the same rules, in the same precedence
    if (sp) return fail(sp.problem, sp.field);
  }
  return null;
}

// The portal's list ({ id, name, points: [{lat,lng}] }) → { ok: true, zones } (compact, normalized) | { ok: false, problem, … }
function normalizeInput(list) {
  if (!Array.isArray(list)) return { ok: false, problem: 'zones', field: 'no_delivery_zones' };
  if (list.length > CAPS.zones_max) return { ok: false, problem: 'zone_caps', field: 'no_delivery_zones' };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const z = list[i];
    const zid = isObj(z) && typeof z.id === 'string' ? z.id : null;
    const fail = (field) => ({ ok: false, problem: 'zones', ...(zid ? { zone_id: zid } : {}), field });
    if (!exactKeys(z, ['id', 'name', 'points'])) return fail('zone');
    if (typeof z.name !== 'string') return fail('name');
    if (!Array.isArray(z.points)) return fail('points');
    const points = [];
    for (const p of z.points) {
      const q = S.normalizePoint(p);   // ./zone-shape: exact keys, a real lat / lng, the 6-decimal grid
      if (!q) return fail('points');
      points.push(q);
    }
    out.push({ id: z.id, name: z.name.trim(), points });
  }
  const p = compactProblem(out);   // every rule AFTER rounding
  return p ? { ok: false, ...p } : { ok: true, zones: out };
}

// a STORED value (absent ≡ []) → null (valid) | { problem, … } — the order path's reader and the writer's read of `cur`
const storedProblem = (stored) => (stored === undefined || stored === null ? null : compactProblem(stored));
const toPortal = (zones) => logical(zones).map((z) => ({ id: z.id, name: z.name, points: z.points.map(([lat, lng]) => ({ lat, lng })) }));
const sha = (zones) => crypto.createHash('sha256').update(JSON.stringify(logical(zones).map((z) => ({ id: z.id, name: z.name, points: z.points })))).digest('hex');
const sameLogical = (a, b) => JSON.stringify(logical(a)) === JSON.stringify(logical(b));

// pin { lat, lng } inside ANY zone? An edge or vertex counts as inside (D5); then even-odd ray casting on (lng, lat).
function inZone(zones, pin) {
  if (!pin || !isLat(pin.lat) || !isLng(pin.lng) || Math.abs(pin.lat) > LAT_ABS_MAX) return false;   // beyond |lat| 60: outside every zone
  const r = gridPt([pin.lat, pin.lng]);   // the pin on the zones' grid (≈ 0.1 m)
  for (const z of logical(zones)) {
    const pts = z.points.map(gridPt); let inside = false;
    { let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity; for (const q of pts) { lo0 = Math.min(lo0, q[0]); hi0 = Math.max(hi0, q[0]); lo1 = Math.min(lo1, q[1]); hi1 = Math.max(hi1, q[1]); }
      if (r[0] < lo0 || r[0] > hi0 || r[1] < lo1 || r[1] > hi1) continue; }   // outside the box: neither inside nor on an edge
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (orient(a, b, r) === 0 && onSeg(a, b, r)) return true;
      // the ray to +lng crosses edge ab: r.lng < a.lng + (b.lng − a.lng)(r.lat − a.lat)/(b.lat − a.lat), cross-multiplied by the signed denominator
      if ((a[0] > r[0]) !== (b[0] > r[0])) {
        const d = b[0] - a[0], lhs = (r[1] - a[1]) * d, rhs = (b[1] - a[1]) * (r[0] - a[0]);
        if (d > 0 ? exact(lhs) < exact(rhs) : exact(lhs) > exact(rhs)) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

module.exports = { CAPS, normalizeInput, storedProblem, toPortal, sha, sameLogical, logical, inZone };
