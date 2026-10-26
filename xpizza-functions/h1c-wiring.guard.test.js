'use strict';
// H1c-server (PLAN-H1c) — the slice's index.js footprint is ONE delimited block at the END of index.js, nothing else.
// Run: node h1c-wiring.guard.test.js
//   1. unapplyH1cIndex(index.js) === H1a's approved index.js byte-for-byte (the parent of the commit that introduced the block, found
//      with git log -S, or HEAD's index.js while the block is still uncommitted); H1a's own inverse then still reaches its base.
//   2. Sensitivity: a missing delimiter, a second block and a byte outside are each caught.
//   3. The block holds only comments, ONE require of merchant-push-wiring, and re-exports of exactly its names.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyH1cIndex, BEGIN, END } = require('./tools/h1c-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))));   // the signup slice (newer) is reversed FIRST
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const introducing = git(['log', '--format=%H', '-S', BEGIN, '--', 'index.js']).trim().split('\n').filter(Boolean).pop();
const base = introducing ? git(['show', `${introducing}^:xpizza-functions/index.js`]) : git(['show', 'HEAD:xpizza-functions/index.js']);

assert.strictEqual(unapplyH1cIndex(real), base, '🔴 index.js minus the h1c block is not H1a\'s index.js — something outside the block changed');
assert.notStrictEqual(unapplyH1cIndex(real), real, 'non-vacuity: the block is present');
assert.ok(real.trimEnd().endsWith(END), 'the h1c block is the LAST thing in index.js');
ok(`unapplyH1cIndex(index.js) === H1a's index.js byte-for-byte (base ${introducing ? `${introducing.slice(0, 8)}^` : 'HEAD'}); the block is last`);

const block = real.slice(real.indexOf(BEGIN), real.indexOf(END) + END.length);
assert.throws(() => unapplyH1cIndex(real.replace(BEGIN, '/* h1c:begn */')), /not found exactly once/);
assert.throws(() => unapplyH1cIndex(real.replace(END, '/* h1c:ed */')), /not found exactly once/);
assert.throws(() => unapplyH1cIndex(real + `\n${block}\n`), /exactly once/);
const outside = real.replace('exports.getSalesStats = portalFunctions.getSalesStats;', 'exports.getSalesStats = portalFunctions.getSalesStats; ');
assert.notStrictEqual(unapplyH1cIndex(outside), base, 'a byte OUTSIDE the block survives the inverse and fails the base pin');
ok('sensitivity: missing begin, missing end, a second block and a byte outside are each caught');

const lines = block.split('\n').slice(1, -1).filter((l) => !l.startsWith('//'));
assert.strictEqual(lines[0], "const merchantPushFunctions = require('./merchant/merchant-push-wiring');");
const names = Object.keys(require('./merchant/merchant-push-wiring')).sort();
const exported = lines.slice(1).map((l) => { const m = l.match(/^exports\.(\w+) = merchantPushFunctions\.(\w+);$/); assert.ok(m && m[1] === m[2], `a plain re-export: ${l}`); return m[1]; }).sort();
assert.deepStrictEqual(exported, names);
assert.deepStrictEqual(names, ['merchantPendingOrders', 'merchantPushOnAnswered', 'merchantPushOnStatus', 'merchantRegisterPush', 'merchantUnregisterPush']);
ok(`the block only re-exports merchant-push-wiring by name: ${names.join(', ')}`);
console.log(`h1c-wiring.guard: OK (${n})`);
