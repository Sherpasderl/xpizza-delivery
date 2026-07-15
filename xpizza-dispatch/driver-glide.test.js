/**
 * Unit tests for the pure driver-glide state machine (dispatch Item A + continuous-glide fix).
 * Run: `node driver-glide.test.js` (from xpizza-dispatch/).
 *
 * A fake clock + fake rAF queue make every behavior deterministic. Core-timing tests run
 * margin-neutral (marginFactor:1) so exact durations are asserted independently of the margin;
 * the margin has its own test. The ★ tests pin the continuous-glide fix: a same-target call
 * (the 5s label tick / other-driver churn) must be a true no-op — it must not reset the clock
 * or restart the animation — so a real move's duration ≈ the real inter-target interval.
 */
import assert from 'node:assert';
import { lerpLatLng, distanceMeters, createGlideEngine } from './driver-glide.js';

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ---- pure helpers ----
{
  const m = lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5);
  assert.strictEqual(m.lat, 5); assert.strictEqual(m.lng, 10);
  ok('lerpLatLng midpoint');
}
{
  assert.deepStrictEqual(lerpLatLng({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, 0), { lat: 1, lng: 2 });
  assert.deepStrictEqual(lerpLatLng({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, 1), { lat: 3, lng: 4 });
  ok('lerpLatLng endpoints');
}
{
  assert.ok(distanceMeters({ lat: 15.5, lng: -88 }, { lat: 15.5, lng: -88 }) < 0.001);
  const d = distanceMeters({ lat: 15.5, lng: -88 }, { lat: 15.501, lng: -88 });
  assert.ok(d > 100 && d < 125, `expected ~111m, got ${d}`);
  ok('distanceMeters sanity');
}

// ---- deterministic harness: fake clock + fake rAF queue ----
function harness(options) {
  let t = 0, nextId = 1, frames = [];
  const applied = [], cancelled = [];
  const engine = createGlideEngine({
    now: () => t,
    raf: (cb) => { const id = nextId++; frames.push({ id, cb }); return id; },
    caf: (id) => { cancelled.push(id); frames = frames.filter((f) => f.id !== id); },
    apply: (uid, pos) => applied.push({ uid, pos: { lat: pos.lat, lng: pos.lng } }),
    options,
  });
  return {
    engine,
    at: (v) => { t = v; },
    tick: () => { const batch = frames; frames = []; batch.forEach((f) => f.cb()); },
    pending: () => frames.length,
    applied, cancelled,
    lastApplied: () => applied[applied.length - 1],
  };
}

const A = { lat: 15.500, lng: -88.000 };
const B = { lat: 15.500, lng: -88.001 };   // ~107m east of A
const C = { lat: 15.5005, lng: -88.001 };  // ~55m from B
const FAR = { lat: 15.60, lng: -88.10 };   // >10km — implausible jump
const NOMARGIN = { marginFactor: 1 };      // exact-timing tests: duration = measuredDt

// ---- first sighting snaps ----
{
  const h = harness(NOMARGIN);
  h.at(0); h.engine.update('u1', A);
  assert.strictEqual(h.applied.length, 1);
  assert.deepStrictEqual(h.applied[0], { uid: 'u1', pos: A });
  assert.strictEqual(h.pending(), 0, 'first sighting must not schedule an animation');
  ok('first sighting snaps, no animation');
}

// ---- ★ new-marker init: snap:true registers engine state so the FIRST real move glides ----
{
  const h = harness(NOMARGIN);
  assert.strictEqual(h.engine.has('u1'), false, 'no state before init');
  h.at(0); h.engine.update('u1', A, { snap: true });   // updateDriverMarkers new-marker branch
  assert.strictEqual(h.engine.has('u1'), true, 'engine state exists after init');
  assert.strictEqual(h.pending(), 0, 'init places at pos, no animation');
  h.at(10000); h.engine.update('u1', B);               // first real move now GLIDES (not a teleport)
  assert.strictEqual(h.pending(), 1, 'first move glides');
  ok('new-marker init registers state → first real move glides, not teleports');
}

// ---- glides A->B over the measured 10s gap (margin-neutral) ----
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);
  assert.strictEqual(h.engine._state('u1').duration, 10000, 'duration = measured Δt (margin 1)');
  assert.strictEqual(h.pending(), 1);
  h.at(10000); h.tick(); assert.ok(distanceMeters(h.lastApplied().pos, A) < 0.5, 'starts at A');
  h.at(15000); h.tick(); assert.ok(distanceMeters(h.lastApplied().pos, lerpLatLng(A, B, 0.5)) < 0.5, 'midpoint at half time');
  h.at(20000); h.tick(); assert.ok(distanceMeters(h.lastApplied().pos, B) < 0.5, 'reaches B');
  assert.strictEqual(h.pending(), 0);
  ok('glides A->B over measured 10s, settles at B');
}

