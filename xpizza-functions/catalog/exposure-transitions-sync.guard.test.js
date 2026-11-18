'use strict';
// S2-core (PLAN-structure-S2core-r3 §3.2) — the portal's Extras page writes its draft with the SAME bytes this repo proves
// (catalog/exposure-transitions.test.js): xpizza-portal/exposure-transitions.js is a byte copy of catalog/exposure-transitions.js,
// written by tools/sync-client.js. Any drift — one byte — is red, from the moment a portal page references it (portal-ui's Extras
// page lands the copy, its <script> AFTER exposure-transitions.js — it reads the ExtrasEligibility global — and the site-freeze golden).
// Run: node catalog/exposure-transitions-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'exposure-transitions.js');
const COPY = path.join(ROOT, 'xpizza-portal', 'exposure-transitions.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'catalog', 'exposure-transitions\.js'\)[^\n]*'xpizza-portal', 'exposure-transitions\.js'\)/.test(sync), '🔴 XTS-SYNC tools/sync-client.js writes the copy');
// TIED to the portal: the moment any portal page or module references the file (portal-ui's Extras page <script>), the copy must exist and be
// byte-identical; the copy, its <script> tag and the site-freeze golden land together in portal-ui's lane.
const portalDir = path.join(ROOT, 'xpizza-portal');
const referenced = fs.readdirSync(portalDir).filter((f) => /\.(html|js|mjs)$/.test(f) && f !== 'exposure-transitions.js' && !f.includes('.test.')).some((f) => fs.readFileSync(path.join(portalDir, f), 'utf8').includes('exposure-transitions.js'));
if (referenced || fs.existsSync(COPY)) {
  assert.ok(fs.existsSync(COPY), '🔴 XTS-COPY a portal page references exposure-transitions.js: the copy must exist (run node tools/sync-client.js)');
  const a = fs.readFileSync(SRC); const b = fs.readFileSync(COPY);
  assert.ok(same(a, b), '🔴 XTS-BYTES the portal copy is byte-identical to the server module — run node tools/sync-client.js');
}
const a0 = fs.readFileSync(SRC); const drifted = Buffer.from(a0); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a0, drifted), 'XTS-NONVACUOUS a one-byte drift is detected');
ok(`sync-client writes the portal copy; ${referenced || fs.existsSync(COPY) ? 'the copy is byte-identical' : 'no portal page references it yet (portal-ui Extras page) — the byte check binds the moment one does'}`);
console.log(`\nexposure-transitions-sync.guard: OK (${n})`);
