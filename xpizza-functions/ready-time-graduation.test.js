'use strict';
const assert = require('assert');
const { mean, quantile, bhFdrAdjust, bootstrapLowerP } = require('./ready-time-graduation');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

const LUNCH = Date.UTC(2026,6,14,18,0);   // used by Task 2 coverage/gate tests

assert.strictEqual(mean([2,4,6]), 4); ok('mean');
assert.strictEqual(quantile([1,2,3,4], 50), 2); ok('quantile nearest-rank');

// BH-FDR: known example. pvals [0.01,0.02,0.03,0.04,0.05] at any q → monotone adjusted, order preserved.
{
  const adj = bhFdrAdjust([0.04, 0.01, 0.03]);   // unsorted input
  assert.strictEqual(adj.length, 3);
  assert.ok(adj[1] <= adj[2] && adj[2] <= adj[0], 'monotone by original p-order');
  assert.ok(Math.abs(adj[1] - 0.03) < 1e-9, 'smallest p*n/rank');   // 0.01*3/1
  ok('bhFdrAdjust');
}

// seeded RNG → deterministic. A clearly-positive delta (all ≈ +5, threshold 1) → tiny pValue.
{
  const rng = mulberry32(42);
  const deltas = Array.from({length: 60}, () => 5 + (rng()-0.5)); // ~+5 ± .5
  const { pValue, lowerCB } = bootstrapLowerP(deltas, 1, { rng: mulberry32(7), resamples: 400 });
  assert.ok(pValue < 0.01, `expected tiny p, got ${pValue}`);
  assert.ok(lowerCB > 1, `lowerCB above threshold, got ${lowerCB}`);
  ok('bootstrapLowerP: strong improvement passes');
}
// A null delta (≈ 0, threshold 1) → large pValue (won't reject).
{
  const rng = mulberry32(9);
  const deltas = Array.from({length: 60}, () => (rng()-0.5));  // ~0
  const { pValue } = bootstrapLowerP(deltas, 1, { rng: mulberry32(7), resamples: 400 });
  assert.ok(pValue > 0.2, `expected large p, got ${pValue}`);
  ok('bootstrapLowerP: no improvement fails');
}

// tiny deterministic PRNG for tests
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

console.log(`\n${pass} passed`);
