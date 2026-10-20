'use strict';
// H1a (PLAN-H1a r2 T8 + A-R1) — the handheld's index.js footprint is ONE delimited block plus A-R1's seven one-line hunks (incl. codex r1 P1-2's holdAfterClaim),
// nothing else. Run: node h1-wiring.guard.test.js
//   1. unapplyH1Index(index.js) === the pre-H1a index.js. The base is the parent of the commit that introduced the block
//      (found with git log -S), or HEAD's index.js while the block is still uncommitted.
//   2. Sensitivity: a byte inside the block, a missing delimiter, a second block and a byte outside are each caught.
//   3. The block only re-exports merchant-wiring by name (static guards read these names) — no logic in index.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyH1Index, BEGIN, END, INDEX_HUNKS } = require('./tools/h1-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// H1c-server (newer) is reversed first: this guard checks H1a's own layer
const real = require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/membership-inverse').unapplyMembershipIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))));
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// The commit that introduced the block (oldest commit whose index.js contains BEGIN); its parent's index.js is the base.
const introducing = git(['log', '--format=%H', '-S', BEGIN, '--', 'index.js']).trim().split('\n').filter(Boolean).pop();
const base = introducing ? git(['show', `${introducing}^:xpizza-functions/index.js`]) : git(['show', 'HEAD:xpizza-functions/index.js']);

assert.strictEqual(unapplyH1Index(real), base, '🔴 index.js minus the h1 block is not the pre-H1a index.js — something outside the block changed');
assert.notStrictEqual(unapplyH1Index(real), real, 'non-vacuity: the block is present');
ok(`unapplyH1Index(index.js) === pre-H1a index.js byte-for-byte (base ${introducing ? `${introducing.slice(0, 8)}^` : 'HEAD'})`);

const block = real.slice(real.indexOf(BEGIN), real.indexOf(END) + END.length);
assert.throws(() => unapplyH1Index(real.replace(BEGIN, '/* h1:begn */')), /not found exactly once/, 'a missing begin delimiter is caught');
assert.throws(() => unapplyH1Index(real.replace(END, '/* h1:ed */')), /not found exactly once/, 'a missing end delimiter is caught');
assert.throws(() => unapplyH1Index(real + `\n${block}\n`), /exactly once/, 'a second block is caught');
const inside = real.replace('exports.merchantAccept = merchantFunctions.merchantAccept;', 'exports.merchantAccept = merchantFunctions.merchantAcept;');
assert.notStrictEqual(inside, real);
assert.strictEqual(unapplyH1Index(inside), base, 'an edit INSIDE the block is removed with it (the block is checked by item 3)');
const outside = real.replace('exports.getSalesStats = portalFunctions.getSalesStats;', 'exports.getSalesStats = portalFunctions.getSalesStats; ');
assert.notStrictEqual(unapplyH1Index(outside), base, 'a byte OUTSIDE the block survives the inverse and fails the base pin');
ok('sensitivity: missing begin, missing end, a second block and a byte outside are each caught');

// A-R1 hunks: each occurs exactly once; a missing or duplicated hunk, or a byte changed inside one, is caught.
assert.strictEqual(INDEX_HUNKS.length, 7, 'A-R1 adds exactly seven index.js hunks');
for (const [i, h] of INDEX_HUNKS.entries()) {
  assert.strictEqual(real.split(h.now).length - 1, 1, `hunk ${i} present exactly once`);
  assert.ok(h.now.includes('// h1 A-R1'), `hunk ${i} carries its marker`);
  assert.throws(() => unapplyH1Index(real.replace(h.now, h.was)), /occurs 0 times/, `hunk ${i} removed → caught`);
  assert.throws(() => unapplyH1Index(real.replace(h.now, h.now + h.now)), /occurs 2 times/, `hunk ${i} duplicated → caught`);
  const mutated = real.replace(h.now, h.now.replace('heldByReject', 'heldByRejct').replace('safeRejectRepair', 'safeRejectRepar').replace('holdAfterClaim', 'holdAfterClam'));
  assert.notStrictEqual(mutated, real);
  assert.throws(() => unapplyH1Index(mutated), /occurs 0 times/, `hunk ${i} edited → caught`);
}
const marked = real.split('\n').filter((l) => l.includes('h1 A-R1'));
assert.strictEqual(marked.length, 7, 'exactly seven A-R1-marked lines in index.js (no stray hook call)');
assert.strictEqual(real.split('merchantHooks.').length - 1, 8, 'merchantHooks is called only from the seven hunks (the reassign hunk calls holdAfterClaim + releaseHeld)');
ok('A-R1: seven hunks, each exactly once; removed / duplicated / edited hunks are each caught');

const lines = block.split('\n').slice(1, -1).filter((l) => l && !l.startsWith('//'));
assert.strictEqual(lines[0], "require('./merchant/merchant-core-binding').bindCancelCore((args) => cancelOrderCore(cancelDeps(getDatabase()), args));");
assert.strictEqual(lines[1], "const merchantFunctions = require('./merchant/merchant-wiring');", 'a PLAIN require (runtime-vs-source discovery resolves the names through it)');
assert.strictEqual(lines[2], "const merchantHooks = require('./merchant/merchant-hooks');");
const wiring = require('./merchant/merchant-wiring');
const B = require('./merchant/merchant-core-binding');
assert.throws(() => B.cancelCore(), /not bound/, 'unbound core refuses');
assert.throws(() => B.bindCancelCore(null), /must be a function/);
const names = Object.keys(wiring).sort();
assert.deepStrictEqual(lines.slice(3).slice().sort(), names.map((k) => `exports.${k} = merchantFunctions.${k};`).sort(), 'exactly one re-export per merchant-wiring function, nothing else');
for (const k of names) assert.ok(/^merchant[A-Z]/.test(k) && !/driver/i.test(k), `name ${k}: merchant-prefixed, never "Driver" (driver-callable guard)`);
assert.ok(!names.includes('merchantPublishRejectIntent') && !names.includes('merchantClearOnDecline'), 'A-R1 dropped the reject triggers');
ok(`the block injects the existing cancel core, loads the hooks, and only re-exports merchant-wiring by name (${names.length} functions)`);

console.log(`\nh1-wiring.guard: OK (${n})`);
