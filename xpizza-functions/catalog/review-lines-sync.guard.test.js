'use strict';
// PLAN-portal-review-lines-r0 (advisor 11-23) — the server counts «cambios sin publicar» with the SAME bytes the review screen arranges
// its sentences with: catalog/review-lines.js is a byte copy of xpizza-portal/review-lines.js (the source), written by
// tools/sync-client.js. One byte of drift is red. The copy also loads as the server loads it (CommonJS), and the source as the portal
// loads it (a classic script defining ReviewLines), both exposing the one API.
// Run: node catalog/review-lines-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'xpizza-portal', 'review-lines.js');
const COPY = path.join(__dirname, 'review-lines.js');
const API = ['reviewModel', 'reviewCount', 'reviewCtxFromSource', 'ackSetFrom', 'movedGroups', 'isPhotoLine', 'S3_COPY', 's3Copy', 'S4_COPY', 's4Copy', 'nProd'];
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'xpizza-portal', 'review-lines\.js'\)[^\n]*'xpizza-functions', 'catalog', 'review-lines\.js'\)/.test(sync), '🔴 RL-SYNC tools/sync-client.js writes the copy');
ok('tools/sync-client.js writes catalog/review-lines.js from the portal source');
assert.ok(fs.existsSync(COPY), '🔴 RL-COPY the server copy exists (run node tools/sync-client.js)');
assert.ok(same(fs.readFileSync(SRC), fs.readFileSync(COPY)), '🔴 RL-BYTES the server copy is byte-identical to the portal source — run node tools/sync-client.js');
ok('the server copy is byte-identical to the portal source');
const a0 = fs.readFileSync(SRC); const drifted = Buffer.from(a0); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a0, drifted), 'RL-NONVACUOUS a one-byte drift is detected');
ok('a one-byte drift is detected (non-vacuous)');
const cjs = require(COPY);
assert.deepStrictEqual(Object.keys(cjs).sort(), [...API].sort(), '🔴 RL-CJS the server copy exports the one API');
const g = {}; vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), { globalThis: g });
assert.deepStrictEqual(Object.keys(g.ReviewLines || {}).sort(), [...API].sort(), '🔴 RL-CLASSIC the portal source defines ReviewLines as a classic script');
assert.strictEqual(cjs.reviewCount({ added: [{ surface: 'item', key: 'k1' }] }, {}), 1, 'premise: the count runs on the server copy');
ok('the server requires it (CommonJS) and the portal runs it (the ReviewLines global), with the same API');
console.log(`\nreview-lines-sync.guard: OK (${n})`);
