'use strict';
// PLATFORM F2 Q2 gate (4a906c07 RED: availability-reset / client-floor-rules / kitchen-floor-ops) — every test HARNESS that loads the
// REAL kitchen SDK (xpizza-kitchen/xpizza-delivery.js) by rewriting its Firebase CDN imports must keep up with the SDK's imports:
//   (1) every SIBLING module the SDK imports (`from './x.js'`) is resolved — by a generic `./<name>.js` rewrite or one per sibling;
//       a data: URL cannot resolve a relative specifier (ERR_UNSUPPORTED_RESOLVE_REQUEST);
//   (2) a hand-written Firebase SHIM exports every name the SDK imports from the CDN (else: "does not provide an export named …").
// The emulator suites that use these harnesses run only in the gate; this static check runs in npm test.
// Run: node kitchen-sdk-harness.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SDK = fs.readFileSync(path.join(REPO, 'xpizza-kitchen', 'xpizza-delivery.js'), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = strip(SDK);
const siblings = [...code.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => m[1]);
const cdnNames = [];
for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-[a-z]+\.js'/g)) {
  for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n) cdnNames.push(n); }
}
assert.ok(siblings.includes('order-filter.js') && siblings.includes('cancel-ack-set.js'), `the SDK's sibling imports are parsed (${siblings})`);
for (const n of ['ref', 'onValue', 'query', 'orderByChild', 'equalTo', 'initializeApp']) assert.ok(cdnNames.includes(n), `the SDK's CDN imports are parsed (${n})`);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(REPO, 'xpizza-functions')), ...walk(path.join(REPO, 'xpizza-kitchen'))]
  .filter((f) => f !== __filename)
  .filter((f) => { const s = fs.readFileSync(f, 'utf8'); return s.includes('xpizza-delivery.js') && /gstatic\\?\.com\\?\/firebasejs/.test(s) && /\.replace\(/.test(s); });
const rel = (f) => path.relative(REPO, f);
const known = ['xpizza-functions/test/client-floor-rules.emulator.test.mjs', 'xpizza-functions/test/kitchen-floor-ops.emulator.test.js', 'xpizza-functions/test/kds-writer-capture.mjs'];
for (const k of known) assert.ok(files.map(rel).includes(k), `discovery finds the known harness ${k} (found ${files.map(rel)})`);

const bad = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const generic = s.includes("from '\\.\\/([\\w-]+\\.js)'");
  for (const sib of siblings) {
    if (!generic && !s.includes(`from '\\.\\/${sib.replace(/\./g, '\\.')}'`)) bad.push(`${rel(f)}: does not resolve the SDK's sibling './${sib}'`);
  }
  if (/export \* from/.test(s)) continue;   // re-exports a real Firebase SDK: every name exists
  const exported = new Set([...s.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const n of cdnNames) if (!exported.has(n)) bad.push(`${rel(f)}: its Firebase shim does not export '${n}' (the SDK imports it)`);
}
assert.deepStrictEqual(bad, [], `kitchen SDK harnesses out of step with the SDK's imports:\n  ${bad.join('\n  ')}`);
console.log(`kitchen-sdk-harness.guard: OK (${files.length} harnesses × ${siblings.length} siblings + ${cdnNames.length} Firebase names)`);
