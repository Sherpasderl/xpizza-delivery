'use strict';
// WhatsApp cancellation shows the kitchen's display_number, never the long order id (owner 2026-10-12) — wiring guard.
//   1. PROOF: tools/wacancel-inverse.js turns index.js back into the base (537bbbc) BYTE-FOR-BYTE — the inverse every fold guard
//      applies FIRST; an edit inside the block, a second block, a missing delimiter and a byte outside are each detected.
//   2. The cancelled notification passes the ORDER's display_number (the record the trigger already holds), and nothing else
//      that could become the visible number: the long orderId is no longer handed to the template.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const stripComments = require('./tools/strip-comments');
const { unapplyWaCancelIndex } = require('./tools/wacancel-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '537bbbc';
// the per-product extras blocks (the newer index.js slice, tools/extras-inverse.js) are reversed first, as in every fold guard
const real = require('./tools/extras-inverse').unapplyExtrasIndex(require('./tools/serial3-inverse').unapplySerial3Index(require('./tools/h0-inverse').unapplyH0Index(require('./tools/s1a-inverse').unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))))))))));
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.notStrictEqual(unapplyWaCancelIndex(real), real, 'non-vacuity: the wacancel block is present and swapped back');
assert.strictEqual(unapplyWaCancelIndex(real), baseIdx, `🔴 index.js minus the wacancel block is not ${BASE}:index.js`);
assert.throws(() => unapplyWaCancelIndex(real.replace('displayNumber: order.display_number,', 'displayNumber: order.order_id,')), /pinned bytes/, 'an edit INSIDE the block');
assert.throws(() => unapplyWaCancelIndex(real.replace('exports.verifyOtp', '/* wacancel:begin */\n/* wacancel:end */\nexports.verifyOtp')), /exactly one/, 'a second block');
assert.throws(() => unapplyWaCancelIndex(real.replace('/* wacancel:end */', '')), /exactly one/, 'a missing delimiter');
assert.notStrictEqual(unapplyWaCancelIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), baseIdx, 'a byte OUTSIDE the block survives (the base pin catches it)');
ok(`unapplyWaCancelIndex → ${BASE}:index.js byte-for-byte; an edit inside, a second block, a missing delimiter and a byte outside are each caught`);

const code = stripComments(real);
const call = code.match(/whatsapp\.tplCancelled\(\{([\s\S]*?)\}\)/g) || [];
assert.strictEqual(call.length, 1, 'premise: one tplCancelled call');
assert.ok(/displayNumber:\s*order\.display_number/.test(call[0]), 'the cancelled notification passes the ORDER’s display_number');
assert.ok(!/\borderId\b/.test(call[0]), '🔴 the long orderId is not handed to the cancellation template');
ok('the cancelled notification passes order.display_number and never the long orderId');

console.log(`\nwacancel-wiring.guard: OK (${n})`);
