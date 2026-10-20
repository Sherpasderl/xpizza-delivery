'use strict';
// E1 (Mejora nueva) — the pins before the first live location (BUILD-tracker-F4 §6, T4). Run: node xpizza-track/tracker-pins.test.js
// Runs the REAL tracker page through the persistent harness (tracker-live-harness.test.cjs). Droppable: reverting E1's commit
// removes this file, and every F4-fix test still passes on its own.
const assert = require('assert');
const { page } = require('./tracker-live-harness.test.cjs');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const HUB = { lat: 15.47, lng: -88.0 };
const DEST = { lat: 15.51, lng: -88.03 };
const P0 = { lat: 15.5, lng: -88.02 };
const mxLive = (over = {}) => ({ mode: 'live', owner_tag: 'tagO', shift_id: 's1', epoch: 3, name: 'Carlos', smp: { owner_tag: 'tagO', shift_id: 's1', sample_at: 0 },
  pins: { hub: HUB, dest: DEST }, ...over });
const rec = (pg, over = {}) => ({ order_id: 'PZX-1', order_type: 'delivery', status: 'out_for_delivery', is_active_drop: null, driver_name: null,
  driver_location: null, mx: mxLive(), ...over });
const titles = (pg) => pg.markers.map((m) => m.title);

(async () => {
  // ── 1. live, no location yet, valid pins → the pins map: exactly the restaurant + the destination, no driver ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(rec(pg));
    assert.ok(pg.pinsShown(), 'the pins map shows'); assert.ok(!pg.mapShown(), 'the live map does not');
    assert.deepStrictEqual(titles(pg).sort(), ['Restaurante', 'Tu dirección'], 'exactly two markers: the restaurant + the destination');
    assert.strictEqual(pg.title(), 'Tu pedido va en camino'); assert.strictEqual(pg.sub(), 'Con Carlos · pronto llegará a tu dirección');
    assert.deepStrictEqual(pg.glideLog, [], 'E1 never touches the glide engine');
    ok('live + no location + valid pins → the pins map with exactly 2 markers (restaurant, destination), no driver marker, the calm copy (B)');

    // ── 2. the first location → the pins map hides; the live map takes over as before ──
    await pg.emit(rec(pg, { is_active_drop: true, driver_name: 'Carlos', dest_lat: DEST.lat, dest_lng: DEST.lng, driver_location: { ...P0, at: pg.serverNow() } }));
    assert.ok(!pg.pinsShown(), 'the pins map hides'); assert.ok(pg.mapShown(), 'the live map shows');
    assert.strictEqual(pg.title(), 'Carlos está en camino');
    assert.ok(titles(pg).includes('Carlos'), 'the live map\'s driver marker exists (created by updateDriverMap, as today)');
    assert.strictEqual(pg.glideLog.filter((e) => e[0] === 'cancel').length, 0, 'no cancel from E1');
    ok('the first location → the pins map hides, the live map appears exactly as today (its own driver marker; E1 never calls the glide)');
  }

  // ── 3. pins missing or malformed → today's screen ──
  for (const [label, pins] of [['null', null], ['a non-finite coordinate', { hub: { lat: 'x', lng: -88 }, dest: DEST }], ['a missing dest', { hub: HUB }]]) {
    const pg = page(); await pg.offset(0);
    await pg.emit(rec(pg, { mx: mxLive({ pins }) }));
    assert.ok(!pg.pinsShown() && !pg.mapShown(), `${label}: no map`);
    assert.strictEqual(pg.markers.length, 0, `${label}: no marker drawn`);
    assert.strictEqual(pg.sub(), 'Con Carlos · pronto llegará a tu dirección', `${label}: today's calm copy`);
  }
  ok('mx.pins null / non-finite / incomplete → today\'s screen (the calm copy, no map)');

  // ── 4. no live claim → never pins (neutral / waiting / pre / terminal / gen-1) ──
  {
    const pg = page(); await pg.offset(0);
    for (const mode of ['neutral', 'waiting']) {
      await pg.emit(rec(pg, { mx: mxLive({ mode }) }));
      assert.ok(!pg.pinsShown(), `${mode}: no pins`);
    }
    await pg.emit(rec(pg, { status: 'preparing', mx: mxLive({ mode: 'pre' }) }));
    assert.ok(!pg.pinsShown(), 'pre: no pins');
    await pg.emit(rec(pg, { status: 'delivered', delivered_at: 1, mx: mxLive({ mode: 'terminal' }) }));
    assert.ok(!pg.pinsShown(), 'terminal: no pins');
    const gen1 = rec(pg, { driver_name: 'Carlos' }); delete gen1.mx;
    await pg.emit(gen1);
    assert.ok(!pg.pinsShown(), 'gen-1 node (no mx): no pins');
    assert.strictEqual(pg.markers.length, 0, 'no marker was ever drawn');
  }
  ok('neutral / waiting / pre / terminal / a gen-1 node → never the pins map');

  // ── 5. a new claim (reassign) starts again from the pins ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(rec(pg, { is_active_drop: true, driver_name: 'Carlos', dest_lat: DEST.lat, dest_lng: DEST.lng, driver_location: { ...P0, at: pg.serverNow() } }));
    assert.ok(pg.mapShown() && !pg.pinsShown());
    await pg.emit(rec(pg, { mx: mxLive({ owner_tag: 'tagP', epoch: 9, name: 'Pedro', smp: { owner_tag: 'tagP', shift_id: 's1', sample_at: 0 } }) }));
    assert.ok(pg.pinsShown() && !pg.mapShown(), 'the new live claim without a location → the pins again');
    assert.strictEqual(pg.sub(), 'Con Pedro · pronto llegará a tu dirección');
    ok('a new live claim (another driver, no location yet) shows the pins again, with the new name');
  }

  console.log(`\ntracker-pins: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
