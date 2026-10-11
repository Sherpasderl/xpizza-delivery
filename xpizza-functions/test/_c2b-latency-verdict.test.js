'use strict';
// 1D D4-c2b — the latency verdict's CHILD VALIDITY (codex build r1 P1-3): an ON child is valid only if every sample overlapped REAL
// monitor reads on the prescribed restaurants, the monitor completed checks and read, and no monitor run failed. A planted no-work
// ON child — reads 0, checked 0, only a run interval overlapping — must be REJECTED, and its row can never PASS.
// Run: node test/_c2b-latency-verdict.test.js
const assert = require('assert');
const { childValid, verdictRow, checksFrom, qualifySample } = require('./_c2b-latency-verdict');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const S = 50;
const ms = (base) => Array.from({ length: S }, (_, i) => base + (i % 5));
const child = (over = {}, mon = {}) => ({ digest: { start_ok: true, mismatches: 0, checked: 6 }, errors: 0, ms: ms(100), attempts: S,
  monitor: { runs: 12, reads: 4000, checked: 30, errors: 0, overlapped: S, qualified: S, ...mon }, ...over });
const off = (over = {}) => child(over, { runs: 0, reads: 0, checked: 0, overlapped: 0, qualified: 0 });

// a valid ON child, a valid OFF child
assert.strictEqual(childValid(child(), 'on', S), true, 'a working ON child is valid');
assert.strictEqual(childValid(off(), 'off', S), true, 'an OFF child with no monitor is valid');
// the PLANTED NO-WORK ON child (codex's reproduction): reads 0, checked 0, the run interval overlapping every sample
const noWork = child({}, { reads: 0, checked: 0, qualified: 0, overlapped: S });
assert.strictEqual(childValid(noWork, 'on', S), false, 'the planted no-work ON child is REJECTED');
// each condition alone
for (const [label, mon] of [['reads 0', { reads: 0 }], ['checked 0', { checked: 0 }], ['a failed monitor run', { errors: 1 }],
  ['one sample without qualifying reads', { qualified: S - 1 }], ['only run-interval overlap', { qualified: 0 }], ['no run', { runs: 0 }]]) {
  assert.strictEqual(childValid(child({}, mon), 'on', S), false, `ON child with ${label} → invalid`);
}
assert.strictEqual(childValid(off({}, {}), 'off', S) && !childValid(child(), 'off', S), true, 'an OFF child in which the monitor ran → invalid');
ok('child validity: a working ON child valid; the planted NO-WORK ON child (reads 0, checked 0, interval-only overlap) REJECTED; reads 0, checked 0, a failed run, one unqualified sample, interval-only overlap, no run — each alone REJECTED; an OFF child with a monitor run REJECTED');

// the row: one no-work ON child anywhere → the row is not valid → never PASS
const block = (k, on) => ({ k, first: 'A', off: off(), on, });
const aa = (k) => ({ k, first: 'A', off1: off(), off2: off() });
const R = (onOf) => ({ ab: Array.from({ length: 6 }, (_, k) => block(k, onOf(k))), aa: Array.from({ length: 6 }, (_, k) => aa(k)) });
const good = verdictRow({ key: 'x', overlap: 'same' }, R(() => child()), S);
assert.strictEqual(good.valid, true);
const bad = verdictRow({ key: 'x', overlap: 'same' }, R((k) => (k === 3 ? noWork : child())), S);
assert.strictEqual(bad.valid, false, 'one no-work ON child → the row is invalid');
assert.notStrictEqual(bad.verdict, 'PASS', `an invalid row never PASSes (got ${bad.verdict})`);
ok(`the row: identical timings, but ONE no-work ON child in block 3 → valid false → verdict ${bad.verdict} (a working row: valid, verdict ${good.verdict})`);

// ── codex build r2 P1-B: qualification from ACTUAL check boundaries — never merged; only a completed 'checked' check counts ──
{
  const ev = (list) => checksFrom(list.map(([t, kind, rid, outcome]) => ({ t, kind, rid, outcome })));
  const same = { overlap: 'same', rid: 'x', targets: ['x'], others: ['o1', 'o2'] };
  const other = { overlap: 'other', rid: 'x', targets: ['o1', 'o2'], others: ['o1', 'o2'] };
  // codex's reproduction: reads [0,10], [11,20], [1000,1010] used to merge into [0,1010]; as CHECKS they stay separate
  const three = ev([[0, 'open', 'x'], [10, 'close', 'x', 'checked'], [11, 'open', 'x'], [20, 'close', 'x', 'checked'], [1000, 'open', 'x'], [1010, 'close', 'x', 'checked']]);
  assert.deepStrictEqual(three.map((c) => [c.a, c.b]), [[0, 10], [11, 20], [1000, 1010]], 'three checks, never merged');
  assert.strictEqual(qualifySample([400, 410], three, same), false, 'a sample in the IDLE GAP between checks is REJECTED');
  assert.strictEqual(qualifySample([5, 6], three, same), true, 'a sample inside a completed check qualifies');
  // a DEFERRAL-ONLY run: the precheck saw the merchant active → never qualifies, however it overlaps
  const deferred = ev([[0, 'open', 'x'], [50, 'close', 'x', 'deferred_merchant_active']]);
  assert.strictEqual(qualifySample([10, 20], deferred, same), false, 'a deferral-only run is REJECTED');
  // failed / budget-deferred / still-open checks never qualify either
  for (const o of ['failed', 'deferred_budget', 'unavailable']) assert.strictEqual(qualifySample([10, 20], ev([[0, 'open', 'x'], [50, 'close', 'x', o]]), same), false, `outcome ${o} does not qualify`);
  assert.strictEqual(qualifySample([10, 20], ev([[0, 'open', 'x']]), same), false, 'a check that never closed does not qualify');
  // the prescribed set: 'same' needs THIS restaurant only; 'other' needs the others and never this one
  const mixed = ev([[0, 'open', 'o1'], [30, 'close', 'o1', 'checked'], [31, 'open', 'x'], [60, 'close', 'x', 'checked']]);
  assert.deepStrictEqual([qualifySample([5, 10], mixed, same), qualifySample([5, 10], mixed, other), qualifySample([40, 45], mixed, other), qualifySample([25, 35], mixed, same)],
    [false, true, false, false], 'same/other honoured; a sample spanning another restaurant\'s check does not qualify a same row');
  assert.strictEqual(qualifySample([25, 35], mixed, other), false, 'a sample spanning THIS restaurant\'s check does not qualify an other row');
  // a close for a restaurant with no open check is ignored (never fabricates an interval)
  assert.deepStrictEqual(ev([[5, 'close', 'x', 'checked']]), []);
}
ok('qualification from ACTUAL check boundaries (codex build r2 P1-B): checks are never merged (codex\'s [0,10][11,20][1000,1010] stay three); a sample in the idle gap is REJECTED; a deferral-only run, a failed, budget-deferred, unavailable or unclosed check never qualifies; the same/other prescription is honoured');

console.log(`c2b-latency-verdict: OK (${n})`);
