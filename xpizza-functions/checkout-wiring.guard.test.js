'use strict';
// PLAN-guest-checkout-server S1 — index.js wiring guard (the inverse-fold invariant). The slice appends ONE block to index.js
// (`/* checkout:begin endpoints */ … /* checkout:end endpoints */`: the requestCheckoutCode / verifyCheckoutCode exports) and
// nothing else, so it ships tools/checkout-inverse.js and is composed INNERMOST (newest slice first) into every index.js fold
// guard. This guard proves:
//   (i)   unapplyCheckoutIndex(index.js) === BASE:index.js BYTE-FOR-BYTE;
//   (ii)  NON-VACUITY — the live file differs from the base and carries the block (dropping the inverse ⇒ RED);
//   (iii) SENSITIVITY — a missing / duplicated marker or an edit OUTSIDE the block is refused or detected.
// Run: node checkout-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyCheckoutIndex } = require('./tools/checkout-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '8a31e2a3';   // origin/main at the plan's code map
const live = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const BEGIN = '/* checkout:begin endpoints */\n', END = '/* checkout:end endpoints */\n';

assert.strictEqual(unapplyCheckoutIndex(live), base, `🔴 index.js minus the checkout block is not ${BASE}:index.js — something beyond the block changed`);
ok(`(i) index.js minus the checkout block === ${BASE}:index.js byte-for-byte`);

assert.notStrictEqual(live, base, 'non-vacuity: the live index.js differs from the base');
const block = live.slice(live.indexOf(BEGIN), live.indexOf(END) + END.length);
assert.ok(/exports\.requestCheckoutCode = onRequest\(/.test(block) && /exports\.verifyCheckoutCode = onRequest\(/.test(block), 'both endpoints are exported INSIDE the block');
assert.ok(/cors: ACCOUNT_ORIGINS/.test(block), 'the account CORS list (the capp origin is derived from the manifest)');
assert.ok(live.endsWith(END), 'the block is the END of index.js (no existing line moves — no R3 call site shifts)');
assert.ok(!/exports\.(requestOtp|verifyOtp)\b/.test(block), 'requestOtp / verifyOtp are never touched by this slice');
ok('(ii) non-vacuity: the block is present at the end of index.js, exports both endpoints with ACCOUNT_ORIGINS, and touches no existing export');

assert.throws(() => unapplyCheckoutIndex(live.replace(BEGIN, '/* checkout:BEGIN */\n')), /missing or malformed/, 'a missing begin');
assert.throws(() => unapplyCheckoutIndex(live.replace(END, '/* checkout:END */\n')), /missing or malformed/, 'a missing end');
assert.throws(() => unapplyCheckoutIndex(live + BEGIN + END), /more than once/, 'a duplicated block');
assert.notStrictEqual(unapplyCheckoutIndex(live.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'an edit OUTSIDE the block is detected');
ok('(iii) sensitivity: missing / duplicated markers refused; an edit outside the block is detected');

console.log(`\ncheckout-wiring.guard: OK (${n})`);
