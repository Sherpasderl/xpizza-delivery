/**
 * Unit tests for the pure driver-glide state machine (dispatch Item A).
 * Run: `node driver-glide.test.js` (from xpizza-dispatch/).
 *
 * A fake clock + fake rAF queue make every behavior deterministic — especially
 * the build-gate: a fresh update mid-glide must cancel the prior frame, keep
 * exactly one animation, and restart from the currently-displayed position.
 */
import assert from 'node:assert';
import { lerpLatLng, distanceMeters, createGlideEngine } from './driver-glide.js';

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ---- pure helpers ----
{
  const m = lerpLatLng({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5);
  assert.strictEqual(m.lat, 5);
  assert.strictEqual(m.lng, 10);
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
  let t = 0;
  let nextId = 1;
  let frames = [];           // { id, cb } pending frames
  const applied = [];        // { uid, pos }
  const cancelled = [];      // ids passed to caf
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
const B = { lat: 15.500, lng: -88.001 };   // ~107m east of A (glide range)
const C = { lat: 15.5005, lng: -88.001 };  // within glide range of the A->B path
const FAR = { lat: 15.60, lng: -88.10 };   // >10km — implausible jump

// ---- first sighting snaps ----
{
  const h = harness();
  h.at(0);
  h.engine.update('u1', A);
  assert.strictEqual(h.applied.length, 1);
  assert.deepStrictEqual(h.applied[0], { uid: 'u1', pos: A });
  assert.strictEqual(h.pending(), 0, 'first sighting must not schedule an animation');
  assert.ok(h.engine.has('u1'));
  ok('first sighting snaps, no animation');
}

// ---- glides A->B over the measured 10s gap ----
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);
  const s = h.engine._state('u1');
  assert.strictEqual(s.duration, 10000, 'duration = clamped measured Δt');
  assert.strictEqual(h.pending(), 1, 'exactly one animation frame queued');

  h.at(10000); h.tick();
  assert.ok(distanceMeters(h.lastApplied().pos, A) < 0.5, 'starts at A');
  h.at(15000); h.tick();
  const mid = lerpLatLng(A, B, 0.5);
  assert.ok(distanceMeters(h.lastApplied().pos, mid) < 0.5, 'midpoint at half time');
  h.at(20000); h.tick();
  assert.ok(distanceMeters(h.lastApplied().pos, B) < 0.5, 'reaches B');
  assert.strictEqual(h.pending(), 0, 'no frame left after completion');
  assert.strictEqual(h.engine._state('u1').duration, 0, 'state settled');
  ok('glides A->B over measured 10s, settles at B');
}

// ---- duration clamps to [MIN, MAX] ----
{
  const h = harness();
  h.at(0);     h.engine.update('u1', A);
  h.at(200);   h.engine.update('u1', B);
  assert.strictEqual(h.engine._state('u1').duration, 1000, 'clamps up to MIN');

  const h2 = harness();
  h2.at(0);      h2.engine.update('u2', A);
  h2.at(30000);  h2.engine.update('u2', B);
  assert.strictEqual(h2.engine._state('u2').duration, 12000, 'clamps down to MAX');
  ok('duration clamps to [1s, 12s]');
}

// ---- ★ build-gate: supersede mid-glide ----
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);       // glide #1 begins
  h.at(13000);  h.tick();                        // p=0.3, frame reschedules
  const firstFrameId = h.engine._state('u1').rafId;

  h.at(13000);  h.engine.update('u1', C);        // fresh update mid-glide -> supersede
  assert.ok(h.cancelled.includes(firstFrameId), 'superseded frame was cancelled');
  assert.strictEqual(h.pending(), 1, 'exactly ONE frame after supersede (no leak, no fight)');

  const expectedFrom = lerpLatLng(A, B, 0.3);
  const s = h.engine._state('u1');
  assert.ok(distanceMeters(s.startPos, expectedFrom) < 0.5, 'new glide starts from displayed pos, not A or B');
  assert.deepStrictEqual(s.targetPos, C, 'new glide targets C');
  ok('supersede mid-glide: one frame, cancels prior, restarts from displayed pos');
}
{
  const h = harness();
  h.at(0); h.engine.update('u1', A);
  for (let i = 1; i <= 20; i++) {
    h.at(i * 1000);
    h.engine.update('u1', i % 2 ? B : C);
    assert.ok(h.pending() <= 1, `never more than one pending frame (iter ${i}, got ${h.pending()})`);
  }
  ok('repeated supersedes never leak frames');
}

// ---- snap paths ----
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', B);
  h.at(11000);  h.engine.update('u1', C, { snap: true });
  assert.strictEqual(h.pending(), 0, 'stale snap cancels the glide');
  assert.deepStrictEqual(h.lastApplied().pos, C, 'snapped to last-known pos');
  ok('stale mid-glide snaps, no animation');
}
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  h.at(10000);  h.engine.update('u1', FAR);
  assert.strictEqual(h.pending(), 0, 'implausible jump does not slide across the map');
  assert.deepStrictEqual(h.lastApplied().pos, FAR);
  ok('large delta snaps');
}
{
  const h = harness();
  h.at(0);      h.engine.update('u1', A);
  const n = h.applied.length;
  h.at(3000);   h.engine.update('u1', { lat: A.lat, lng: A.lng });
  assert.strictEqual(h.pending(), 0, 'identical position must not spawn a 1s glide');
  assert.strictEqual(h.applied.length, n + 1, 'still applied once (idempotent)');
  ok('identical position does not animate');
}

// ---- removal cancels frame + drops state ----
{
  const h = harness();
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
