'use strict';
// DRIVER F — index.js wiring guard (index.js is not require-safe, so the trigger's wiring is pinned by source text): the
// trigger listens on the report path, retries, calls the core, and does NOT catch the core's errors (retry:true must see them).
// Run: node drvf-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = require('./tools/drvc-inverse').unapplyDrvcIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'));   // DRIVER C (newer) reversed first
const a = src.indexOf('/* drvf:begin */'); const b = src.indexOf('/* drvf:end */');
assert.ok(a > 0 && b > a, 'DRVF-WIRE-BLOCK the drvf block exists exactly once');
assert.strictEqual(src.indexOf('/* drvf:begin */', a + 1), -1, 'DRVF-WIRE-ONCE');
const block = src.slice(a, b);
assert.match(block, /exports\.alertOnDriverProblem = onValueCreated\(/, 'DRVF-WIRE-EXPORT');
assert.match(block, /ref: '\/driver_problems\/\{oid\}\/\{pid\}'/, 'DRVF-WIRE-PATH');
assert.match(block, /retry: true/, 'DRVF-WIRE-RETRY retry:true');
assert.match(block, /await driverProblemAlertCore\(getDatabase\(\), \{ oid: event\.params\.oid, pid: event\.params\.pid, rec: event\.data\.val\(\), now: Date\.now\(\) \}, \{ resolveDriverName \}\)/, 'DRVF-WIRE-CALL the core is awaited with the event params and the shared name cascade');
assert.doesNotMatch(block, /\bcatch\b|\btry\b/, 'DRVF-WIRE-NOCATCH the wrapper must not swallow the core\'s errors');
assert.doesNotMatch(src.slice(0, a) + src.slice(b), /driver_problems/, 'DRVF-WIRE-SOLE no index.js code outside the drvf block touches driver_problems');
console.log('  ✓ drvf wiring: path, retry:true, awaited core, no catch, sole reference');

// the slice's index.js footprint is ONLY that block: the inverse returns the base (the parent of the commit that introduced the
// block, or HEAD while it is uncommitted) byte-for-byte, and it is the LAST thing in index.js
const { execFileSync } = require('child_process');
const { unapplyDrvfIndex, BEGIN, END } = require('./tools/drvf-inverse');
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const introducing = git(['log', '--format=%H', '-S', BEGIN, '--', 'index.js']).trim().split('\n').filter(Boolean).pop();
const base = introducing ? git(['show', `${introducing}^:xpizza-functions/index.js`]) : git(['show', 'HEAD:xpizza-functions/index.js']);
assert.strictEqual(unapplyDrvfIndex(src), base, 'DRVF-INV-BASE index.js minus the drvf block is not the base index.js — something outside the block changed');
assert.notStrictEqual(unapplyDrvfIndex(src), src, 'DRVF-INV-NONVACUOUS');
assert.ok(src.trimEnd().endsWith(END), 'DRVF-INV-LAST the drvf block is the LAST thing in index.js');
const blk = src.slice(src.indexOf(BEGIN), src.indexOf(END) + END.length);
assert.throws(() => unapplyDrvfIndex(src.replace(BEGIN, '/* drvf:begn */')), /not found exactly once/, 'DRVF-INV-BEGIN');
assert.throws(() => unapplyDrvfIndex(src.replace(END, '/* drvf:ed */')), /not found exactly once/, 'DRVF-INV-END');
assert.throws(() => unapplyDrvfIndex(src + `\n${blk}\n`), /exactly once/, 'DRVF-INV-DUP');
const outside = src.replace('exports.getSalesStats = portalFunctions.getSalesStats;', 'exports.getSalesStats = portalFunctions.getSalesStats; ');
assert.notStrictEqual(outside, src, 'premise: the outside probe edits something');
assert.notStrictEqual(unapplyDrvfIndex(outside), base, 'DRVF-INV-OUTSIDE a byte OUTSIDE the block survives the inverse and fails the base pin');
console.log(`  ✓ drvf inverse: index.js minus the block === base (${introducing ? `${introducing.slice(0, 8)}^` : 'HEAD'}) byte-for-byte; the block is last; missing / duplicate / outside each caught`);
