'use strict';
// PLAN-capp-native-shell D4 — the native shell's BUNDLED Firebase JS SDK is the SAME version the web loads, byte-for-byte:
//   1. one version three ways: the lock == customer-app/capp-auth-firebase.js's gstatic SDK == every order form's account.js
//   2. the vendored files hash to the lock (fetched once from gstatic, never edited in place)
//   3. the ONE import the packager rewrites (firebase-auth → the absolute gstatic firebase-app URL) occurs exactly once
// Run: node platform/native/vendor.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..', '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor', 'firebasejs.lock.json'), 'utf8'));
const DIR = path.join(__dirname, 'vendor', 'firebasejs', LOCK.version);
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform', 'sites.json'), 'utf8'));
const FORMS = SITES.deployments.filter((d) => d.app === 'orders' && d.context !== 'platform').map((d) => d.folder);
const versionsIn = (file) => [...new Set([...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/gstatic\.com\/firebasejs\/(\d+\.\d+\.\d+)/g)].map((m) => m[1]))];

assert.match(LOCK.version, /^\d+\.\d+\.\d+$/); assert.strictEqual(LOCK.source, `https://www.gstatic.com/firebasejs/${LOCK.version}/`);
assert.deepStrictEqual(versionsIn('customer-app/capp-auth-firebase.js'), [LOCK.version], '🔴 the web capp loads a different Firebase SDK than the native bundle');
assert.ok(FORMS.length >= 2, 'premise: both order forms');
for (const f of FORMS) assert.deepStrictEqual(versionsIn(`${f}/account.js`), [LOCK.version], `🔴 ${f}/account.js loads a different Firebase SDK than the native bundle`);
ok(`one Firebase SDK version three ways: the lock = capp-auth-firebase.js = ${FORMS.map((f) => `${f}/account.js`).join(' = ')} = ${LOCK.version}`);

assert.deepStrictEqual(Object.keys(LOCK.files).sort(), ['firebase-app.js', 'firebase-auth.js']);
assert.deepStrictEqual(fs.readdirSync(DIR).sort(), ['firebase-app.js', 'firebase-auth.js'], 'nothing else vendored');
for (const [f, h] of Object.entries(LOCK.files)) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex'), h, `🔴 vendored ${f} differs from its locked hash`);
ok('the two vendored files hash exactly to the lock (as fetched from gstatic)');

const auth = fs.readFileSync(path.join(DIR, 'firebase-auth.js'), 'utf8');
const anchor = `from"${LOCK.source}firebase-app.js"`;
assert.strictEqual(auth.split(anchor).length - 1, 1, 'the packager\'s one rewrite anchor occurs exactly once');
assert.strictEqual((auth.match(/gstatic\.com\/firebasejs/g) || []).length, 1, 'no other gstatic module import in firebase-auth.js');
// firebase-app.js names its own gstatic URL as the component name / logger tag (strings), but IMPORTS nothing
const app = fs.readFileSync(path.join(DIR, 'firebase-app.js'), 'utf8');
assert.ok(!/(^|[;}\s])import\s*[\s{*"'(]|\bfrom\s*["']https?:/.test(app), 'firebase-app.js has no static or dynamic import');
ok('firebase-auth.js imports firebase-app.js by its absolute gstatic URL exactly once (the packager rewrites it to ./firebase-app.js); nothing else reaches gstatic');
console.log(`native vendor: OK (${n})`);
