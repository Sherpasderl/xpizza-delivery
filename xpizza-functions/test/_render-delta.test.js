'use strict';
// test/_render-delta.js makeColdOnly (R1c) — under the catalog clock the only catalog traffic set aside is the COLD load,
// once per restaurant, plus the floor read; a GATE / CTX refill stays IN. Run: node test/_render-delta.test.js
const assert = require('assert');
const RD = require('./_render-delta');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${n} ${m}`); };
const S = RD.refillShapes('x_pizza');
const fs = (shape) => shape.map((o) => ({ db: 'fs', ...o }));
const r = (path, op = 'once') => ({ db: 'rtdb', op, path });
const FLOOR = r('platform_config/client_floor/orders', 'get');
const RESET = r('rate_limits', 'remove');
const ignore = (o) => o.db === 'rtdb' && o.op === 'remove' && o.path === 'rate_limits';
const TAIL = [r('config/token_enforce', 'get'), r('orders/<oid>')];

// a stand-in for the installed catalog clock: assertBuilt is what makeColdOnly consults (the real one is proved in
// test/_catalog-clock.test.js); `built` toggles whether the singletons went through the hook
const fakeClock = (built = true) => ({ assertBuilt: (names, label) => { if (!built) throw new Error(`🔴 ${label}: ${names[0]} was built 0× through the clock hook`); } });

// ── the COLD load (and the floor read) is set aside, exactly, once per restaurant ───────────────────────────────────
{
  const F = RD.makeColdOnly(['x_pizza', 'la_musa'], fakeClock());
  assert.deepStrictEqual(F.strip([FLOOR, ...fs(S.COLD), ...TAIL], 'x_pizza', 'a', 'cold'), TAIL, 'the process\'s first load (COLD, with its one transaction) + the floor read');
  assert.deepStrictEqual(F.strip([FLOOR, ...fs(S.COLD), ...TAIL], 'x_pizza', 'a', 'cold again'), TAIL, 'the SAME recorded request compared twice (both companion sides) is still its one COLD');
  assert.deepStrictEqual(F.strip([RESET, ...fs(RD.refillShapes('la_musa').COLD), ...TAIL], 'la_musa', 'b', 'cold la_musa', { ignore }), [RESET, ...TAIL], 'each restaurant has its own COLD, after the suite\'s own reset');
  const vs = (shape) => fs(shape).map((o) => (o.path ? { ...o, path: o.path.replace('<v>', 'v-1791748670699-fdd8c96a672d') } : o.paths ? { ...o, paths: o.paths.map((p) => p.replace('<v>', 'v-1791748670699-fdd8c96a672d')) } : o));
  const G = RD.makeColdOnly(['x_pizza'], fakeClock());
  assert.deepStrictEqual(G.strip([...vs(S.COLD), ...TAIL], 'x_pizza', 'd', 'raw version id'), TAIL, 'either suite\'s version spelling (normalised <v> or the raw id)');
  assert.throws(() => G.strip([...fs(S.COLD), ...TAIL], 'x_pizza', 'd2', 'second cold'), /a SECOND COLD catalog load/, '🔴 a second COLD for the same restaurant (another request) fails');
  ok('COLD (31 ops, one transaction) and the floor read are set aside in their exact shapes, once per restaurant (a request compared twice counts once; a second COLD fails)');
}

// ── a GATE / CTX refill is NOT set aside any more: under the clock it cannot be due, so it stays IN ────────────────────
{
  const F = RD.makeColdOnly(['x_pizza'], fakeClock());
  assert.deepStrictEqual(F.strip([...fs(S.GATE), ...TAIL], 'x_pizza', 'g', 'leading gate'), [...fs(S.GATE), ...TAIL], '🔴 a leading GATE re-read stays IN (it would show as a diff)');
  assert.deepStrictEqual(F.strip([...fs(S.CTX), ...TAIL], 'x_pizza', 'c', 'leading ctx'), [...fs(S.CTX), ...TAIL], '🔴 a leading CTX refill stays IN');
  assert.deepStrictEqual(F.strip([TAIL[0], ...fs(S.GATE), TAIL[1]], 'x_pizza', 'm', 'mid gate'), [TAIL[0], ...fs(S.GATE), TAIL[1]], 'a mid-request GATE re-read stays IN');
  const inj = [{ db: 'fs', op: 'runTransaction' }, ...Array.from({ length: 100 }, () => ({ db: 'fs', op: 'get', path: 'restaurants/x_pizza/meta/active_version' }))];
  assert.deepStrictEqual(F.strip([...inj, ...TAIL], 'x_pizza', 'e', 'injection'), [...inj, ...TAIL], 'codex\'s injection (1 transaction + 100 catalog reads) stays IN');
  const near = [...fs(S.COLD).slice(0, -1), ...TAIL];   // a COLD one op short is not COLD
  assert.deepStrictEqual(F.strip(near, 'x_pizza', 'n', 'near cold'), near, 'a COLD one operation short is not set aside');
  const mid = [TAIL[0], ...fs(S.COLD), TAIL[1]];
  assert.deepStrictEqual(F.strip(mid, 'x_pizza', 'q', 'mid cold'), mid, 'a COLD that does not LEAD the request is not set aside');
  assert.throws(() => F.strip([FLOOR, FLOOR, ...TAIL], 'x_pizza', 'f2', 'floor twice'), /client-floor/, 'two floor reads are refused');
  assert.throws(() => F.strip([r('platform_config/client_floor/orders', 'set'), ...TAIL], 'x_pizza', 'fw', 'floor write'), /client-floor/, 'a floor write is refused');
  ok('kept IN: a leading GATE, a leading CTX, a mid GATE, codex\'s injection, a COLD one op short, a COLD that does not lead; refused: two floor reads, a floor write');
}

// ── the clock is REQUIRED and consulted; the floor keeps its wall-time bound ────────────────────────────────────────
{
  assert.throws(() => RD.makeColdOnly(['x_pizza']), /pass the installed catalog clock/, '🔴 no clock → refused (a GATE / CTX refill could still be due)');
  const F = RD.makeColdOnly(['x_pizza'], fakeClock(false));
  assert.throws(() => F.assertBounded('x'), /built 0× through the clock hook/, '🔴 singletons not built through the hook fail the bound');
  const G = RD.makeColdOnly(['x_pizza'], fakeClock());
  for (let i = 0; i < 3; i += 1) G.strip([FLOOR, ...TAIL], 'x_pizza', `f${i}`, 'floor');
  assert.throws(() => G.assertBounded('x'), /a per-request read, not a TTL/, '🔴 a floor read on every request exceeds the wall-time budget');
  const H = RD.makeColdOnly(['x_pizza'], fakeClock());
  H.strip([FLOOR, ...fs(S.COLD), ...TAIL], 'x_pizza', 'one', 'a');
  assert.deepStrictEqual(H.assertBounded('x').seen.x_pizza, { COLD: 1, FLOOR: 1 }, 'counted');
  ok('makeColdOnly requires the installed clock and assertBounded consults it; the floor (real clock) keeps ⌊elapsed / 30 s⌋ + 1');
}

console.log(`\n_render-delta: OK (${n})`);
