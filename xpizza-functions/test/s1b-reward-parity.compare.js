'use strict';
// S1b (advisor ruling Q3) — the base's and the tip's reward-refusal captures must be identical (status + body + nothing written).
// Run: node test/s1b-reward-parity.compare.js <base.json> <tip.json>
const assert = require('assert');
const [base, tip] = process.argv.slice(2).map((f) => JSON.parse(require('fs').readFileSync(f, 'utf8')));
assert.ok(base && tip && Object.keys(base).length === 8, 'premise: eight captured responses');
assert.deepStrictEqual(Object.keys(tip).sort(), Object.keys(base).sort(), 'the same cases');
for (const k of Object.keys(base)) {
  assert.ok(base[k].status === 409 || base[k].status === 400, `premise: the base REFUSES ${k} (${base[k].status} ${base[k].body.slice(0, 120)})`);
  assert.deepStrictEqual(tip[k], base[k], `🔴 RWP ${k}: the tip answers the reward refusal differently from the base`);
}
console.log(`s1b-reward-parity: OK (${Object.keys(base).length} responses byte-identical, base vs tip)`);
