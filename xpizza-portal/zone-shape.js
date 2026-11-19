// Z2 §A (PLAN-portal-zones-protocol-v3-r4, Q1 = A; Codex #181/#185; advisor 11-19) — THE pure shape check of ONE drawn no-delivery
// zone, MOVED verbatim out of delivery/zones.js (which requires it) so the server and the portal run the SAME function: the portal's
// byte copy (xpizza-portal/zone-shape.js, written by tools/sync-client.js under a drift guard) only PREVIEWS; the server judges.
//   normalizePoint({ lat, lng })  INPUT normalization: exact keys, a real lat / lng, rounded to the 6-decimal grid (r6)
//   pointsProblem(points)         STORED validation of one zone's compact [[lat, lng], …] — off-grid values are REFUSED, never
//                                 normalized → null | { problem: 'zones' | 'zone_caps' | 'zone_out_of_range', field: 'points' }, in this
//                                 precedence: shape → 24 / 3 point caps → each point real and on the grid → no consecutive duplicate →
//                                 |lat| ≤ 60 → the 20 km box → the grid-unit span caps → non-zero area and SIMPLE
//   spanWithinCaps(gridPts)       the grid-unit span predicate (exported for its DIRECT unit test: zone-shape.test.js)
//   gridPt / orient / onSeg / exact / area2 / simple   the exact integer geometry (inZone in zones.js uses the same)
// Behaviour identity with zones.js before the move: delivery/zone-shape-equivalence.test.js.
// UMD-lite (the section-transitions.js pattern): CommonJS here, a global in the portal's classic script. Pure; requires nothing.

(function (root) {
  const CAPS = Object.freeze({ points_max: 24, points_min: 3, bbox_max_km: 20 });   // owner D3, measured (plan §6)
  // Codex build r2 #1 (advisor ruling): every vertex lies within |lat| ≤ 60 (no delivery happens beyond); a box of ≤ 20 km there spans at
  // most 20 / 111.195 = 0.17987° of latitude and 20 / (111.195 · cos 60°) = 0.35974° of longitude — on the grid ≤ 179,870 and ≤ 359,740
  // units. Both spans are ALSO capped in grid units (SPAN_LAT_UNITS / SPAN_LNG_UNITS), so the bound the exact arithmetic relies on holds by construction.
  const LAT_ABS_MAX = 60;
  const SPAN_LAT_UNITS = 180000, SPAN_LNG_UNITS = 360000;   // the box caps in grid units
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const isLat = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -90 && x <= 90;
  const isLng = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -180 && x <= 180;

  // EXACT geometry (Codex build r1 #1): every coordinate lives on the 6-decimal grid, so it is scaled to an INTEGER (×1e6) and every
  // orientation, area and crossing test is integer arithmetic — no floating `=== 0`, no tolerance. Exact in plain Numbers because every
  // operand is a DIFFERENCE inside one zone's bounding box: |lat| ≤ 60 and the box caps (checked BEFORE any shape rule; the grid-unit caps) bound a
  // difference by 180,000 (lat) / 360,000 (lng) grid units, so a product is ≤ 6.48·10^10 and a 24-term area sum ≤ 1.6·10^12, far below
  // 2^53 ≈ 9.0·10^15; a pin is first rejected outside the zone's box (and beyond |lat| 60), so the same bound holds for it. A pin is put
  // on the same grid (≈ 0.1 m).
  const gridI = (x) => Math.round(x * 1e6);
  const gridPt = (p) => [gridI(p[0]), gridI(p[1])];
  const exact = (v) => { if (!Number.isSafeInteger(v)) throw new Error('zones_geometry_out_of_range'); return v; };   // tripwire for the bound above
  // orientation of (p, q, r) on the (lng, lat) plane: > 0 left, < 0 right, 0 collinear — exact on grid points within one box
  const orient = (p, q, r) => exact((q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]));
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
  const area2 = (pts) => { const o = pts[0]; let s = 0; for (let i = 1; i + 1 < pts.length; i++) s += orient(o, pts[i], pts[i + 1]); return exact(s); };   // exact, on grid points: a fan of orientations from the first vertex (differences only)
  const KM_PER_DEG = 111.195;
  function bboxKm(pts) {
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of pts) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; }
    const midLat = ((lo[0] + hi[0]) / 2) * (Math.PI / 180);
    return Math.max((hi[0] - lo[0]) * KM_PER_DEG, (hi[1] - lo[1]) * KM_PER_DEG * Math.cos(midLat));
  }
  // the grid-unit span caps on a zone's grid points → true (within) | false
  function spanWithinCaps(g) {
    const span = (k) => Math.max(...g.map((q) => q[k])) - Math.min(...g.map((q) => q[k]));
    return !(span(0) > SPAN_LAT_UNITS || span(1) > SPAN_LNG_UNITS);
  }

  // one zone's STORED points (compact [lat, lng] on the grid) → null | { problem, field: 'points' }
  function pointsProblem(points) {
    const fail = (problem) => ({ problem, field: 'points' });
    if (!Array.isArray(points)) return fail('zones');
    if (points.length > CAPS.points_max) return fail('zone_caps');
    if (points.length < CAPS.points_min) return fail('zones');
    for (let k = 0; k < points.length; k++) {
      const p = points[k];
      if (!Array.isArray(p) || p.length !== 2 || !isLat(p[0]) || !isLng(p[1]) || r6(p[0]) !== p[0] || r6(p[1]) !== p[1]) return fail('zones');
    }
    for (let k = 0; k < points.length; k++) {
      const p = points[k], q = points[(k + 1) % points.length];
      if (p[0] === q[0] && p[1] === q[1]) return fail('zones');
    }
    if (points.some((p) => Math.abs(p[0]) > LAT_ABS_MAX)) return fail('zone_out_of_range');
    if (bboxKm(points) > CAPS.bbox_max_km) return fail('zone_caps');   // FIRST: it bounds the exact arithmetic below
    if (!spanWithinCaps(points.map(gridPt))) return fail('zone_caps');
    { const g = points.map(gridPt); if (area2(g) === 0 || !simple(g)) return fail('zones'); }
    return null;
  }

  // one INPUT point { lat, lng } → [lat, lng] on the 6-decimal grid | null (malformed)
  function normalizePoint(p) {
    if (!exactKeys(p, ['lat', 'lng']) || !isLat(p.lat) || !isLng(p.lng)) return null;
    return [r6(p.lat), r6(p.lng)];
  }

  const api = { CAPS, LAT_ABS_MAX, SPAN_LAT_UNITS, SPAN_LNG_UNITS, isObj, exactKeys, isLat, isLng, r6, gridPt, exact, orient, onSeg, area2, simple, spanWithinCaps, pointsProblem, normalizePoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoneShape = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
