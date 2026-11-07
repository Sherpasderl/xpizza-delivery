'use strict';
// DRIVER C — «{Nombre} llegó» on the REAL tracker page (index.html in the live harness: the real render, map, Directions refresh,
// status-view.js) and the shared status-view truth table (OWNER-APPROVED mockup, frames 3–5). Run: node xpizza-track/tracker-arrived.test.js
const assert = require('assert');
const { page, T0 } = require('./tracker-live-harness.test.cjs');
const SV = require('./status-view.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const DEST = { dest_lat: 15.51, dest_lng: -88.03 };
const P0 = { lat: 15.5, lng: -88.02 };
const MX = (o = {}) => ({ mode: 'live', owner_tag: 'tagO', shift_id: 's1', epoch: 3, name: 'Carlos', smp: { owner_tag: 'tagO', shift_id: 's1', sample_at: 1 }, ...o });
const live = (pg, loc, over = {}) => ({ order_id: 'PZX-1', order_type: 'delivery', status: 'out_for_delivery', ...DEST, is_active_drop: true, driver_name: 'Carlos',
  mx: MX(), driver_location: loc ? { ...loc, at: pg.serverNow(0) } : null, ...over });
const ARR = { at: T0 - 1000, owner_tag: 'tagO', name: 'Carlos' };

(async () => {
  // ── the arrived state on the real page: headline, the big sub-line, the dot stays, NO ETA request / expiry ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0)); await pg.answer(0, 380);
    assert.strictEqual(pg.sub(), 'Llega en ~7 min', 'premise: live with an ETA');
    const routes0 = pg.routes.length;
    await pg.emit(live(pg, P0, { arrived: ARR }));
    assert.strictEqual(pg.title(), 'Carlos llegó', 'DRVC-TRK-TITLE');
    assert.strictEqual(pg.sub(), 'Ya está afuera con tu pedido', 'DRVC-TRK-SUB the arrival copy, never an ETA');
    assert.strictEqual(pg.reg['driver-eta'].className, 'ssub big', 'DRVC-TRK-BIG the approved big sub-line style (mockup b)');
    assert.ok(pg.mapShown(), 'DRVC-TRK-MAP the driver\'s dot stays on the live map');
    assert.strictEqual(pg.timersNamed('renderEtaLine'), 0, 'DRVC-TRK-NOEXPIRY the pending ETA expiry is dropped AT the arrived render');
    await pg.advance(120000);
    assert.strictEqual(pg.routes.length, routes0, 'DRVC-TRK-NOETA no Directions request while arrived');
    assert.strictEqual(pg.timersNamed('renderEtaLine'), 0, 'DRVC-TRK-NOEXPIRY no pending ETA expiry while arrived');
    assert.strictEqual(pg.sub(), 'Ya está afuera con tu pedido', 'DRVC-TRK-STABLE the copy holds (no ETA repaint)');
    ok('the real tracker: «Carlos llegó» / «Ya está afuera con tu pedido» (ssub big); the map stays; no Directions request, no ETA expiry');
  }
  {
    // arrived WITHOUT a live location → the copy, no map
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, null, { arrived: ARR }));
    assert.strictEqual(pg.title(), 'Carlos llegó', 'DRVC-TRK-NOLOC-TITLE');
    assert.strictEqual(pg.sub(), 'Ya está afuera con tu pedido', 'DRVC-TRK-NOLOC-SUB');
    assert.ok(!pg.mapShown(), 'DRVC-TRK-NOLOC-NOMAP');
    assert.strictEqual(pg.routes.length, 0, 'DRVC-TRK-NOLOC-NOETA');
    ok('arrived with no live location: the copy, no map, no ETA');
  }
  {
    // reassigned (a new owner_tag) → the old arrival stops rendering; delivered overrides arrived
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0, { arrived: ARR, mx: MX({ owner_tag: 'tagB', name: 'Bruno', smp: { owner_tag: 'tagB', shift_id: 's1', sample_at: 1 } }) }));
    assert.strictEqual(pg.title(), 'Bruno está en camino', 'DRVC-TRK-REASSIGN an arrival bound to another driver never renders');
    await pg.emit({ ...live(pg, null, { arrived: ARR }), status: 'delivered', delivered_at: T0, mx: MX({ mode: 'terminal', owner_tag: 'none' }) });
    assert.strictEqual(pg.title(), '¡Pedido entregado!', 'DRVC-TRK-DELIVERED delivered overrides arrived');
    ok('a reassigned driver never shows the old arrival; delivered overrides arrived');
  }

  // ── the status-view truth table (both gen2 and the forms' arrival-line call without gen2) ──
  const NOW = 1_800_000_000_000;
  const base = { status: 'out_for_delivery', order_type: 'delivery', now: NOW, picked_up_at: NOW - 3 * 60000, fallback_drive_min: 12 };   // a countdown WOULD exist
  const loc = { lat: 15.5, lng: -88 };
  const cases = [
    ['mx live, same tag', { mx: MX(), driver_location: loc, arrived: ARR }, true],
    ['mx live, other tag (reassigned)', { mx: MX({ owner_tag: 'tagB' }), arrived: ARR }, false],
    ['mx waiting («parada rápida»)', { mx: MX({ mode: 'waiting' }), arrived: ARR }, false],
    ['mx neutral', { mx: MX({ mode: 'neutral', owner_tag: 'none' }), arrived: ARR }, false],
    ['legacy active drop, same name', { is_active_drop: true, driver_name: 'Carlos', arrived: ARR }, true],
    ['legacy name mismatch («Ana» shown)', { is_active_drop: true, driver_name: 'Ana', arrived: ARR }, false],
    ['legacy waiting', { is_active_drop: false, driver_name: 'Carlos', arrived: ARR }, false],
    ['legacy no active flag', { driver_name: 'Carlos', arrived: ARR }, false],
    ['no arrival', { mx: MX(), driver_location: loc }, false],
    ['arrival at not finite', { mx: MX(), arrived: { ...ARR, at: 'x' } }, false],
    ['delivered', { status: 'delivered', mx: MX(), arrived: ARR }, false],
    ['cancelled', { status: 'cancelled', mx: MX(), arrived: ARR }, false],
    ['pickup order', { order_type: 'pickup', mx: MX(), arrived: ARR }, false],
  ];
  for (const gen2 of [true, false]) for (const [label, o, want] of cases) {
    const v = SV.presentStatus({ ...base, ...o, gen2 });
    assert.strictEqual(v.arrived === true, want, `DRVC-SV ${label} (gen2 ${gen2})`);
    if (want) {
      assert.strictEqual(v.headline, 'Carlos llegó', `DRVC-SV-HEAD ${label}`);
      assert.strictEqual(v.sub, 'Ya está afuera con tu pedido', `DRVC-SV-SUB ${label}`);
      assert.strictEqual(v.subClass, 'ssub big', `DRVC-SV-BIG ${label}`);
      assert.deepStrictEqual(v.segs, ['done', 'done', 'done', { a: .5 }, 'pending'], `DRVC-SV-SEGS ${label}`);
      assert.strictEqual(v.etaEligible, false, `DRVC-SV-NOETA ${label}`);
      assert.strictEqual(v.etaMin, null, `DRVC-SV-NOETAMIN ${label}`);
    } else {
      assert.ok(!Object.prototype.hasOwnProperty.call(v, 'arrived'), `DRVC-SV-NOKEY ${label}: no arrived key when it does not apply`);
    }
  }
  {
    const v = SV.presentStatus({ ...base, mx: MX({ name: '' }), arrived: ARR, gen2: true });
    assert.strictEqual(v.headline, 'Tu repartidor llegó', 'DRVC-SV-NONAME');
    assert.strictEqual(v.avatar, null, 'DRVC-SV-NONAME-AVATAR');
    assert.strictEqual(SV.presentStatus({ ...base, mx: MX(), driver_location: loc, arrived: ARR, gen2: true }).mapEligible, true, 'DRVC-SV-MAP');
    assert.strictEqual(SV.presentStatus({ ...base, mx: MX(), arrived: ARR, gen2: true }).mapEligible, false, 'DRVC-SV-NOMAP');
  }
  ok(`status-view truth table: ${cases.length} cases × gen2 on/off — arrived only for the current live driver (tag / legacy name), never waiting / neutral / reassigned / terminal / pickup; no ETA; «Tu repartidor llegó» without a name`);

  console.log(`\ntracker-arrived: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
