'use strict';
// R3 P1 §4a — THE COMPARATOR GUARD (static; npm test chain). The typed money comparison is cent-exact, currency-checked, never
// reads a missing amount as zero, never normalizes a precision the contract forbids, and footing is checked even when the
// total matches. Run: node contract/comparator.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { money, compareMoney, parseMoney, footing, change } = require('./oracle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-COMPARATOR ${m}`;
const L = (x) => money(Math.round(x * 100));

assert.ok(compareMoney(L(223), 'L 223.00').ok && compareMoney(L(1234.5), 'L 1,234.50').ok && compareMoney(L(223), 'L223.00').ok, FAIL('a correct amount was rejected'));
ok('a correct amount passes in each printed form (L 223.00, L223.00, L 1,234.50)');
assert.ok(!compareMoney(L(223), 'L 223.01').ok, FAIL('one centavo off passed'));
ok('one centavo off → RED (cent-exact)');
assert.ok(!compareMoney(L(223), 'USD 223.00').ok && !compareMoney(L(223), '$223.00').ok, FAIL('a wrong currency passed'));
ok('a wrong currency → RED (does not parse as HNL)');
assert.ok(!compareMoney(L(223), '').ok && !compareMoney(L(223), null).ok && !compareMoney(L(223), 'L —').ok, FAIL('a missing amount passed'));
assert.ok(!compareMoney(L(0), '').ok && compareMoney(null, '').ok && !compareMoney(null, 'L 0.00').ok, FAIL('missing and zero were conflated'));
ok('a missing amount → RED; "no amount" and L 0.00 are distinct in both directions');
assert.ok(!compareMoney(L(223), 'L 223').ok, FAIL('a whole-lempira rendering passed where centavos are required'));
assert.ok(!compareMoney(L(223), 'L 223', { precision: 'lempiras' }).ok, FAIL('lempira precision used without §1 permission'));
assert.ok(compareMoney(L(223), 'L 223', { precision: 'lempiras', permitsLempiras: true }).ok && !compareMoney(L(223.5), 'L 224', { precision: 'lempiras', permitsLempiras: true }).ok, FAIL('permitted lempira precision misbehaved'));
ok('precision: centavos required unless §1 permits whole lempiras; a rounded-away centavo is a divergence, never normalized');
const f = footing({ subtotal: L(200), tax: L(30), discount: L(7), total: L(223) });
const bad = footing({ subtotal: L(210), tax: L(30), discount: L(7), total: L(223) });
assert.ok(f.ok && !bad.ok && compareMoney(L(223), 'L 223.00').ok, FAIL('footing'));
ok('footing: subtotal + tax − discount = total; a wrong footing is RED even though the displayed total matches');
assert.ok(change(L(500), L(223)).centavos === 27700 && change(null, L(223)) === null, FAIL('change'));
ok('change = tender − total (§1); no tender → no change (null, not 0)');
assert.throws(() => money(223.5), /integer centavos/, FAIL('a float amount was accepted'));
assert.ok(!parseMoney('L 22.3', 'cents').ok, FAIL('a malformed amount parsed'));
ok('money is integer centavos only; malformed text never parses');
// independence: the oracle imports no reader helper
const src = fs.readFileSync(path.join(__dirname, 'oracle.js'), 'utf8');
assert.ok(!/require\((['"])\.\.\/\.\.\/xpizza-|require\((['"])\.\.\/[a-z-]+-helpers/.test(src) && !/xpizza-(driver|dispatch|kitchen|orders|dashboard|track)/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), FAIL('the oracle references a reader surface'));
ok('independence: oracle.js imports no reader / page helper (its evidence is intent, the writer response and persisted records)');
console.log(`\nr3-comparator guard: OK (${n})`);
