'use strict';
// capp offers (advisor 11-14; rule 4) — the capp judges offers with the SAME bytes as the server: customer-app/offer-rules.js is a byte copy
// of marketing/offer-rules.js, written by tools/sync-client.js. Any drift — one byte — is red, from the moment a capp page or module
// references it (capp's lane lands the copy, its <script> and any site golden together). The server modules REQUIRE the canonical file
// (pinned here too, so the server can never quietly fork its own copy of a rule).
// Run: node marketing/offer-rules-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(__dirname, 'offer-rules.js');
const COPY = path.join(ROOT, 'customer-app', 'offer-rules.js');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const same = (a, b) => Buffer.compare(a, b) === 0;

const sync = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sync-client.js'), 'utf8');
assert.ok(/'xpizza-functions', 'marketing', 'offer-rules\.js'\), path\.join\(ROOT, f, 'offer-rules\.js'\)/.test(sync), '🔴 ORS-SYNC tools/sync-client.js writes the copy');
// the server's callers REQUIRE the one module (no private copy of the rule)
const srcOf = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
assert.ok(/require\('\.\/offer-rules'\)/.test(srcOf('marketing/offer-price.js')) && /OR\.bogoSaving\(/.test(srcOf('marketing/offer-price.js')) && /OR\.inWindow\(/.test(srcOf('marketing/offer-price.js')), '🔴 ORS-SERVER offer-price calls bogoSaving + inWindow');
assert.ok(/require\('\.\/offer-rules'\)/.test(srcOf('marketing/offer-model.js')) && !/function weeklyIntervals\(/.test(srcOf('marketing/offer-model.js')), '🔴 ORS-SERVER offer-model re-exports weeklyIntervals, never redefines it');
const serve = path.join(__dirname, '..', 'catalog', 'offers-serve.js');
if (fs.existsSync(serve)) assert.ok(/require\('\.\.\/marketing\/offer-rules'\)/.test(fs.readFileSync(serve, 'utf8')) && !/OM\.weeklyIntervals\(/.test(fs.readFileSync(serve, 'utf8')), '🔴 ORS-SERVER offers-serve calls inWindow');
ok(`the server modules require the one module${fs.existsSync(serve) ? ' (offers-serve included)' : ''}`);
// TIED to the capp: the moment any capp page or module references the file, the copy must exist and be byte-identical
const cappDir = path.join(ROOT, 'customer-app');
const referenced = fs.readdirSync(cappDir).filter((f) => /\.(html|js|mjs)$/.test(f) && f !== 'offer-rules.js' && !f.includes('.test.')).some((f) => fs.readFileSync(path.join(cappDir, f), 'utf8').includes('offer-rules'));
if (referenced || fs.existsSync(COPY)) {
  assert.ok(fs.existsSync(COPY), '🔴 ORS-COPY a capp page references offer-rules.js: the copy must exist (run node tools/sync-client.js)');
  assert.ok(same(fs.readFileSync(SRC), fs.readFileSync(COPY)), '🔴 ORS-BYTES the capp copy is byte-identical to the server module — run node tools/sync-client.js');
}
const a0 = fs.readFileSync(SRC); const drifted = Buffer.from(a0); drifted[drifted.length - 2] ^= 1;
assert.ok(!same(a0, drifted), 'ORS-NONVACUOUS a one-byte drift is detected');
// the browser path: the same bytes define window.OfferRules (no require, no export)
const vm = require('vm'); const box = {}; vm.runInNewContext(a0.toString('utf8'), { globalThis: box });
assert.deepStrictEqual(Object.keys(box.OfferRules).sort(), ['WEEK_MIN', 'bogoSaving', 'inWindow', 'weeklyIntervals'], 'ORS-BROWSER the file is a classic script exposing OfferRules');
ok(`sync-client writes the capp copy; ${referenced || fs.existsSync(COPY) ? 'the copy is byte-identical' : 'no capp page references it yet — the byte check binds the moment one does'}; the bytes run as a browser script`);
console.log(`\noffer-rules-sync.guard: OK (${n})`);
