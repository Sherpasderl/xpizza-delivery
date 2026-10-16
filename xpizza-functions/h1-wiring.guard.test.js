'use strict';
// H1a (PLAN-H1a r2 T8) — the handheld's index.js footprint is ONE delimited block, nothing else. Run: node h1-wiring.guard.test.js
//   1. unapplyH1Index(index.js) === the pre-H1a index.js. The base is the parent of the commit that introduced the block
//      (found with git log -S), or HEAD's index.js while the block is still uncommitted.
//   2. Sensitivity: a byte inside the block, a missing delimiter, a second block and a byte outside are each caught.
//   3. The block only re-exports merchant-wiring by name (static guards read these names) — no logic in index.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyH1Index, BEGIN, END } = require('./tools/h1-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
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

const lines = block.split('\n').slice(1, -1).filter((l) => l && !l.startsWith('//'));
assert.strictEqual(lines[0], "const merchantFunctions = require('./merchant/merchant-wiring');");
const wiring = require('./merchant/merchant-wiring');
const names = Object.keys(wiring).sort();
assert.deepStrictEqual(lines.slice(1).slice().sort(), names.map((k) => `exports.${k} = merchantFunctions.${k};`).sort(), 'exactly one re-export per merchant-wiring function, nothing else');
for (const k of names) assert.ok(/^merchant[A-Z]/.test(k) && !/driver/i.test(k), `name ${k}: merchant-prefixed, never "Driver" (driver-callable guard)`);
ok(`the block only re-exports merchant-wiring by name (${names.length} functions); no name contains "Driver"`);

console.log(`\nh1-wiring.guard: OK (${n})`);
