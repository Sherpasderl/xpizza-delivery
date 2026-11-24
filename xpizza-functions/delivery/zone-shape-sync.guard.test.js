'use strict';
// Z2 §A (PLAN-portal-zones-protocol-v3-r4, Q1 = A) — the portal's drawing preview runs the SAME shape check the server judges with:
// xpizza-portal/zone-shape.js is a byte copy of delivery/zone-shape.js (3a, c574d1213), written by tools/sync-client.js. Any drift —
// one byte — is red, from the moment a portal page references it (portal-ui's Z2 drawing lands the copy, its <script> tag and the
// site-freeze golden together). The server stays authoritative: the copy only previews.
// Run: node delivery/zone-shape-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'zone-shape.js');
const COPY = path.join(ROOT, 'xpizza-portal', 'zone-shape.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'delivery', 'zone-shape\.js'\)[^\n]*'xpizza-portal', 'zone-shape\.js'\)/.test(sync), '🔴 ZSS-SYNC tools/sync-client.js writes the copy');
const portalDir = path.join(ROOT, 'xpizza-portal');
const referenced = fs.readdirSync(portalDir).filter((f) => /\.(html|js|mjs)$/.test(f) && f !== 'zone-shape.js' && !f.includes('.test.')).some((f) => fs.readFileSync(path.join(portalDir, f), 'utf8').includes('zone-shape.js'));
if (referenced || fs.existsSync(COPY)) {
  assert.ok(fs.existsSync(COPY), '🔴 ZSS-COPY a portal page references zone-shape.js: the copy must exist (run node tools/sync-client.js)');
  assert.ok(same(fs.readFileSync(SRC), fs.readFileSync(COPY)), '🔴 ZSS-BYTES the portal copy is byte-identical to the server module — run node tools/sync-client.js');
}
const a0 = fs.readFileSync(SRC); const drifted = Buffer.from(a0); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a0, drifted), 'ZSS-NONVACUOUS a one-byte drift is detected');
ok(`sync-client writes the portal copy; ${referenced || fs.existsSync(COPY) ? 'the copy is byte-identical' : 'no portal page references it yet — the byte check binds the moment one does'}`);
console.log(`\nzone-shape-sync.guard: OK (${n})`);
