'use strict';

// Dep-free unit test for the prod config-read probe guards (C#5 — "one payload bug from a real order").
const assert = require('assert');
const { assertSafeProbe, assertProbeResponse, HUB, PROBE_PREFIX } = require('./probe-guard');

let n = 0;
const ok = (label) => console.log(`  ✓ ${++n} ${label}`);

// A provably-safe probe: delivery, far-out coords, probe-prefixed id.
const SAFE = { order_type: 'delivery', order_id: PROBE_PREFIX + 'a1b2c3', lat: 14.0, lng: -87.0 };

// --- assertSafeProbe ---
assert.doesNotThrow(() => assertSafeProbe(SAFE));                                  ok('safe delivery probe passes');
assert.throws(() => assertSafeProbe({ ...SAFE, order_type: 'pickup' }), /delivery/); ok('pickup is rejected (would skip zone-check and WRITE)');
assert.throws(() => assertSafeProbe({ ...SAFE, lat: HUB.lat, lng: HUB.lng }), /must exceed/); ok('in-zone coords rejected (no borderline)');
assert.throws(() => assertSafeProbe({ ...SAFE, order_id: 'X1' }), new RegExp(PROBE_PREFIX)); ok('missing probe prefix rejected');
assert.throws(() => assertSafeProbe({ ...SAFE, lat: 'x' }), /lat\/lng/);           ok('non-numeric coords rejected');

// --- assertProbeResponse ---
assert.deepEqual(
  assertProbeResponse(400, { detail: 'Outside delivery zone (120.0km from restaurant, max 7km)' }),
  { radiusKm: 7}
);                                                                                ok('400 + zone message + radius 7 -> proves config-read');
assert.throws(() => assertProbeResponse(200, { ok: true }), /expected 400/);      ok('200 hard-fails (a real order was created!)');
assert.throws(() => assertProbeResponse(503, { error: 'unavailable' }), /expected 400/); ok('503 hard-fails');
assert.throws(() => assertProbeResponse(400, { detail: 'Restaurant closed' }), /zone-check message/); ok('400 non-zone message hard-fails');
assert.throws(() => assertProbeResponse(400, { detail: 'Outside delivery zone (120.0km from restaurant, max 9.66km)' }), /mismatch|expected 7/); ok('wrong radius (9.66) hard-fails — config-read mismatch');

console.log(`probe-guard: OK (${n} cases)`);
