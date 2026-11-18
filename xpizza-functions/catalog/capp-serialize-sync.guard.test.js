'use strict';
// S2-core (Codex build r1 P1-2) — the server judges a new extra's label with the capp serializer's OWN predicate: catalog/capp-serialize.js
// is a byte copy of customer-app/capp-serialize.js (written by tools/sync-client.js), whose UNSAFE_LABEL literal catalog/extras-validate.js compiles. One byte of
// drift is red. The capp menu's own display predicate (capp-menu.js LABEL_UNSAFE) is pinned to the same source text.
// Run: node catalog/capp-serialize-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SRC = path.join(ROOT, 'customer-app', 'capp-serialize.js');
const COPY = path.join(__dirname, 'capp-serialize.js');
const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'customer-app', 'capp-serialize\.js'\)[^\n]*'xpizza-functions', 'catalog', 'capp-serialize\.js'\)/.test(sync), '🔴 CSS-SYNC tools/sync-client.js writes the copy');
ok('sync-client writes catalog/capp-serialize.js');
assert.ok(Buffer.compare(fs.readFileSync(SRC), fs.readFileSync(COPY)) === 0, '🔴 CSS-BYTES catalog/capp-serialize.js is byte-identical to the capp\'s — run node tools/sync-client.js');
const drifted = Buffer.from(fs.readFileSync(SRC)); drifted[drifted.length - 2] ^= 1;
assert.ok(Buffer.compare(drifted, fs.readFileSync(COPY)) !== 0, 'CSS-NONVACUOUS a one-byte drift is detected');
ok('the copy is byte-identical (a one-byte drift is detected)');
const lit = fs.readFileSync(COPY, 'utf8').match(/\n {2}const UNSAFE_LABEL = (\/.+?\/);/);
assert.ok(lit, '🔴 CSS-DECL the capp serializer declares UNSAFE_LABEL');
const UNSAFE_LABEL = { src: lit[1] };
assert.strictEqual(String(require('./extras-validate').EXTRA_LABEL_UNSAFE), lit[1], '🔴 CSS-ONE the server validator compiles the serializer\'s own literal, nothing else');
const m = fs.readFileSync(path.join(ROOT, 'customer-app', 'capp-menu.js'), 'utf8').match(/const LABEL_UNSAFE = (\/[^\n]*?\/);/);
assert.ok(m && m[1] === UNSAFE_LABEL.src, '🔴 CSS-MENU the capp menu\'s LABEL_UNSAFE is the serializer\'s rule, byte for byte');
ok('the server validator compiles the capp serializer\'s own literal; the capp menu\'s display rule is the same source text');
console.log(`\ncapp-serialize-sync.guard: OK (${n})`);
