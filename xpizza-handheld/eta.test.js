// H1b T5 — eta.js (advisor Q-D correction): the driver's arrival, client-side, traffic-aware, like the tracker. Refresh ~60 s
// while the detail / ready card is visible; stop when hidden or picked up. ANY failure or missing input → null (the name only,
// never a guessed time).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEta, travelSeconds } from './eta.js';

function rig({ fetchState, route }) {
  const timers = []; let t = 1_000_000;
  const eta = createEta({ route, now: () => t, setTimer: (fn, ms) => { const h = { fn, ms, on: true }; timers.push(h); return h; }, clearTimer: (h) => { h.on = false; } });
  return { eta, timers, adv: (ms) => { t += ms; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const state = (over = {}) => ({ driver_assigned: true, driver_location: { lat: 15.51, lng: -88.03, at: 1 }, pickup_location: { lat: 15.5, lng: -88.02 }, ...over });

test('a route result → now + travel seconds; the route is asked from the driver to the restaurant', async () => {
  const asked = [];
  const r = rig({ fetchState: null, route: async (o, d) => { asked.push([o, d]); return 420; } });
  const seen = [];
  r.eta.watch('o1', async () => state(), (ms) => seen.push(ms));
  await tick(); await tick();
  assert.deepEqual(seen, [1_000_000 + 420000]);
  assert.deepEqual(asked, [[{ lat: 15.51, lng: -88.03 }, { lat: 15.5, lng: -88.02 }]]);
});

test('fallbacks: no location / no destination / not assigned / route null / route throws / bad seconds / state null → null', async () => {
  const cases = [
    [async () => state({ driver_location: null }), async () => 100],
    [async () => state({ pickup_location: null }), async () => 100],
    [async () => state({ driver_assigned: false }), async () => 100],
    [async () => state(), async () => null],
    [async () => state(), async () => { throw new Error('OVER_QUERY_LIMIT'); }],
    [async () => state(), async () => -5],
    [async () => state(), async () => NaN],
    [async () => null, async () => 100],
    [async () => { throw new Error('offline'); }, async () => 100],
  ];
  for (const [fetch, route] of cases) {
    const r = rig({ route });
    const seen = [];
    r.eta.watch('o1', fetch, (ms) => seen.push(ms));
    await tick(); await tick();
    assert.deepEqual(seen, [null]);
  }
});

test('refreshes every ~60 s while watched; unwatch stops it and drops a late in-flight result', async () => {
  let n = 0; let release;
  const r = rig({ route: async () => { n++; if (n === 2) await new Promise((res) => { release = res; }); return 60 * n; } });
  const seen = [];
  const stop = r.eta.watch('o1', async () => state(), (ms) => seen.push(ms));
  await tick(); await tick();
  assert.equal(seen.length, 1);
  const t = r.timers.find((h) => h.on);
  assert.equal(t.ms, 60000);
  r.adv(60000); t.fn(); await tick();
  stop();                                             // hidden / picked up while the second route is in flight
  release(); await tick(); await tick();
  assert.equal(seen.length, 1, 'the late result after unwatch is dropped');
  assert.ok(r.timers.every((h) => !h.on), 'no timer left');
});

test('watching the same order twice keeps ONE loop', async () => {
  let n = 0;
  const r = rig({ route: async () => { n++; return 30; } });
  r.eta.watch('o1', async () => state(), () => {});
  r.eta.watch('o1', async () => state(), () => {});
  await tick(); await tick();
  assert.equal(n, 1);
});

test('travelSeconds: duration_in_traffic, else duration; anything else null (the tracker\'s parse)', () => {
  const leg = (o) => ({ routes: [{ legs: [o] }] });
  assert.equal(travelSeconds(leg({ duration_in_traffic: { value: 300 }, duration: { value: 200 } }), 'OK'), 300);
  assert.equal(travelSeconds(leg({ duration: { value: 200 } }), 'OK'), 200);
  assert.equal(travelSeconds(leg({ duration: { value: 200 } }), 'ZERO_RESULTS'), null);
  assert.equal(travelSeconds({ routes: [] }, 'OK'), null);
  assert.equal(travelSeconds(null, 'OK'), null);
});
