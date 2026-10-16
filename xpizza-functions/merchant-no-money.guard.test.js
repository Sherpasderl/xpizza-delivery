'use strict';
// H1a (PLAN-H1a r2 Global Constraints, codex r1 #5) — the handheld NEVER enters a cancellation or money path: no file under
// merchant/ may require a cancellation, payment, refund or rewards module, or name the void/refund primitive. A reject is a
// request to dispatch (merchant-reject.js). Run: node merchant-no-money.guard.test.js
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
console.log(`merchant-no-money.guard: OK (${n} modules clean)`);
