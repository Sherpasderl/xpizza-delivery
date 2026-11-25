'use strict';
// RTDB SDK pin (PLAN-rtdb-get-once-race-r3 §8). The get() → once('value') workaround and its cells (test/rtdb-race-*.test.js) were
// proved on EXACTLY this tuple: firebase-admin 12.7.0 → @firebase/database-compat 1.0.8 (index.standalone.js, the file firebase-admin
// requires) → @firebase/database 1.0.8. Any change — the lockfile, the artifact firebase-admin actually resolves, or its bytes — is red
// until the race cells are re-run on the new tuple (and, when a release carries the upstream fix, the revert plan replaces this guard).
//   node tools/rtdb-sdk-pin.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const PIN = Object.freeze({
  'node_modules/firebase-admin': '12.7.0',
  'node_modules/@firebase/database-compat': '1.0.8',
  'node_modules/@firebase/database': '1.0.8',
});
const ARTIFACT = 'node_modules/@firebase/database-compat/dist/index.standalone.js';
const SHA256 = '3c3e93d04d6ba9750ffb4a6834310f4485fbea739f389db49be531ba2ea2197d';
const root = path.join(__dirname, '..');

cell('RG-PIN-LOCK: the lockfile resolves the pinned tuple', (L) => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages || {};
  assert.deepStrictEqual(Object.fromEntries(Object.keys(PIN).map((k) => [k, lock[k] && lock[k].version])), PIN, `🔴 ${L}`);
});
cell('RG-PIN-RESOLVE: firebase-admin\'s own require of the standalone database resolves to the pinned artifact', (L) => {
  const resolved = Module.createRequire(require.resolve('firebase-admin/database', { paths: [root] })).resolve('@firebase/database-compat/standalone');
  assert.strictEqual(path.relative(root, resolved), ARTIFACT, `🔴 ${L}`);
});
cell('RG-PIN-SHA: the artifact\'s bytes are the ones the race cells ran on', (L) => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, ARTIFACT))).digest('hex');
  assert.strictEqual(sha, SHA256, `🔴 ${L}`);
});
if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
console.log(`rtdb-sdk-pin.guard: OK (${n})`);
