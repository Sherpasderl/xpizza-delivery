'use strict';
// S3 (PLAN-structure-S3-r3 §0) — the portal's choice editor writes its draft with the SAME bytes this repo proves
// (catalog/choice-transitions.test.js): xpizza-portal/choice-transitions.js is a byte copy of catalog/choice-transitions.js,
// written by tools/sync-client.js. Any drift — one byte — is red, from the moment a portal page references it (portal-ui's choice
// editor lands the copy, its <script> tag and the site-freeze golden together).
// Run: node catalog/choice-transitions-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'choice-transitions.js');
const COPY = path.join(ROOT, 'xpizza-portal', 'choice-transitions.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'catalog', 'choice-transitions\.js'\)[^\n]*'xpizza-portal', 'choice-transitions\.js'\)/.test(sync), '🔴 CTS-SYNC tools/sync-client.js writes the copy');
// TIED to the portal: the moment any portal page or module references the file (portal-ui's choice editor <script>), the copy must exist and be
// byte-identical; the copy, its <script> tag and the site-freeze golden land together in portal-ui's lane.
const portalDir = path.join(ROOT, 'xpizza-portal');
const referenced = fs.readdirSync(portalDir).filter((f) => /\.(html|js|mjs)$/.test(f) && f !== 'choice-transitions.js' && !f.includes('.test.')).some((f) => fs.readFileSync(path.join(portalDir, f), 'utf8').includes('choice-transitions.js'));
if (referenced || fs.existsSync(COPY)) {
  assert.ok(fs.existsSync(COPY), '🔴 CTS-COPY a portal page references choice-transitions.js: the copy must exist (run node tools/sync-client.js)');
  const a = fs.readFileSync(SRC); const b = fs.readFileSync(COPY);
  assert.ok(same(a, b), '🔴 CTS-BYTES the portal copy is byte-identical to the server module — run node tools/sync-client.js');
}
const a0 = fs.readFileSync(SRC); const drifted = Buffer.from(a0); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a0, drifted), 'CTS-NONVACUOUS a one-byte drift is detected');
ok(`sync-client writes the portal copy; ${referenced || fs.existsSync(COPY) ? 'the copy is byte-identical' : 'no portal page references it yet (portal-ui choice editor) — the byte check binds the moment one does'}`);
console.log(`\nchoice-transitions-sync.guard: OK (${n})`);
