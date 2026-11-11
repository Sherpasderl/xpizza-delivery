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
const crypto = require('crypto');

const CAPS = Object.freeze({ zones_max: 8, points_max: 24, points_min: 3, name_max: 30, bbox_max_km: 20 });   // owner D3, measured (plan §6)
const ID_RE = /^z_[a-z0-9]{8}$/;
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const isLat = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -90 && x <= 90;
const isLng = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -180 && x <= 180;
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

// orientation of (p, q, r) on the (lng, lat) plane: > 0 left, < 0 right, 0 collinear
const orient = (p, q, r) => (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
const onSeg = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
function segsCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) || (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
}
// SIMPLE: no two non-adjacent edges touch; adjacent edges share only their common vertex (a collinear fold-back is a crossing)
function simple(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const c = pts[j], d = pts[(j + 1) % n];
      if (j === i + 1) { if (orient(a, b, d) === 0 && onSeg(a, b, d)) return false; continue; }               // b === c: d folds back onto ab
      if (i === 0 && j === n - 1) { if (orient(a, b, c) === 0 && onSeg(a, b, c)) return false; continue; }   // d === a: c folds back onto ab
      if (segsCross(a, b, c, d)) return false;
    }
  }
  return true;
}
const area2 = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p[1] * q[0] - q[1] * p[0]; } return s; };
const KM_PER_DEG = 111.195;
function bboxKm(pts) {
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const p of pts) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; }
  const midLat = ((lo[0] + hi[0]) / 2) * (Math.PI / 180);
  return Math.max((hi[0] - lo[0]) * KM_PER_DEG, (hi[1] - lo[1]) * KM_PER_DEG * Math.cos(midLat));
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
    if (!ID_RE.test(z.id) || ids.has(z.id)) return fail('zones', 'id');
    ids.add(z.id);
    if (!nameOk(z.name) || z.name !== z.name.trim()) return fail('zones', 'name');
    const folded = z.name.toLowerCase();
    if (names.has(folded)) return fail('zones', 'name');
    names.add(folded);
    if (!Array.isArray(z.points)) return fail('zones', 'points');
    if (z.points.length > CAPS.points_max) return fail('zone_caps', 'points');
    if (z.points.length < CAPS.points_min) return fail('zones', 'points');
    for (let k = 0; k < z.points.length; k++) {
      const p = z.points[k];
      if (!Array.isArray(p) || p.length !== 2 || !isLat(p[0]) || !isLng(p[1]) || r6(p[0]) !== p[0] || r6(p[1]) !== p[1]) return fail('zones', 'points');
    }
    for (let k = 0; k < z.points.length; k++) {
      const p = z.points[k], q = z.points[(k + 1) % z.points.length];
      if (p[0] === q[0] && p[1] === q[1]) return fail('zones', 'points');
    }
    if (area2(z.points) === 0 || !simple(z.points)) return fail('zones', 'points');
    if (bboxKm(z.points) > CAPS.bbox_max_km) return fail('zone_caps', 'points');
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
      if (!exactKeys(p, ['lat', 'lng']) || !isLat(p.lat) || !isLng(p.lng)) return fail('points');
      points.push([r6(p.lat), r6(p.lng)]);
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
  if (!pin || !isLat(pin.lat) || !isLng(pin.lng)) return false;
  const r = [pin.lat, pin.lng];
  for (const z of logical(zones)) {
    const pts = z.points; let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (orient(a, b, r) === 0 && onSeg(a, b, r)) return true;
      if ((a[0] > r[0]) !== (b[0] > r[0]) && r[1] < ((b[1] - a[1]) * (r[0] - a[0])) / (b[0] - a[0]) + a[1]) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

module.exports = { CAPS, normalizeInput, storedProblem, toPortal, sha, sameLogical, logical, inZone };
