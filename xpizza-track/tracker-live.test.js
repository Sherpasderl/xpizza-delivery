'use strict';
// F4 — THE LIVE TRACKER, persistent (BUILD-tracker-F4 §8 T3). Run: node xpizza-track/tracker-live.test.js
// The tracker's REAL module script (index.html) runs ONCE per scenario in a vm and stays alive across steps: the real map
// functions, the real Directions refresh, eta-gate.js, status-view.js, the subscriptions and the event handlers. Only the
// boundaries are fake:
//   • Firebase — onValue ROUTED BY PATH (the record and .info/serverTimeOffset each keep their own callback);
//   • Google Maps — Map / Marker / LatLngBounds, and a DirectionsService whose answers are released by the test (deferred,
//     in any order);
//   • the glide engine is the REAL driver-glide.js, wrapped in a recorder (update / cancel calls);
//   • a virtual clock: Date.now / performance.now / setTimeout / requestAnimationFrame. A timer fires exactly at its deadline
//     (or a chosen few ms early, to prove the re-arm); microtasks are flushed after every step.
const assert = require('assert');
const { page, T0 } = require('./tracker-live-harness.test.cjs');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const DEST = { dest_lat: 15.51, dest_lng: -88.03 };
const P0 = { lat: 15.5, lng: -88.02 };
const north = (p, m) => ({ lat: p.lat + m / 111195, lng: p.lng });
const live = (pg, loc, over = {}, off = 0) => ({ order_id: 'PZX-1', order_type: 'delivery', status: 'out_for_delivery', ...DEST,
  is_active_drop: true, driver_name: 'Carlos',
  mx: { mode: 'live', owner_tag: 'tagO', shift_id: 's1', epoch: 3, name: 'Carlos', smp: { owner_tag: 'tagO', shift_id: 's1', sample_at: 1 } },
  driver_location: loc ? { ...loc, at: pg.serverNow(off) } : null, ...over });
const neutral = (pg, smpOwner = 'tagO', name = 'Carlos', epoch = 4) => ({ order_id: 'PZX-1', order_type: 'delivery', status: 'out_for_delivery', ...DEST,
  is_active_drop: null, driver_name: null, driver_location: null, dest_lat: null, dest_lng: null,
  mx: { mode: 'neutral', owner_tag: 'none', shift_id: null, epoch, name, smp: { owner_tag: smpOwner, shift_id: smpOwner === 'none' ? null : 's1', sample_at: 1 } } });

