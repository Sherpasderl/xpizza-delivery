'use strict';
// Z2 §A (PLAN-portal-zones-protocol-v3-r4 §#185 P3; advisor 11-19) — delivery/zone-shape.js, DIRECTLY:
//   ZONE-SPAN-PREDICATE  the exported span predicate on grid points passed STRAIGHT to it (in-span ⇒ true, one unit over ⇒ false, both
//                        axes, both signs). Through valid input the span guard is redundant behind |lat| ≤ 60 and the 20 km box, so an
//                        input-level cell cannot see it (m10a, the call site bypassed, survives by design); THIS cell kills m10b (the
//                        predicate itself relaxed).
//   ZONE-BOWTIE          an ASYMMETRIC bow-tie (its two lobes differ, so the signed area is NOT zero) is refused by the SIMPLE rule.
//   ZONE-GRID            input normalization (r6) is distinct from stored validation: off-grid input is rounded; off-grid STORED points are
//                        refused, never normalized.
//   ZONE-UMD             the portal's classic script gets the same API as a global; the module requires nothing.
// Run: node delivery/zone-shape.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ZS = require('./zone-shape');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── ZONE-SPAN-PREDICATE ──
{
  const { spanWithinCaps, SPAN_LAT_UNITS, SPAN_LNG_UNITS } = ZS;
  assert.deepStrictEqual([SPAN_LAT_UNITS, SPAN_LNG_UNITS], [180000, 360000], 'the grid-unit caps (zones.js :18 before the move)');
  const box = (dLat, dLng, o = [0, 0]) => [[o[0], o[1]], [o[0] + dLat, o[1]], [o[0] + dLat, o[1] + dLng], [o[0], o[1] + dLng]];
  for (const o of [[0, 0], [-59_000_000, 179_000_000], [15_500_000, -88_000_000]]) {
    assert.strictEqual(spanWithinCaps(box(180000, 360000, o)), true, `🔴 ZONE-SPAN-PREDICATE: exactly at both caps is within (origin ${o})`);
    assert.strictEqual(spanWithinCaps(box(180001, 1, o)), false, `🔴 ZONE-SPAN-PREDICATE: one lat unit over is refused (origin ${o})`);
    assert.strictEqual(spanWithinCaps(box(1, 360001, o)), false, `🔴 ZONE-SPAN-PREDICATE: one lng unit over is refused (origin ${o})`);
    assert.strictEqual(spanWithinCaps(box(-180001, 1, o)), false, `🔴 ZONE-SPAN-PREDICATE: a negative-direction lat span is measured too (origin ${o})`);
  }
  assert.strictEqual(spanWithinCaps([[0, 0], [5, 5], [3, 1]]), true, 'a tiny triangle is within');
  ok('the exported span predicate, fed grid points directly: at the caps ⇒ within; one unit over on either axis, either sign ⇒ refused');
}

// ── ZONE-BOWTIE ──
{
  const at = (dLat, dLng) => [Math.round((15.5 + dLat) * 1e6) / 1e6, Math.round((-88 + dLng) * 1e6) / 1e6];
  const bow = [at(0, 0), at(0.002, 0.002), at(0.002, 0), at(0, 0.001)];   // edge 3 crosses edge 1; the lobes differ
  const g = bow.map(ZS.gridPt);
  assert.notStrictEqual(ZS.area2(g), 0, 'premise: the bow-tie\'s signed area is NOT zero (so only SIMPLE can refuse it)');
  assert.strictEqual(ZS.simple(g), false, 'premise: it is not simple');
  assert.deepStrictEqual(ZS.pointsProblem(bow), { problem: 'zones', field: 'points' }, '🔴 ZONE-BOWTIE: the asymmetric bow-tie is refused');
  const fixed = [bow[0], bow[2], bow[1], bow[3]];   // the same four corners, in an order that does not cross
  assert.strictEqual(ZS.pointsProblem(fixed), null, 'control: the same corners as a simple quadrilateral are accepted');
  ok('an asymmetric, non-zero-area bow-tie is refused by the simple-polygon rule; its uncrossed reordering is accepted');
}

// ── ZONE-GRID ──
{
  assert.deepStrictEqual(ZS.normalizePoint({ lat: 15.5000004, lng: -88.0000006 }), [15.5, -88.000001], 'input: rounded to the 6-decimal grid');
  assert.strictEqual(ZS.normalizePoint({ lat: 15.5, lng: -88, x: 1 }), null, 'input: exact keys');
  assert.strictEqual(ZS.normalizePoint({ lat: 91, lng: 0 }), null, 'input: a real latitude');
  const tri = [[15.5, -88], [15.501, -88], [15.5, -87.999]];
  assert.strictEqual(ZS.pointsProblem(tri), null, 'stored: on the grid ⇒ valid');
  assert.deepStrictEqual(ZS.pointsProblem([[15.5000004, -88], tri[1], tri[2]]), { problem: 'zones', field: 'points' }, '🔴 ZONE-GRID: an off-grid STORED point is refused, never normalized');
  assert.deepStrictEqual(ZS.pointsProblem([[60.5, -88], [60.501, -88], [60.5, -87.999]]), { problem: 'zone_out_of_range', field: 'points' }, '|lat| > 60 ⇒ zone_out_of_range');
  ok('input normalization rounds; stored validation refuses off-grid values (never normalizes); |lat| > 60 ⇒ zone_out_of_range');
}

// ── ZONE-UMD ──
{
  const src = fs.readFileSync(path.join(__dirname, 'zone-shape.js'), 'utf8');
  assert.ok(!/\brequire\s*\(/.test(src.replace(/\/\/.*$/gm, '')), 'the module requires nothing (the portal loads it as a classic script)');
  const sandbox = {}; vm.runInNewContext(src, sandbox);
  assert.ok(sandbox.ZoneShape, 'a global ZoneShape in the portal');
  assert.deepStrictEqual(Object.keys(sandbox.ZoneShape).sort(), Object.keys(ZS).sort(), 'the same API as CommonJS');
  assert.deepStrictEqual(sandbox.ZoneShape.pointsProblem([[15.5, -88], [15.501, -88], [15.5, -87.999]]), null, 'and the same answer');
  ok('UMD-lite: CommonJS here, the same API as a global in the portal; no require');
}
console.log(`\nzone-shape: OK (${n})`);
