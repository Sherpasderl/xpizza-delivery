// dispatch-maps-perf-gate.test.mjs — PLAN §6.4 gate logic (pure, light).
// Proves the gate is fail-closed: any timed-out/incomplete run fails its scenario (never a median of the
// survivors — Codex r2 new P2), and delayed/failed medians must stay within 1.15x the baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, evaluateGate } from './dispatch-maps-perf.mjs';

const ok = (v) => ({ value: v, timedOut: false });
const to = () => ({ value: null, timedOut: true });
const scn = (bu, du) => ({ board_useful_ms: aggregate(bu), driver_useful_ms: aggregate(du) });

test('aggregate: median/p95 over complete runs; counts incompletes', () => {
  const a = aggregate([ok(10), ok(12), ok(11), to(), ok(13)]);
  assert.equal(a.incomplete, 1);
  assert.equal(a.total, 5);
  assert.equal(a.median, 11);
});

test('NEW P2: 4 timed-out runs + 1 fast success ⇒ gate FAILS (no median of survivors)', () => {
  const results = {
    maps_delayed: scn([to(), to(), to(), to(), ok(10)], [to(), to(), to(), to(), ok(10)]),
    maps_failed: scn([ok(10), ok(10), ok(10), ok(10), ok(10)], [ok(10), ok(10), ok(10), ok(10), ok(10)]),
    no_map_baseline: scn([ok(10), ok(10), ok(10), ok(10), ok(10)], [ok(10), ok(10), ok(10), ok(10), ok(10)]),
  };
  const { passed, checks } = evaluateGate(results);
  assert.equal(passed, false, 'a scenario with incomplete runs must fail the gate');
  assert.ok(checks.some((c) => c.scenario === 'maps_delayed' && /incomplete/.test(c.reason || '')), 'named incomplete failure');
});

test('all complete + ratio 1.0x ⇒ gate PASSES', () => {
  const results = {
    maps_delayed: scn([ok(10), ok(10), ok(10)], [ok(10), ok(10), ok(10)]),
    maps_failed: scn([ok(10), ok(11), ok(10)], [ok(10), ok(10), ok(11)]),
    no_map_baseline: scn([ok(10), ok(10), ok(10)], [ok(10), ok(10), ok(10)]),
  };
  assert.equal(evaluateGate(results).passed, true);
});

test('a 2x regression (e.g. boot awaits Maps) ⇒ gate FAILS on the ratio', () => {
  const results = {
    maps_delayed: scn([ok(20), ok(20), ok(20)], [ok(20), ok(20), ok(20)]),   // board now waits on Maps
    maps_failed: scn([ok(10), ok(10), ok(10)], [ok(10), ok(10), ok(10)]),
    no_map_baseline: scn([ok(10), ok(10), ok(10)], [ok(10), ok(10), ok(10)]),
  };
  const { passed, checks } = evaluateGate(results);
  assert.equal(passed, false);
  assert.ok(checks.some((c) => c.scenario === 'maps_delayed' && c.ok === false && c.ratio >= 1.15), 'ratio breach recorded');
});

test('a missing measurement ⇒ gate FAILS (never silently passes)', () => {
  const results = {
    maps_delayed: scn([ok(10)], [ok(10)]),
    maps_failed: { /* board/driver missing */ },
    no_map_baseline: scn([ok(10)], [ok(10)]),
  };
  assert.equal(evaluateGate(results).passed, false);
});
