'use strict';
// PLATFORM F2 Q2 — the frozen pre-F2 KDS filter (access/kds-filter-pre-f2.mjs) is BYTE-FOR-BYTE xpizza-kitchen/order-filter.js at
// main b98cd04d below its 4-line header, and nothing but access-census imports it. Run: node access/kds-filter-pre-f2.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = 'b98cd04d';
const copy = fs.readFileSync(path.join(__dirname, 'kds-filter-pre-f2.mjs'), 'utf8').split('\n');
assert.ok(copy.slice(0, 4).every((l) => l.startsWith('//')), 'the 4-line header is comment-only');
let base = null;
try { base = execFileSync('git', ['show', `${BASE}:xpizza-kitchen/order-filter.js`], { cwd: __dirname, encoding: 'utf8' }); } catch (_) { /* shallow clone */ }
if (base !== null) assert.strictEqual(copy.slice(4).join('\n'), base, `kds-filter-pre-f2.mjs must equal ${BASE}:xpizza-kitchen/order-filter.js below the header`);
else console.log(`  · ${BASE} unavailable (shallow clone) — byte pin skipped`);
const root = path.join(__dirname, '..', '..');
const importers = execFileSync('git', ['grep', '-l', 'kds-filter-pre-f2', '--', '*.js', '*.mjs', '*.html'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
assert.deepStrictEqual(importers, ['xpizza-functions/access/access-census-core.js', 'xpizza-functions/access/access-census-core.test.js', 'xpizza-functions/access/kds-filter-pre-f2.guard.test.js', 'xpizza-functions/access/kds-filter-pre-f2.mjs', 'xpizza-functions/tools/access-census.js'], `only the census references the frozen filter (${importers.join(', ')})`);
console.log('kds-filter-pre-f2.guard: OK (byte pin to the deployed pre-F2 KDS filter; referenced only by the access census)');
