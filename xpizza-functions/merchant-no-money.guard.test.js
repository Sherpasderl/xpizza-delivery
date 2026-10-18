'use strict';
// H1a (PLAN-H1a r2 Global Constraints, codex r1 #5; amendment A-R1) — no file under merchant/ may require a cancellation,
// payment, refund or rewards module, or name the void/refund primitive. A-R1's reject cancels through the EXISTING core, which
// arrives INJECTED: index.js's h1 block binds cancelOrderCore(cancelDeps(...)) and passes it as `cancelCore`; the ONE call
// site is merchant-reject.js. Run: node merchant-no-money.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'merchant');
const BANNED_REQUIRE = /require\(\s*['"][^'"]*(cancel-order|cancel-order-core|pixelpay|rewards-|refund|money-recovery|manual-resolve)[^'"]*['"]\s*\)/;
const BANNED_NAME = /\b(voidOrRefund|cancelOrderCore|cancelPaidOrder|refundPayment)\b/;
let n = 0;
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
assert.ok(files.length >= 8, 'non-vacuity: the merchant modules are present');
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  assert.ok(!BANNED_REQUIRE.test(src), `🔴 merchant/${f} requires a money/cancellation module`);
  assert.ok(!BANNED_NAME.test(src.replace(/\/\/.*$/gm, '')), `🔴 merchant/${f} names a money/cancellation primitive`);
  n++;
}
assert.ok(BANNED_REQUIRE.test("require('../cancel-order-core')") && BANNED_NAME.test('await voidOrRefund(x)'), 'sensitivity: the patterns catch the real names');

// A-R1: exactly ONE call of the injected core, in merchant-reject.js; merchant-wiring only passes it through.
const code = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\/.*$/gm, '');
const CALL = /\bcancelCore\s*\(/g;
const callSites = files.flatMap((f) => (code(f).match(CALL) || []).map(() => f));
assert.deepStrictEqual(callSites, ['merchant-reject.js'], `🔴 the injected cancel core must be called exactly once, in merchant-reject.js (found: ${callSites.join(', ') || 'none'})`);
for (const f of files) if (f !== 'merchant-reject.js' && f !== 'merchant-wiring.js') assert.ok(!/\bcancelCore\b/.test(code(f)), `🔴 merchant/${f} touches cancelCore`);
assert.strictEqual(('x cancelCore(a) cancelCore (b)'.match(CALL) || []).length, 2, 'sensitivity: the call pattern counts calls');
// The binding lives ONLY in index.js's h1 block.
const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const block = idx.slice(idx.indexOf('/* h1:begin */'), idx.indexOf('/* h1:end */'));
assert.strictEqual((block.match(/cancelCore: \(args\) => cancelOrderCore\(cancelDeps\(getDatabase\(\)\), args\)/g) || []).length, 1, 'the h1 block binds the existing core exactly once');
assert.strictEqual((idx.match(/cancelCore:/g) || []).length, 1, 'no other cancelCore binding in index.js');
console.log('merchant-no-money.guard: injected core called once (merchant-reject.js), bound once (h1 block)');
console.log(`merchant-no-money.guard: OK (${n} modules clean)`);
