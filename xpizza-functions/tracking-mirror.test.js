'use strict';
const assert = require('assert');
const { activeDropOrderId, shouldMirror } = require('./tracking-mirror');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── activeDropOrderId: only the DELIVERY leg is an active drop ──
assert.equal(activeDropOrderId('PZX-260810-1_delivery'), 'PZX-260810-1'); ok('delivery task → order id');
assert.equal(activeDropOrderId('PZX-260810-1_pickup'), null); ok('pickup task → null (no live map during pickup)');
assert.equal(activeDropOrderId(null), null); ok('no task → null');
assert.equal(activeDropOrderId(undefined), null); ok('undefined task → null');
assert.equal(activeDropOrderId('weird'), null); ok('unsuffixed → null');
assert.equal(activeDropOrderId('PZX-1_delivery_delivery'), 'PZX-1_delivery'); ok('greedy match → strips only the final _delivery');

// ── shouldMirror throttle: first / elapsed / big-move → write; too-soon+tiny → skip ──
const T = { throttleMs: 12000, minMoveMeters: 40 };
assert.equal(shouldMirror(null, { lat: 15.5, lng: -88.0 }, 1000, T), true); ok('first location → write');
assert.equal(shouldMirror({ at: 1000, lat: 15.5, lng: -88.0 }, { lat: 15.5001, lng: -88.0 }, 3000, T), false); ok('too soon + tiny move → skip');
assert.equal(shouldMirror({ at: 1000, lat: 15.5, lng: -88.0 }, { lat: 15.5001, lng: -88.0 }, 20000, T), true); ok('throttle elapsed → write');
assert.equal(shouldMirror({ at: 1000, lat: 15.5, lng: -88.0 }, { lat: 15.55, lng: -88.0 }, 3000, T), true); ok('big move → write even if soon');
// Boundary + malformed-prev robustness.
assert.equal(shouldMirror({ at: 1000, lat: 15.5, lng: -88.0 }, { lat: 15.5, lng: -88.0 }, 13000, T), true); ok('exactly throttle boundary → write');
assert.equal(shouldMirror({ lat: 15.5, lng: -88.0 }, { lat: 15.5, lng: -88.0 }, 5000, T), true); ok('prev missing at → treated as first → write');

console.log(`tracking-mirror: OK (${n} cases)`);
