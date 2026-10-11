'use strict';
// 1D D4-c2b — the latency verdict's CHILD VALIDITY (codex build r1 P1-3): an ON child is valid only if every sample overlapped REAL
// monitor reads on the prescribed restaurants, the monitor completed checks and read, and no monitor run failed. A planted no-work
// ON child — reads 0, checked 0, only a run interval overlapping — must be REJECTED, and its row can never PASS.
// Run: node test/_c2b-latency-verdict.test.js
const assert = require('assert');
const { childValid, verdictRow } = require('./_c2b-latency-verdict');

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

console.log(`c2b-latency-verdict: OK (${n})`);
