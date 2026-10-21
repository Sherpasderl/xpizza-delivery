'use strict';
// S1b — index.js wiring guard (PLAN-S1b §8). PROOF: tools/s1b-inverse.js removes the 2 S1b index.js blocks, so
// unapplyS1bIndex(index.js) === the S1a index.js layer (applyS1aIndex(c83f2f9:index.js)) byte-for-byte. An edit
// inside a block, a missing delimiter, a third block and a byte outside the blocks are each detected. The six admin
// callables + the Auth-sync sweep + the ops require are actually wired.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyS1bIndex, BLOCKS } = require('./tools/s1b-inverse');
const { applyS1aIndex } = require('./tools/s1a-inverse');
const { unapplyA1Index } = require('./tools/a1-inverse'); // S1b now restacks on A-1; A-1 sits between S1b and S1a

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const S2 = 'c83f2f9';
const s2Idx = execFileSync('git', ['show', `${S2}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const s1aIdx = applyS1aIndex(s2Idx); // the S1a index.js layer S1b sits on (deterministic across rebases)
const real = require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(read('index.js')))))))));   // H1c, H1a, then PLAN-S5 are reversed FIRST

// 1. the inverses reproduce the S1a layer byte-for-byte. S1b restacks on A-1, so S1b is INNERMOST: strip the
//    S1b blocks first, then A-1's, to reach the S1a index.js layer (both inverses proven byte-exact).
assert.strictEqual(unapplyA1Index(unapplyS1bIndex(real)), s1aIdx, '🔴 index.js minus the S1b and A-1 blocks is not the S1a index.js');
assert.notStrictEqual(unapplyS1bIndex(real), real, 'non-vacuity: the S1b blocks are present and removed');
ok(`unapplyA1Index(unapplyS1bIndex(index.js)) === S1a:index.js byte-for-byte (${BLOCKS.length} S1b blocks, A-1 innermost-but-one)`);

// 2. sensitivity — an edit inside a block, a missing delimiter, a third block, a byte outside every block
assert.throws(() => unapplyS1bIndex(real.replace("require('./lib/driver-admin-ops')", "require('./lib/driver-admin-OPS')")), /differs from its pinned bytes/, 'an edit INSIDE a block is caught by the SHA pin');
assert.throws(() => unapplyS1bIndex(real.replace('/* s1b:end require */\n', '')), /expected exactly 2/, 'a missing delimiter is caught');
assert.throws(() => unapplyS1bIndex(real.replace('exports.inviteDriver', '/* s1b:begin x */\n/* s1b:end x */\nexports.inviteDriver')), /expected exactly 2/, 'a third block is caught');
{ const outside = '// s1b-wiring outside-byte probe\n' + real; assert.notStrictEqual(unapplyA1Index(unapplyS1bIndex(outside)), s1aIdx, 'a byte OUTSIDE the blocks survives and fails the pin'); }
ok('edit-inside, missing-delimiter, third-block and outside-byte are each detected');

// 3. wired — the six admin callables + the sweep + the require are present
for (const name of ['inviteDriver', 'submitDriverProfile', 'approveDriver', 'setDriverSuspended', 'setDriverDeactivated', 'reactivate'])
  assert.ok(new RegExp(`exports\\.${name} = onCall\\(`).test(real), `🔴 ${name} onCall missing`);
assert.ok(/exports\.syncDriverAuthSweep = onSchedule\(/.test(real), '🔴 syncDriverAuthSweep onSchedule missing');
assert.ok(/const adminOps = require\('\.\/lib\/driver-admin-ops'\)/.test(real), '🔴 driver-admin-ops require missing');
ok('wired: 6 admin callables + the Auth-sync sweep + the ops require are present');

console.log(`\ns1b-wiring.guard: OK (${n})`);