(async () => {
  // ── 1. O2 + the map + the first answer ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0));
    assert.strictEqual(pg.title(), 'Carlos está en camino'); assert.ok(pg.mapShown(), 'the map shows with a live location');
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'no answer yet → the calm live copy');
    assert.strictEqual(pg.routes.length, 1);
    await pg.answer(0, 380);
    assert.strictEqual(pg.sub(), 'Llega en ~7 min', 'O2: 380 s → ceil → 7 (no +2)');
    ok('O2: travel 380 s → "Llega en ~7 min"; before the answer, "En ruta a tu dirección"; the map shows');

    // ── 2. the exact deadline, with NO data event ──
    await pg.advance(89999);
    assert.strictEqual(pg.sub(), 'Llega en ~7 min', 'still fresh 1 ms before the deadline');
    await pg.advance(1);
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'at exactly 90 s the minutes hide');
    assert.ok(pg.mapShown(), 'the MAP stays (age never removes it)');
    ok('deadline: at exactly 90 s (no data event) the timer hides the minutes; the map stays');

    // ── 3. stale → fresh, same owner: the glide continues ──
    const u0 = pg.updates();
    await pg.emit(live(pg, north(P0, 50)));
    assert.ok(pg.mapShown()); assert.strictEqual(pg.updates(), u0 + 1, 'the glide engine receives the new sample');
    assert.strictEqual(pg.cancels(), 0, 'NO cancel — the glide continues from the held position (no re-first-sighting)');
    assert.strictEqual(pg.routes.length, 2, 'a new request (60 s passed)');
    await pg.answer(1, 300);
    assert.strictEqual(pg.sub(), 'Llega en ~5 min');
    ok('stale → fresh (same owner): glide update, no cancel; minutes return with the new answer');

    // ── 4. out of order: B resolves, then A late ──
    await pg.emit(live(pg, north(P0, 300)));   // moved 250 m → request A (#2)
    await pg.emit(live(pg, north(P0, 560)));   // moved 260 m → request B (#3)
    assert.strictEqual(pg.routes.length, 4);
    await pg.answer(3, 120);
    assert.strictEqual(pg.sub(), 'Llega en ~2 min', 'B shown');
    await pg.answer(2, 900);
    assert.strictEqual(pg.sub(), 'Llega en ~2 min', 'A (late, superseded) is dropped');
    ok('out-of-order: B resolves, A resolves late → B\'s minutes, A dropped');

    // ── 5. the sample moves ≥ 200 m before a new answer; the destination changes ──
    await pg.emit(live(pg, north(P0, 800)));
    assert.strictEqual(pg.routes.length, 5); assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'the answer no longer matches the displayed sample');
    await pg.answer(4, 200);
    assert.strictEqual(pg.sub(), 'Llega en ~4 min');
    await pg.emit(live(pg, north(P0, 800), { dest_lat: 15.52 }));
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'a destination change voids the answer');
    ok('a sample ≥ 200 m away, or a changed destination, hides the minutes until a matching answer arrives');
  }

  // ── 6. the server offset: none yet → no minutes; arrives → minutes; changes → re-checked ──
  {
    const pg = page();
    await pg.emit(live(pg, P0)); await pg.answer(0, 380);
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'no offset yet → nothing is fresh');
    await pg.offset(0);
    assert.strictEqual(pg.sub(), 'Llega en ~7 min', 'the offset arrives → minutes');
    await pg.offset(200000);
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'a new offset re-checks (the sample is now 200 s old by server time)');
    ok('server offset: absent → no minutes; arrival shows them; a change re-checks (sub-line only)');
  }

  // ── 7. deadlines with offsets ±60 s and an early-firing timer ──
  for (const off of [60000, -60000]) {
    const pg = page(); await pg.offset(off);
    await pg.emit(live(pg, P0, {}, off)); await pg.answer(0, 380);
    assert.strictEqual(pg.sub(), 'Llega en ~7 min');
    await pg.advance(89999); assert.strictEqual(pg.sub(), 'Llega en ~7 min');
    await pg.advance(1); assert.strictEqual(pg.sub(), 'En ruta a tu dirección');
  }
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0));
    pg.early(5);                            // the timer armed by the next answer fires 5 ms early
    await pg.answer(0, 380);
    await pg.advance(89995);
    assert.strictEqual(pg.sub(), 'Llega en ~7 min', 'fired early: still fresh, re-armed');
    await pg.advance(5);
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'the re-armed timer hides at the deadline');
  }
  ok('deadlines hold with server offsets +60 s / −60 s; an early-firing timer re-arms and hides exactly at the deadline');

  // ── 8. a return to the tab after the deadline (timers throttled away) ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0)); await pg.answer(0, 380);
    await pg.visible(false); pg.dropTimers(); await pg.advance(100000);
    assert.strictEqual(pg.sub(), 'Llega en ~7 min', 'premise: no timer fired while hidden');
    await pg.visible(true);
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'visibilitychange → re-checked → hidden');
    ok('visibilitychange: returning after the deadline hides the minutes');
  }

  // ── 9. same owner live → neutral → live: no cancel; the old answer is dropped ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0)); await pg.answer(0, 380);
    await pg.emit(neutral(pg));
    assert.strictEqual(pg.title(), 'Tu pedido va en camino'); assert.strictEqual(pg.sub(), 'Con Carlos · pronto llegará a tu dirección');
    assert.ok(!pg.mapShown(), 'no location (server-cleared) → no map');
    await pg.emit(live(pg, north(P0, 30), { mx: { mode: 'live', owner_tag: 'tagO', shift_id: 's1', epoch: 5, name: 'Carlos', smp: { owner_tag: 'tagO', shift_id: 's1', sample_at: 2 } } }));
    assert.ok(pg.mapShown()); assert.strictEqual(pg.cancels(), 0, 'same owner → no cancel'); assert.ok(pg.updates() >= 1, 'the glide continues');
    assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'the previous claim\'s answer was dropped');
    ok('same owner live → neutral → live: calm copy (B) in neutral, no cancel, the glide continues, the old answer dropped');
  }

  // ── 10. a REAL reassign (smp O → P): one cancel, the old answer dropped, the new name ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0)); await pg.answer(0, 380);
    await pg.emit(live(pg, north(P0, 300)));      // request #1 pending for O
    await pg.emit(neutral(pg, 'tagP', 'Pedro', 6));
    assert.strictEqual(pg.cancels(), 1, 'a real owner change → exactly one cancel');
    assert.strictEqual(pg.sub(), 'Con Pedro · pronto llegará a tu dirección'); assert.ok(!pg.mapShown());
    await pg.answer(1, 100);                      // O's late answer
    assert.strictEqual(pg.sub(), 'Con Pedro · pronto llegará a tu dirección', 'the old driver\'s late answer writes nothing');
    await pg.emit(live(pg, north(P0, 900), { driver_name: 'Pedro', mx: { mode: 'live', owner_tag: 'tagP', shift_id: 's1', epoch: 7, name: 'Pedro', smp: { owner_tag: 'tagP', shift_id: 's1', sample_at: 1 } } }));
    assert.strictEqual(pg.title(), 'Pedro está en camino'); assert.ok(pg.mapShown()); assert.strictEqual(pg.cancels(), 1);
    ok('reassign O → P: one cancel, the old late answer dropped, "Con Pedro…" then "Pedro está en camino" with the map');
  }

  // ── 11. initial metadata arrival and the 'none' interlude ──
  {
    const pg = page(); await pg.offset(0);
    const gen1 = { ...live(pg, P0) }; delete gen1.mx;
    await pg.emit(gen1); await pg.emit(live(pg, north(P0, 20)));
    assert.strictEqual(pg.cancels(), 0, 'no mx → mx: no cancel');
    await pg.emit(neutral(pg, 'none', null)); await pg.emit(live(pg, north(P0, 40)));
    assert.strictEqual(pg.cancels(), 0, 'O → none → O: no cancel');
    await pg.emit(neutral(pg, 'none', null)); await pg.emit(neutral(pg, 'tagP', 'Pedro'));
    assert.strictEqual(pg.cancels(), 1, 'O → none → P: one cancel');
    ok('initial mx arrival → no cancel; O → none → O → no cancel; O → none → P → one cancel');
  }

  // ── 12. terminal: delivered copy; a late answer writes nothing ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0));
    await pg.emit({ ...live(pg, null), status: 'delivered', delivered_at: T0, driver_location: null, mx: { mode: 'terminal', owner_tag: 'none', shift_id: null, epoch: 9, name: 'Carlos', smp: { owner_tag: 'tagO', shift_id: 's1', sample_at: 1 } } });
    assert.strictEqual(pg.title(), '¡Pedido entregado!'); const s = pg.sub();
    await pg.answer(0, 380);
    assert.strictEqual(pg.sub(), s, 'a late answer after terminal writes nothing'); assert.ok(!pg.mapShown());
    ok('terminal: delivered copy, no map; a late Directions answer writes nothing');
  }

  // ── 13. D1 · D4 · waiting · names ──
  {
    const pg = page(); await pg.offset(0);
    const noFlag = { order_id: 'PZX-1', order_type: 'delivery', status: 'out_for_delivery', driver_name: 'Carlos', picked_up_at: T0 - 3 * 60000, delivery_eta_min: 8 };
    await pg.emit(noFlag);
    assert.strictEqual(pg.title(), 'Tu pedido va en camino'); assert.strictEqual(pg.sub(), 'Con Carlos · pronto llegará a tu dirección'); assert.strictEqual(pg.avatar(), 'C');
    await pg.advance(5 * 60000); await pg.emit(noFlag);
    assert.ok(!/Llega en/.test(pg.sub()), 'no countdown at any pickup time');
    ok('D1: absent flag + a name + no location → the calm copy (B), never a countdown');

    const noName = live(pg, P0); noName.mx = { ...noName.mx, name: null }; noName.driver_name = 'Viejo';
    await pg.emit(noName);
    assert.strictEqual(pg.title(), 'Tu repartidor está en camino'); assert.ok(pg.mapShown(), 'D4: the map is not gated on the name'); assert.strictEqual(pg.avatar(), null);
    const noNameCalm = neutral(pg, 'tagO', null);
    await pg.emit(noNameCalm);
    assert.strictEqual(pg.sub(), 'Pronto llegará a tu dirección'); assert.ok(!pg.mapShown());
    ok('D4: mx.name null + live location → "Tu repartidor está en camino" WITH the map; without a location → the no-name calm copy, no map');

    await pg.emit({ ...live(pg, null), mx: { mode: 'waiting', owner_tag: 'tagO', shift_id: 's1', epoch: 11, name: 'Carlos', smp: { owner_tag: 'tagO', shift_id: 's1', sample_at: 1 } }, is_active_drop: false });
    assert.strictEqual(pg.title(), 'Carlos va en camino'); assert.ok(/parada rápida/.test(pg.sub())); assert.ok(!pg.mapShown());
    ok('waiting: today\'s stacked copy, no map');
  }

  // ── 14. rollback window: a stale mx with contradicting legacy fields → a safe render, never stale minutes ──
  {
    const pg = page(); await pg.offset(0);
    const r1 = live(pg, P0); r1.mx = { ...r1.mx, mode: 'neutral' };      // mx says neutral, legacy says live
    await pg.emit(r1);
    assert.strictEqual(pg.title(), 'Tu pedido va en camino'); assert.ok(!pg.mapShown(), 'calm, no map (safe)');
    const r2 = live(pg, P0); r2.driver_location = { ...P0, at: T0 - 600000 };   // mx live, a 10-minute-old location
    await pg.emit(r2); if (pg.routes.length) await pg.answer(pg.routes.length - 1, 380);
    assert.ok(pg.mapShown()); assert.strictEqual(pg.sub(), 'En ruta a tu dirección', 'an old location never shows minutes');
    ok('rollback window: stale mx + contradicting legacy fields → calm (no map) or live with gated minutes — never stale minutes');
  }

  // ── 15. codex build r1 P1: a REAL reassign while Maps is still loading — A's queued samples never seed B's marker ──
  {
    const pg = page({ deferMaps: true }); await pg.offset(0);
    const FAR = north(P0, 3000);
    await pg.emit(live(pg, P0));                         // A1 (owner O) — queued behind the Maps load
    await pg.emit(live(pg, north(P0, 100)));             // A2 — queued
    await pg.emit(neutral(pg, 'tagP', 'Pedro', 6));      // the real reassign O → P (the engine does not exist yet: nothing to cancel)
    const mxP = (e, sa) => ({ mode: 'live', owner_tag: 'tagP', shift_id: 's1', epoch: e, name: 'Pedro', smp: { owner_tag: 'tagP', shift_id: 's1', sample_at: sa } });
    await pg.emit(live(pg, FAR, { driver_name: 'Pedro', mx: mxP(7, 1) }));   // B1 — queued
    assert.strictEqual(pg.driverMarkers().length, 0, 'premise: nothing drawn while Maps loads');
    await pg.resolveMaps();
    const drv = pg.driverMarkers();
    assert.strictEqual(drv.length, 1, 'exactly one driver marker');
    assert.strictEqual(drv[0].title, 'Pedro', '🔴 the marker is created for the NEW driver (A\'s queued samples dropped)');
    assert.ok(Math.abs(drv[0].pos.lat - FAR.lat) < 1e-9, '🔴 B\'s marker starts at B\'s own first sample, not at A\'s position');
    assert.strictEqual(pg.updates(), 0, 'no glide update replayed from A\'s queued samples');
    await pg.emit(live(pg, north(FAR, 100), { driver_name: 'Pedro', mx: mxP(7, 2) }));   // B2
    await pg.emit(live(pg, north(FAR, 220), { driver_name: 'Pedro', mx: mxP(7, 3) }));   // B3 — B's first interpolated glide
    const st = pg.glideState();
    assert.ok(st && st.startPos && st.startPos.lat > FAR.lat - 1e-6, `🔴 B's first glide starts in B's own path, never from A (start ${st && st.startPos && st.startPos.lat})`);
    ok('reassign while Maps loads: A\'s queued samples are dropped — B\'s marker is created at B\'s first sample and its first glide starts on B\'s path');
  }

  // ── 16. codex build r1 P2: leaving live leaves no pending ETA expiry timer ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0)); await pg.answer(0, 380);
    assert.strictEqual(pg.timersNamed('renderEtaLine'), 1, 'premise: the minutes armed one expiry timer');
    await pg.emit({ ...live(pg, null), status: 'delivered', delivered_at: T0, driver_location: null, mx: { mode: 'terminal', owner_tag: 'none', shift_id: null, epoch: 9, name: 'Carlos', smp: { owner_tag: 'tagO', shift_id: 's1', sample_at: 1 } } });
    assert.strictEqual(pg.timersNamed('renderEtaLine'), 0, '🔴 after delivery no ETA expiry timer may stay pending');
    ok('leaving live (delivered) clears the pending ETA expiry timer');
  }

  // ── 19. codex build r2 P1: once the live map exists, updateDriverMap runs SYNCHRONOUSLY within render (today's timing) ──
  {
    const pg = page(); await pg.offset(0);
    await pg.emit(live(pg, P0));                         // first sample: Maps loads, the map is created
    assert.ok(pg.driverMarkers().length === 1, 'premise: the live map exists');
    const u0 = pg.udm();
    pg.emitSync(live(pg, north(P0, 60)));
    assert.strictEqual(pg.udm(), u0 + 1, '🔴 with the map already created, render calls updateDriverMap synchronously (same tick), exactly once');
    pg.emitSync(live(pg, north(P0, 120)));
    assert.strictEqual(pg.udm(), u0 + 2, 'each render → one synchronous call (the base\'s count)');
    await pg.advance(0);
    assert.strictEqual(pg.udm(), u0 + 2, 'no extra deferred call afterwards');
    ok('timing equivalence: with the live map created, every render calls updateDriverMap synchronously, once — as the base does');
  }

  console.log(`\ntracker-live: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
