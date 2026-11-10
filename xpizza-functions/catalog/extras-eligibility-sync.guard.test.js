'use strict';
// S2-10 (D4c-grill/item-s1/S2-DESIGN.md §1.6; advisor ruling G2; Codex S2 code r1 P2-7) — the portal's drawer judges extras with
// the SAME bytes as the server: xpizza-portal/extras-eligibility.js is a byte copy of catalog/extras-eligibility.js, written by
// tools/sync-client.js. Any drift — one byte — is red. (Loading it in the portal page is portal-ui's S4 change.)
// Run: node catalog/extras-eligibility-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'extras-eligibility.js');
const COPY = path.join(ROOT, 'xpizza-portal', 'extras-eligibility.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

assert.ok(fs.existsSync(COPY), '🔴 EES-COPY the portal carries its copy (run node tools/sync-client.js)');
const a = fs.readFileSync(SRC); const b = fs.readFileSync(COPY);
assert.ok(same(a, b), '🔴 EES-BYTES the portal copy is byte-identical to the server module — run node tools/sync-client.js');
const drifted = Buffer.from(b); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a, drifted), 'EES-NONVACUOUS a one-byte drift is detected');
const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'catalog', 'extras-eligibility\.js'\)[^\n]*'xpizza-portal', 'extras-eligibility\.js'\)/.test(sync), '🔴 EES-SYNC tools/sync-client.js writes the copy');
ok('the portal\'s extras-eligibility.js is the server module byte for byte, written by sync-client; one byte of drift is red');
console.log(`\nextras-eligibility-sync.guard: OK (${n})`);
