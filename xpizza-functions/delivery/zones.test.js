'use strict';
// ENVÍO STEP 2 — drawn no-delivery zones, the pure module (PLAN-envio-zones-step2-r2 §2, §4.2, §9; owner D3/D5; Codex r1 F6/F8).
// Run: node delivery/zones.test.js
const assert = require('assert');
const Z = require('./zones');

let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

// a small square ~1 km a side near San Pedro Sula, as the portal sends it ({lat,lng})
const SQ = (id = 'z_aaaaaaaa', name = 'Sector A', o = 0) => ({ id, name, points: [
  { lat: 15.5 + o, lng: -88.03 }, { lat: 15.5 + o, lng: -88.02 }, { lat: 15.509 + o, lng: -88.02 }, { lat: 15.509 + o, lng: -88.03 }] });
const ok = (r) => { assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`); return r.zones; };
const bad = (r, problem, L) => { assert.strictEqual(r.ok, false, `${L}: expected a refusal`); assert.strictEqual(r.problem, problem, `${L}: ${JSON.stringify(r)}`); return r; };

cell('ZONES-NORMALIZE-COMPACT-ROUNDTRIP', (L) => {
  const zs = ok(Z.normalizeInput([{ ...SQ(), points: SQ().points.map((p) => ({ lat: p.lat + 1.23e-8, lng: p.lng - 4.4e-8 })) }]));
  assert.deepStrictEqual(zs[0].points[0], [15.5, -88.03], `${L}: stored as compact [lat,lng] pairs at 6 decimals`);
  assert.deepStrictEqual(Z.toPortal(zs), [SQ()], `${L}: portal object → compact → portal object`);
  assert.deepStrictEqual(Z.toPortal(Z.logical(undefined)), [], `${L}: absent ≡ []`);
});

cell('ZONES-SHAPE-RULES-AFTER-ROUNDING', (L) => {
  bad(Z.normalizeInput([{ ...SQ(), points: SQ().points.slice(0, 2) }]), 'zones', `${L} fewer than 3 points`);
  // two vertices that differ only below 1e-6 collapse to a duplicate AFTER rounding
  const dup = SQ(); dup.points.splice(1, 0, { lat: 15.5 + 2e-7, lng: -88.03 + 1e-7 });
  bad(Z.normalizeInput([dup]), 'zones', `${L} a rounding-made consecutive duplicate`);
  // a sliver that becomes zero-area once rounded
  bad(Z.normalizeInput([{ ...SQ(), points: [{ lat: 15.5, lng: -88.03 }, { lat: 15.5, lng: -88.02 }, { lat: 15.5000001, lng: -88.025 }] }]), 'zones', `${L} zero area after rounding`);
  // a bow-tie (self-crossing)
  // an ASYMMETRIC bow-tie (non-zero area, so only the crossing rule can refuse it)
  bad(Z.normalizeInput([{ ...SQ(), points: [{ lat: 15.5, lng: -88.03 }, { lat: 15.509, lng: -88.02 }, { lat: 15.5, lng: -88.02 }, { lat: 15.506, lng: -88.03 }] }]), 'zones', `${L} a self-crossing shape`);
  // a spike back along an edge (collinear overlap of adjacent edges)
  bad(Z.normalizeInput([{ ...SQ(), points: [{ lat: 15.5, lng: -88.03 }, { lat: 15.5, lng: -88.02 }, { lat: 15.5, lng: -88.025 }, { lat: 15.509, lng: -88.03 }] }]), 'zones', `${L} a collinear spike`);
  bad(Z.normalizeInput([{ ...SQ(), points: [{ lat: 91, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }] }]), 'zones', `${L} a latitude out of range`);
  bad(Z.normalizeInput([{ ...SQ(), points: [...SQ().points.slice(0, 3), { lat: 15.5, lng: -88.03, alt: 1 }] }]), 'zones', `${L} a point with extra keys`);
});

cell('ZONES-NAMES-AND-IDS', (L) => {
  bad(Z.normalizeInput([SQ('z_aaaaaaaa', '   ')]), 'zones', `${L} an empty name`);
  ok(Z.normalizeInput([SQ('z_aaaaaaaa', 'x'.repeat(30))]));
  bad(Z.normalizeInput([SQ('z_aaaaaaaa', 'x'.repeat(31))]), 'zones', `${L} 31 units`);
  bad(Z.normalizeInput([SQ('z_aaaaaaaa', 'Sector\u0007A')]), 'zones', `${L} a control character`);
  bad(Z.normalizeInput([SQ('z_aaaaaaaa', 'Sector \ud83d')]), 'zones', `${L} a lone surrogate (F8)`);
  ok(Z.normalizeInput([SQ('z_aaaaaaaa', 'Sector 😀')]));
  assert.strictEqual(ok(Z.normalizeInput([SQ('z_aaaaaaaa', '  Sector A  ')]))[0].name, 'Sector A', `${L}: names are stored trimmed`);
  bad(Z.normalizeInput([SQ('z_aaaaaaaa', 'Sector A'), SQ('z_bbbbbbbb', 'sector a', 0.02)]), 'zones', `${L} a case-folded duplicate name`);
  bad(Z.normalizeInput([SQ('z_aaaaaaaa'), SQ('z_aaaaaaaa', 'Sector B', 0.02)]), 'zones', `${L} a duplicate id`);
  bad(Z.normalizeInput([SQ('zona-1')]), 'zones', `${L} a malformed id`);
  bad(Z.normalizeInput({}), 'zones', `${L} not a list`);
});

cell('ZONES-CAPS-AT-THE-BOUNDARY', (L) => {
  const eight = Array.from({ length: 8 }, (_, i) => SQ(`z_${String(i).padStart(8, '0')}`, `Sector ${i}`, i * 0.02));
  assert.strictEqual(ok(Z.normalizeInput(eight)).length, 8, `${L}: 8 zones`);
  bad(Z.normalizeInput([...eight, SQ('z_99999999', 'Sector 9', 0.2)]), 'zone_caps', `${L} 9 zones`);
  const poly = (k) => ({ id: 'z_aaaaaaaa', name: 'Poly', points: Array.from({ length: k }, (_, i) => { const a = (2 * Math.PI * i) / k; return { lat: +(15.5 + 0.009 * Math.sin(a)).toFixed(6), lng: +(-88.03 + 0.009 * Math.cos(a)).toFixed(6) }; }) });
  ok(Z.normalizeInput([poly(24)]));
  bad(Z.normalizeInput([poly(25)]), 'zone_caps', `${L} 25 points`);
  // the longest bounding-box side ≤ 20 km (≈ 0.17988° of latitude); 0.19° ≈ 21 km is refused
  const tall = (dlat) => ({ id: 'z_aaaaaaaa', name: 'Alta', points: [{ lat: 15.4, lng: -88.03 }, { lat: 15.4, lng: -88.02 }, { lat: 15.4 + dlat, lng: -88.025 }] });
  ok(Z.normalizeInput([tall(0.17)]));
  bad(Z.normalizeInput([tall(0.19)]), 'zone_caps', `${L} a 21 km side`);
  assert.deepStrictEqual(Z.CAPS, { zones_max: 8, points_max: 24, points_min: 3, name_max: 30, bbox_max_km: 20 }, `${L}: the caps (owner D3, measured)`);
});

cell('ZONES-POINT-IN-POLYGON-EDGE-INCLUSIVE', (L) => {
  const zs = ok(Z.normalizeInput([SQ()]));
  assert.strictEqual(Z.inZone(zs, { lat: 15.504, lng: -88.025 }), true, `${L}: inside`);
  assert.strictEqual(Z.inZone(zs, { lat: 15.52, lng: -88.025 }), false, `${L}: outside`);
  assert.strictEqual(Z.inZone(zs, { lat: 15.5, lng: -88.025 }), true, `${L}: ON an edge counts as inside (D5)`);
  // the top and right edges: plain even-odd ray casting classifies these OUTSIDE — only the explicit edge rule makes them inside
  assert.strictEqual(Z.inZone(zs, { lat: 15.509, lng: -88.025 }), true, `${L}: ON an edge counts as inside — the top edge (D5)`);
  assert.strictEqual(Z.inZone(zs, { lat: 15.504, lng: -88.02 }), true, `${L}: ON an edge counts as inside — the right edge (D5)`);
  assert.strictEqual(Z.inZone(zs, { lat: 15.509, lng: -88.02 }), true, `${L}: ON a vertex counts as inside (D5)`);
  // a concave «L»: the notch is outside
  const Lz = ok(Z.normalizeInput([{ id: 'z_cccccccc', name: 'Ele', points: [{ lat: 15.5, lng: -88.03 }, { lat: 15.5, lng: -88.01 }, { lat: 15.505, lng: -88.01 }, { lat: 15.505, lng: -88.02 }, { lat: 15.51, lng: -88.02 }, { lat: 15.51, lng: -88.03 }] }]));
  assert.strictEqual(Z.inZone(Lz, { lat: 15.508, lng: -88.015 }), false, `${L}: the concave notch is outside`);
  assert.strictEqual(Z.inZone(Lz, { lat: 15.508, lng: -88.025 }), true, `${L}: the concave arm is inside`);
  assert.strictEqual(Z.inZone([], { lat: 15.504, lng: -88.025 }), false, `${L}: no zones → never inside`);
});

cell('ZONES-STORED-VALIDATION-AND-SHA', (L) => {
  const zs = ok(Z.normalizeInput([SQ(), SQ('z_bbbbbbbb', 'Sector B', 0.02)]));
  assert.strictEqual(Z.storedProblem(zs), null, `${L}: a writer-normalized list is valid stored data`);
  assert.strictEqual(Z.storedProblem(undefined), null, `${L}: absent is the empty list`);
  assert.notStrictEqual(Z.storedProblem([{ ...zs[0], points: [[15.5, -88.03], [15.5, -88.02]] }]), null, `${L}: a stored zone with 2 points is malformed`);
  assert.notStrictEqual(Z.storedProblem([{ ...zs[0], points: [[15.5000001, -88.03], ...zs[0].points.slice(1)] }]), null, `${L}: stored coordinates must already be at 6 decimals`);
  assert.notStrictEqual(Z.storedProblem({ 0: zs[0] }), null, `${L}: a non-array is malformed`);
  const h = Z.sha(zs);
  assert.match(h, /^[0-9a-f]{64}$/, `${L}: sha256 hex`);
  assert.strictEqual(Z.sha(undefined), Z.sha([]), `${L}: the sha is over the LOGICAL list (absent ≡ [])`);
  assert.notStrictEqual(Z.sha(zs), Z.sha(zs.slice(0, 1)), `${L}: a different list → a different sha`);
  assert.strictEqual(Z.sameLogical(undefined, []), true, `${L}: absent and [] compare equal`);
  assert.strictEqual(Z.sameLogical(zs, JSON.parse(JSON.stringify(zs))), true, `${L}: deep-equal lists compare equal`);
});

if (fails.length) { console.log(`zones FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`zones: OK (${n})`);
