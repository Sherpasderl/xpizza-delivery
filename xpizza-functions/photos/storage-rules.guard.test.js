'use strict';
// DISH PHOTOS A1 (advisor ruling 2026-10-27) — the default bucket's Storage rules have ONE source: this repo.
//   1. firebase.json's "storage" block is EXACTLY {"rules": "storage.rules"} (no predeploy, no target, no second bucket), and that file exists.
//   2. storage.rules is DENY-ALL: once comments are stripped, the only rule is `allow read, write: if false;` on /{allPaths=**}. There is NO
//      client-open path: A1's upload (E-P1's V4 signed PUT) and draft preview (E-P2's V4 signed GET) bypass rules by design, so "deny-all
//      except the paths A1 signs" is exactly deny-all. Any `allow` other than the deny line, any `if true`, any extra match → fails.
//   3. Deploying it is an explicit, owner-run `firebase deploy --only storage --project xpizza-delivery` (A1 deploy notes); targeted
//      deploys (`--only functions:…`) never ship it.
// Run: node photos/storage-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');

// ── 1. firebase.json wires the file ──
function checkConfig(fb) {
  assert.deepStrictEqual(fb.storage, { rules: 'storage.rules' }, `STORAGE-RULES-WIRED: firebase.json "storage" must be exactly {"rules":"storage.rules"}, got ${JSON.stringify(fb.storage)}`);
}
const fb = JSON.parse(fs.readFileSync(path.join(FN, 'firebase.json'), 'utf8'));
checkConfig(fb);
assert.ok(fs.existsSync(path.join(FN, fb.storage.rules)), 'STORAGE-RULES-FILE-EXISTS');
for (const bad of [{}, { rules: 'storage.rule' }, { rules: 'storage.rules', predeploy: [] }, [{ bucket: 'x', rules: 'storage.rules' }]])
  assert.throws(() => checkConfig({ ...fb, storage: bad }), /STORAGE-RULES-WIRED/, `non-vacuity: ${JSON.stringify(bad)} is caught`);
assert.throws(() => checkConfig({ ...fb, storage: undefined }), /STORAGE-RULES-WIRED/, 'non-vacuity: a missing block is caught');
ok('firebase.json "storage" === {"rules":"storage.rules"} and the file exists; missing / renamed / extra-key / multi-bucket each caught');

// ── 2. the rules are deny-all ──
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const DENY_ALL = "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if false; } } }";
function checkRules(src) {
  assert.strictEqual(strip(src), DENY_ALL, `STORAGE-RULES-DENY-ALL: storage.rules (comments stripped) must be exactly the deny-all body, got: ${strip(src)}`);
}
const rules = fs.readFileSync(path.join(FN, 'storage.rules'), 'utf8');
checkRules(rules);
for (const [label, mutated] of [
  ['if true', rules.replace('if false', 'if true')],
  ['read opened', rules.replace('allow read, write: if false;', 'allow read; allow write: if false;')],
  ['an extra open path', rules.replace('match /{allPaths=**}', 'match /drafts/{p=**} { allow read: if request.auth != null; }\n    match /{allPaths=**}')],
  ['write-only deny', rules.replace('allow read, write', 'allow write')],
]) {
  assert.notStrictEqual(mutated, rules, `premise ${label}`);
  assert.throws(() => checkRules(mutated), /STORAGE-RULES-DENY-ALL/, `non-vacuity: ${label} is caught`);
}
assert.doesNotThrow(() => checkRules(rules.replace('rules_version', '// a new comment\nrules_version')), 'comments are free');
ok('storage.rules is exactly deny-all (read + write, every path); if true / read opened / an extra open path / write-only deny each caught; comments free');

console.log(`storage-rules.guard: OK (${n})`);
