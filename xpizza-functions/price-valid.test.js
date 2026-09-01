'use strict';
// Phase 1d Stage 1a EXTENSION — the shared price-validity rule. Run: node price-valid.test.js
const assert = require('assert');
const { isValidPrice } = require('./price-valid');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

for (const good of [1, 39, 299, 685, 99999, Number.MAX_SAFE_INTEGER]) {
  assert.strictEqual(isValidPrice(good), true, `${good} must be valid`);
}
ok('accepts positive integers (1 … MAX_SAFE_INTEGER)');
const BAD = [['zero', 0], ['negative', -1], ['negative float', -0.5], ['NaN', NaN], ['float', 12.5],
  ['undefined', undefined], ['null', null], ['numeric string', '299'], ['empty string', ''],
  ['Infinity', Infinity], ['-Infinity', -Infinity], ['object', {}], ['array', [299]], ['boolean', true],
  ['negative zero', -0], ['bigint-ish', 299n]];
for (const [label, bad] of BAD) assert.strictEqual(isValidPrice(bad), false, `${label} must be rejected`);
ok(`rejects all ${BAD.length} corrupt shapes (0, negative, NaN, float, undefined, null, string, Infinity, object, array, boolean, -0, bigint)`);
// -0 deserves a word: it is an integer and not > 0, so it rejects — a "free" item is not a price.
assert.strictEqual(isValidPrice(-0), false, '-0 is not a usable price');
assert.strictEqual(Number.isInteger(-0), true, '(and it IS an integer — the > 0 half is what rejects it)');
ok('-0 rejects on the > 0 half, not the integer half');
// The helper is a dependency-free leaf: factura/pricing.js must stay standalone.
const srcOf = (f) => require('fs').readFileSync(require('path').join(__dirname, f), 'utf8');
assert.ok(!/require\(/.test(srcOf('price-valid.js')), 'price-valid.js must require NOTHING (leaf module, no circular-require risk)');
assert.ok(!/require\('\.\.\/menu-pricing'\)/.test(srcOf('factura/pricing.js')), 'factura/pricing.js must NOT depend on menu-pricing');
ok('leaf module: price-valid requires nothing; factura/pricing stays standalone');
console.log(`price-valid: OK (${n})`);