// ---- duration clamps to [MIN=1000, MAX=15000] (margin-neutral) ----
{
  const h = harness(NOMARGIN);
  h.at(0);     h.engine.update('u1', A);
  h.at(200);   h.engine.update('u1', B);
  assert.strictEqual(h.engine._state('u1').duration, 1000, 'clamps up to MIN');

  const h2 = harness(NOMARGIN);
  h2.at(0);      h2.engine.update('u2', A);
  h2.at(30000);  h2.engine.update('u2', B);
  assert.strictEqual(h2.engine._state('u2').duration, 15000, 'clamps down to MAX 15000');
  ok('duration clamps to [1s, 15s]');
}

// ---- ★ MARGIN: duration = measuredDt × marginFactor (default 1.15) ----
{
  const h = harness();   // default marginFactor 1.15
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);
  assert.strictEqual(h.engine._state('u1').duration, 11500, 'duration = 10000 × 1.15');
  ok('margin: duration = measuredDt × marginFactor');
}

// ---- ★ a same-target call MID-GLIDE is a true no-op (the 5s-tick fix) ----
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);          // glide in flight toward B
  const s = h.engine._state('u1');
  const [rafBefore, lutBefore, startBefore] = [s.rafId, s.lastUpdateTime, s.startTime];
  h.at(13000);  h.engine.update('u1', B);          // "render tick" with the SAME (unchanged) target
  const s2 = h.engine._state('u1');
  assert.strictEqual(s2.rafId, rafBefore, 'same-target call must NOT cancel/restart the rAF');
  assert.strictEqual(s2.lastUpdateTime, lutBefore, 'same-target call must NOT reset lastUpdateTime');
  assert.strictEqual(s2.startTime, startBefore, 'glide start unchanged');
  assert.strictEqual(h.pending(), 1, 'still exactly one glide in flight');
  ok('same-target call mid-glide is a true no-op');
}

// ---- ★ duration keys on REAL target changes, not call frequency ----
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);                 // real move → lastUpdateTime = 10000
  for (const tt of [12000, 14000, 16000, 18000]) { h.at(tt); h.engine.update('u1', B); }  // 4 stale ticks
  h.at(20000);  h.engine.update('u1', C);                 // next REAL move
  assert.strictEqual(h.engine._state('u1').duration, 10000,
    'duration = real B→C interval (20000-10000), NOT since-last-tick (2000)');
  ok('duration keys on real target changes, not tick frequency');
}

// ---- ★ build-gate: supersede on a genuinely-new target (margin-neutral) ----
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);
  h.at(13000);  h.tick();
  const firstFrameId = h.engine._state('u1').rafId;
  h.at(13000);  h.engine.update('u1', C);                 // new target → supersede
  assert.ok(h.cancelled.includes(firstFrameId), 'superseded frame cancelled');
  assert.strictEqual(h.pending(), 1, 'exactly ONE frame after supersede');
  assert.ok(distanceMeters(h.engine._state('u1').startPos, lerpLatLng(A, B, 0.3)) < 0.5, 'restarts from displayed pos');
  ok('supersede on new target: one frame, restarts from displayed pos');
}
{
  const h = harness();
  h.at(0); h.engine.update('u1', A);
  for (let i = 1; i <= 20; i++) { h.at(i * 1000); h.engine.update('u1', i % 2 ? B : C); assert.ok(h.pending() <= 1, `iter ${i}`); }
  ok('alternating real targets never leak frames');
}

// ---- snap paths ----
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);
  h.at(11000);  h.engine.update('u1', C, { snap: true });  // stale flag bypasses the no-op
  assert.strictEqual(h.pending(), 0, 'stale snap cancels the glide');
  assert.deepStrictEqual(h.lastApplied().pos, C);
  ok('stale mid-glide snaps (snap bypasses the no-op)');
}
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', FAR);
  assert.strictEqual(h.pending(), 0, 'implausible jump does not slide across the map');
  assert.deepStrictEqual(h.lastApplied().pos, FAR);
  ok('large delta snaps');
}

// ---- ★ identical position → true no-op (not re-applied, clock untouched) ----
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  const n = h.applied.length;
  h.at(3000);   h.engine.update('u1', { lat: A.lat, lng: A.lng });
  assert.strictEqual(h.pending(), 0, 'no glide spawned');
  assert.strictEqual(h.applied.length, n, 'same-target call is a no-op — not re-applied');
  assert.strictEqual(h.engine._state('u1').lastUpdateTime, 0, 'lastUpdateTime untouched by the no-op');
  ok('identical position → true no-op');
}

// ---- removal cancels frame + drops state ----
{
  const h = harness(NOMARGIN);
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);
  const id = h.engine._state('u1').rafId;
  h.engine.cancel('u1');
  assert.ok(h.cancelled.includes(id), 'removal cancels the in-flight frame');
  assert.strictEqual(h.engine.has('u1'), false, 'state dropped');
  assert.strictEqual(h.pending(), 0, 'no leaked frame after removal');
  ok('removed mid-glide cancels frame + drops state');
}

console.log(`\n${pass} passed`);
