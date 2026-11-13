'use strict';
// S4 (PLAN-structure-S4-r4; advisor 11-13 rule 4) — the portal's S4 writer derives slugs and promotion order with the SAME bytes this repo proves
// (catalog/section-transitions.test.js): xpizza-portal/section-transitions.js is a byte copy of catalog/section-transitions.js,
// written by tools/sync-client.js. Any drift — one byte — is red, from the moment a portal page references it (portal-ui's S4
// writer lands the copy, its <script> tag and the site-freeze golden together).
// Run: node catalog/section-transitions-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'section-transitions.js');
const COPY = path.join(ROOT, 'xpizza-portal', 'section-transitions.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'catalog', 'section-transitions\.js'\)[^\n]*'xpizza-portal', 'section-transitions\.js'\)/.test(sync), '🔴 STS-SYNC tools/sync-client.js writes the copy');
// TIED to the portal: the moment any portal page or module references the file (portal-ui's S4 writer <script>), the copy must exist and be
// byte-identical; the copy, its <script> tag and the site-freeze golden land together in portal-ui's lane.
const portalDir = path.join(ROOT, 'xpizza-portal');
const referenced = fs.readdirSync(portalDir).filter((f) => /\.(html|js|mjs)$/.test(f) && f !== 'section-transitions.js' && !f.includes('.test.')).some((f) => fs.readFileSync(path.join(portalDir, f), 'utf8').includes('section-transitions.js'));
if (referenced || fs.existsSync(COPY)) {
  assert.ok(fs.existsSync(COPY), '🔴 STS-COPY a portal page references section-transitions.js: the copy must exist (run node tools/sync-client.js)');
  const a = fs.readFileSync(SRC); const b = fs.readFileSync(COPY);
  assert.ok(same(a, b), '🔴 STS-BYTES the portal copy is byte-identical to the server module — run node tools/sync-client.js');
}
const a0 = fs.readFileSync(SRC); const drifted = Buffer.from(a0); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a0, drifted), 'STS-NONVACUOUS a one-byte drift is detected');
ok(`sync-client writes the portal copy; ${referenced || fs.existsSync(COPY) ? 'the copy is byte-identical' : 'no portal page references it yet (portal-ui S4 writer) — the byte check binds the moment one does'}`);
console.log(`\nsection-transitions-sync.guard: OK (${n})`);
