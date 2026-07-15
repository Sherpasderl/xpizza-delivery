/**
 * Unit tests for the pure delivery-ETA helpers (dispatch Phase 1a).
 * Run: `node driver-eta.test.js` (from xpizza-dispatch/).
 */
import assert from 'node:assert';
import {
  distanceMeters, etaEligible, projectArrival, relativeEta, clockTime, dueForRefresh,
} from './driver-eta.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  const d = distanceMeters({ lat: 15.5, lng: -88 }, { lat: 15.501, lng: -88 });
  assert.ok(d > 100 && d < 125, `got ${d}`); ok('distanceMeters ~111m');
}
{
  const base = { pickupStatus: 'completed', destLat: 15.5, destLng: -88, driverLat: 15.51, driverLng: -88.01 };
  assert.strictEqual(etaEligible(base), true);
  assert.strictEqual(etaEligible({ ...base, pickupStatus: 'in_progress' }), false, 'not picked up yet');
  assert.strictEqual(etaEligible({ ...base, destLat: null }), false, 'no destination');
  assert.strictEqual(etaEligible({ ...base, driverLat: undefined }), false, 'no driver pos');
  ok('etaEligible gates on pickup-completed + finite coords');
}
{
  assert.strictEqual(projectArrival(1_000_000, 300, 180), 1_000_000 + 480_000);
  assert.strictEqual(projectArrival(0, -5, -5), 0, 'clamps negatives to 0');
  ok('projectArrival = now + travel + dwell');
}
{
  assert.strictEqual(relativeEta(60_000, 0), 'llegando', '<=1 min');
  assert.strictEqual(relativeEta(12 * 60_000, 0), '≈ 12 min');
  assert.strictEqual(relativeEta(0, 60_000), 'llegando', 'past -> llegando');
  ok('relativeEta');
}
{
  // 2026-07-14T19:42 America/Tegucigalpa (UTC-6) === 2026-07-15T01:42Z
  const ms = Date.UTC(2026, 6, 15, 1, 42, 0);
  const s = clockTime(ms, 'America/Tegucigalpa');
  assert.ok(/7:42/.test(s), `expected 7:42, got "${s}"`);
  ok('clockTime deterministic from ms + tz');
}
{
  assert.strictEqual(dueForRefresh(null, 100, 30_000, 0, 50), true, 'first ever');
  assert.strictEqual(dueForRefresh(0, 10_000, 30_000, 0, 50), false, 'too soon, no move');
  assert.strictEqual(dueForRefresh(0, 10_000, 30_000, 80, 50), true, 'moved far');
  assert.strictEqual(dueForRefresh(0, 40_000, 30_000, 0, 50), true, 'interval elapsed');
  ok('dueForRefresh throttle');
}

console.log(`\n${pass} passed`);
