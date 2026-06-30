'use strict';

// C1 golden — auto-assign per-restaurant hub. Proves the three cases the gate requires:
// (a) x_pizza order WITH a stamped hub → its hub (== fallback) → byte-identical distance;
// (b) legacy/pre-Phase-0 order with NO hub → x_pizza fallback → byte-identical;
// (c) la_musa order → La Musa hub. Plus the byte-identity HINGE: the fallback hub equals the seeded
// x_pizza hub to full float precision. Run: node assign-hub.test.js
const assert = require('assert');
const { resolveAssignHub, X_PIZZA_HUB } = require('./assign-hub');
const { IDENTITIES } = require('./seed_identity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── Byte-identity HINGE: fallback hub === the SEEDED x_pizza hub (full float precision) ──
assert.strictEqual(X_PIZZA_HUB.lat, IDENTITIES.x_pizza.hub_lat); ok('fallback hub lat === seed x_pizza hub_lat (hinge)');
assert.strictEqual(X_PIZZA_HUB.lng, IDENTITIES.x_pizza.hub_lng); ok('fallback hub lng === seed x_pizza hub_lng (hinge)');

// ── (a) x_pizza order WITH stamped hub → its hub (== fallback) → identical distance ──
assert.deepStrictEqual(
  resolveAssignHub({ hub_lat: IDENTITIES.x_pizza.hub_lat, hub_lng: IDENTITIES.x_pizza.hub_lng }),
  { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }); ok('(a) x_pizza order with hub → x_pizza hub (byte-identical)');

// ── (b) legacy / pre-Phase-0 order with NO hub → x_pizza fallback → identical ──
assert.deepStrictEqual(resolveAssignHub({}), { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }); ok('(b) legacy (no hub) → x_pizza fallback');
assert.deepStrictEqual(resolveAssignHub(undefined), { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }); ok('(b) null order → fallback (no crash)');
assert.deepStrictEqual(resolveAssignHub({ hub_lat: 'oops', hub_lng: null }), { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }); ok('(b) malformed hub → fallback (defensive)');

// ── (c) la_musa order → La Musa hub (distinct from x_pizza) ──
const lm = resolveAssignHub({ hub_lat: IDENTITIES.la_musa.hub_lat, hub_lng: IDENTITIES.la_musa.hub_lng });
assert.deepStrictEqual(lm, { hubLat: IDENTITIES.la_musa.hub_lat, hubLng: IDENTITIES.la_musa.hub_lng }); ok('(c) la_musa order → La Musa hub');
assert.notDeepStrictEqual(lm, { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }); ok('(c) La Musa hub is distinct from x_pizza');

console.log(`assign-hub: OK (${n} cases)`);
