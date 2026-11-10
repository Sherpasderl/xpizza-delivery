'use strict';
// S2-10 (D4c-grill/item-s1/S2-DESIGN.md §1.6; advisor ruling G2; Codex S2 code r1 P2-7) — the portal's drawer judges extras with
// the SAME bytes as the server: xpizza-portal/extras-eligibility.js is a byte copy of catalog/extras-eligibility.js, written by
// tools/sync-client.js. Any drift — one byte — is red, from the moment a portal page references it (portal-ui's S4 change lands
// the copy, its <script> and the site-freeze golden together).
// Run: node catalog/extras-eligibility-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'extras-eligibility.js');
const COPY = path.join(ROOT, 'xpizza-portal', 'extras-eligibility.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'catalog', 'extras-eligibility\.js'\)[^\n]*'xpizza-portal', 'extras-eligibility\.js'\)/.test(sync), '🔴 EES-SYNC tools/sync-client.js writes the copy');
// TIED to the portal: the moment any portal page or module references the file (portal-ui's S4 <script>), the copy must exist and be
// byte-identical; the copy, its <script> tag and the site-freeze golden land together in portal-ui's lane.
const portalDir = path.join(ROOT, 'xpizza-portal');
const referenced = fs.readdirSync(portalDir).filter((f) => /\.(html|js|mjs)$/.test(f) && f !== 'extras-eligibility.js' && !f.includes('.test.')).some((f) => fs.readFileSync(path.join(portalDir, f), 'utf8').includes('extras-eligibility.js'));
if (referenced || fs.existsSync(COPY)) {
  assert.ok(fs.existsSync(COPY), '🔴 EES-COPY a portal page references extras-eligibility.js: the copy must exist (run node tools/sync-client.js)');
  const a = fs.readFileSync(SRC); const b = fs.readFileSync(COPY);
  assert.ok(same(a, b), '🔴 EES-BYTES the portal copy is byte-identical to the server module — run node tools/sync-client.js');
}
const a0 = fs.readFileSync(SRC); const drifted = Buffer.from(a0); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a0, drifted), 'EES-NONVACUOUS a one-byte drift is detected');
ok(`sync-client writes the portal copy; ${referenced || fs.existsSync(COPY) ? 'the copy is byte-identical' : 'no portal page references it yet (portal-ui S4) — the byte check binds the moment one does'}`);
console.log(`\nextras-eligibility-sync.guard: OK (${n})`);
