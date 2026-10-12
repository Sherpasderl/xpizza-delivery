'use strict';
const assert = require('assert');
const { activeDropOrderId, shouldMirror, shouldMarkStackedWaiting } = require('./tracking-mirror');
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

// ── shouldMarkStackedWaiting: write is_active_drop:false ONLY for a genuinely stacked-WAITING order ──
// The ONE true case: the driver's active drop is a DIFFERENT order that is out_for_delivery right now.
assert.equal(shouldMarkStackedWaiting('PZX-2', 'PZX-1_delivery', 'out_for_delivery'), true);
ok('genuine stack: driver actively delivering a DIFFERENT order → mark waiting (false)');

// ⛔ NO-REGRESSION core: a single / non-stacked order must NEVER be marked false.
assert.equal(shouldMarkStackedWaiting('PZX-1', 'PZX-1_delivery', 'out_for_delivery'), false);
ok('THIS order IS the active drop (single/active) → never false');
assert.equal(shouldMarkStackedWaiting('PZX-2', 'PZX-1_pickup', 'out_for_delivery'), false);
ok('driver on a PICKUP leg (no active drop yet) → never false');
assert.equal(shouldMarkStackedWaiting('PZX-2', null, 'out_for_delivery'), false);
ok('driver has no current_task_id → never false');
assert.equal(shouldMarkStackedWaiting('PZX-2', undefined, 'out_for_delivery'), false);
ok('current_task_id undefined → never false');
assert.equal(shouldMarkStackedWaiting('PZX-2', 'weird-no-suffix', 'out_for_delivery'), false);
ok('unparseable current_task_id → never false');

// ⛔ STALE-POINTER race (the critical single-order trap): driver just finished PZX-1 and picks up single
// PZX-2; current_task_id may momentarily still read PZX-1_delivery. PZX-1 is already 'delivered', so the
// status confirmation fails → PZX-2 is NOT marked false. (This is why we re-read the active order's status.)
assert.equal(shouldMarkStackedWaiting('PZX-2', 'PZX-1_delivery', 'delivered'), false);
ok('stale pointer at an already-delivered order → never false (status gate saves the single order)');
assert.equal(shouldMarkStackedWaiting('PZX-2', 'PZX-1_delivery', 'cancelled'), false);
ok('active order cancelled → never false');
assert.equal(shouldMarkStackedWaiting('PZX-2', 'PZX-1_delivery', 'assigned'), false);
ok('active order not yet out_for_delivery → never false');
assert.equal(shouldMarkStackedWaiting('PZX-2', 'PZX-1_delivery', null), false);
ok('active order status unreadable (null) → fail-safe, never false');
assert.equal(shouldMarkStackedWaiting('PZX-2', 'PZX-1_delivery', undefined), false);
ok('active order status undefined → fail-safe, never false');

// Guard the subject order id itself.
assert.equal(shouldMarkStackedWaiting('', 'PZX-1_delivery', 'out_for_delivery'), false);
ok('empty thisOrderId → never false');
assert.equal(shouldMarkStackedWaiting(null, 'PZX-1_delivery', 'out_for_delivery'), false);
ok('null thisOrderId → never false');

console.log(`tracking-mirror: OK (${n} cases)`);
