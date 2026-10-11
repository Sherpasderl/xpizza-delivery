'use strict';
// test/_render-delta.js makeCacheFill — the render-ON companions' cache-refill exclusion is an EXACT allowlist (codex PB-2
// r1 P2-4). Run: node test/_render-delta.test.js
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

// ── the known refills are set aside, exactly ────────────────────────────────────────────────────────────────────────
{
  const F = RD.makeCacheFill(['x_pizza', 'la_musa']);
  assert.deepStrictEqual(F.strip([FLOOR, ...fs(S.COLD), ...TAIL], 'x_pizza', 'a', 'cold'), TAIL, 'the process\'s first load (COLD, with its one transaction) + the floor read');
  assert.deepStrictEqual(F.strip([RESET, ...fs(S.CTX), ...fs(S.GATE), ...TAIL], 'x_pizza', 'b', 'ctx+gate', { ignore }), [RESET, ...TAIL], 'CTX then GATE in the leading block, after the suite\'s own reset');
  assert.deepStrictEqual(F.strip([...TAIL.slice(0, 1), ...fs(S.GATE), ...TAIL.slice(1)], 'x_pizza', 'c', 'mid gate'), TAIL, 'a gate re-read later in the request (a whole Firestore block on its own)');
  const vs = (shape) => fs(shape).map((o) => (o.path ? { ...o, path: o.path.replace('<v>', 'v-1791748670699-fdd8c96a672d') } : o.paths ? { ...o, paths: o.paths.map((p) => p.replace('<v>', 'v-1791748670699-fdd8c96a672d')) } : o));
  assert.deepStrictEqual(F.strip([...vs(S.CTX), ...TAIL], 'x_pizza', 'd', 'raw version id'), TAIL, 'either suite\'s version spelling (normalised <v> or the raw id)');
  ok('COLD (31 ops, one transaction), CTX, GATE and the floor read are set aside in their exact shapes and places');
}

// ── anything else stays in the comparison, or fails loudly ───────────────────────────────────────────────────────────
{
  const F = RD.makeCacheFill(['x_pizza']);
  // codex's injection: one leading transaction + 100 catalog reads
  const inj = [{ db: 'fs', op: 'runTransaction' }, ...Array.from({ length: 100 }, () => ({ db: 'fs', op: 'get', path: 'restaurants/x_pizza/meta/active_version' }))];
  assert.throws(() => F.strip([...inj, ...TAIL], 'x_pizza', 'e', 'injection'), /not exactly a concatenation of known refills/, '🔴 codex\'s injection (1 transaction + 100 catalog reads) is refused');
  assert.throws(() => F.strip([...fs(S.CTX), { db: 'fs', op: 'get', path: 'restaurants/x_pizza/versions/<v>/menu_items' }, ...TAIL], 'x_pizza', 'f', 'extra'), /not exactly/, 'a refill plus ONE extra catalog read is refused');
  assert.throws(() => F.strip([{ db: 'fs', op: 'runTransaction' }, ...TAIL], 'x_pizza', 'g', 'bare tx'), /not exactly/, 'a bare leading transaction is refused');
  assert.throws(() => F.strip([...fs(S.GATE), ...fs(S.GATE), ...TAIL], 'x_pizza', 'h', 'gate twice'), /not exactly/, 'the same refill twice in one leading block is refused (one per cache per request)');
  const tx = { db: 'fs', op: 'runTransaction' };
  assert.deepStrictEqual(F.strip([...TAIL, tx], 'x_pizza', 'i', 'mid tx'), [...TAIL, tx], 'a mid-request transaction stays IN the comparison');
  const w = { db: 'fs', op: 'set', path: 'restaurants/x_pizza/meta/active_version' };
  assert.deepStrictEqual(F.strip([...TAIL, w], 'x_pizza', 'j', 'write'), [...TAIL, w], 'a write on a catalog path stays IN');
  assert.deepStrictEqual(F.strip([...fs(S.GATE), ...TAIL, ...fs(S.GATE)], 'x_pizza', 'k', 'second gate'), [...TAIL, ...fs(S.GATE)], 'a SECOND gate read in one request stays IN');
  const other = fs(RD.refillShapes('la_musa').GATE);
  assert.deepStrictEqual(F.strip([TAIL[0], ...other, TAIL[1]], 'x_pizza', 'l', 'other rid'), [TAIL[0], ...other, TAIL[1]], 'another restaurant\'s refill stays IN');
  const glued = [TAIL[0], ...fs(S.GATE), { db: 'fs', op: 'get', path: 'restaurants/x_pizza/versions/<v>/extras' }, TAIL[1]];
  assert.deepStrictEqual(F.strip(glued, 'x_pizza', 'm', 'glued'), glued, 'a gate-shaped read glued to another Firestore call is NOT a refill (stays IN)');
  assert.throws(() => F.strip([FLOOR, FLOOR, ...TAIL], 'x_pizza', 'n', 'floor twice'), /client-floor/, 'two floor reads are refused');
  assert.throws(() => F.strip([r('platform_config/client_floor/orders', 'set'), ...TAIL], 'x_pizza', 'o', 'floor write'), /client-floor/, 'a floor write is refused');
  ok('refused: codex\'s injection, a refill + one extra read, a bare transaction, a refill twice, two floor reads, a floor write; kept IN: a mid transaction, a catalog write, a second gate read, another restaurant\'s refill, a glued read');
}

// ── the wall-time bound counts refills per cache ─────────────────────────────────────────────────────────────────────
{
  const F = RD.makeCacheFill(['x_pizza']);
  F.strip([...fs(S.COLD), ...TAIL], 'x_pizza', 'c1', 'cold 1');
  F.strip([...fs(S.GATE), ...TAIL], 'x_pizza', 'g1', 'gate 1');
  assert.deepStrictEqual(F.assertBounded('x').seen.x_pizza, { GATE: 1, CTX: 0, COLD: 1, FLOOR: 0 }, 'counted per cache');
  F.strip([...fs(S.COLD), ...TAIL], 'x_pizza', 'c2', 'cold 2');
  assert.throws(() => F.assertBounded('x'), /COLD load — it happens once per process/, '🔴 a second COLD load fails');
  const G = RD.makeCacheFill(['x_pizza']);
  for (let i = 0; i < 3; i += 1) G.strip([TAIL[0], ...fs(S.GATE), TAIL[1]], 'x_pizza', `g${i}`, 'gate');
  assert.throws(() => G.assertBounded('x'), /a per-request read, not a TTL/, '🔴 a gate read on every request exceeds the wall-time budget');
  const H = RD.makeCacheFill(['x_pizza']);
  const same = [TAIL[0], ...fs(S.GATE), TAIL[1]];
  H.strip(same, 'x_pizza', 'one', 'a'); H.strip(same, 'x_pizza', 'one', 'b');
  assert.strictEqual(H.assertBounded('x').seen.x_pizza.GATE, 1, 'one recorded request compared twice counts once');
  ok('the bound: COLD at most once per restaurant, GATE / CTX / FLOOR within ⌊elapsed / 30 s⌋ + 1, a request compared twice counted once');
}

console.log(`\n_render-delta: OK (${n})`);
