'use strict';
// PLATFORM F2 Q2 — the frozen pre-F2 KDS filter (access/kds-filter-pre-f2.mjs) is pinned by COMMITTED sha256 digests, with no
// dependence on git history and no skip path (codex F2q2 r1 P2-4):
//   - the WHOLE file's digest, and
//   - the digest of its body below the 4-line header, which equals the digest of xpizza-kitchen/order-filter.js at main b98cd04d
//     (the deployed pre-F2 KDS filter; recorded when the copy was made).
// It is referenced only by the access census and the two Q2 parity tests (their baseline). Run: node access/kds-filter-pre-f2.guard.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_SHA256 = 'd576fab74cbb8e43945d6129487f763e72f089f2dcebae58ba1d3948d9c39067';
const BODY_SHA256_B98CD04D_ORDER_FILTER = '2e13e3617b2d9493a537a25244b1a714c5bf56a5b235140c39b28b123f4f0772';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const raw = fs.readFileSync(path.join(__dirname, 'kds-filter-pre-f2.mjs'));
assert.strictEqual(sha(raw), FILE_SHA256, 'kds-filter-pre-f2.mjs changed: the frozen baseline must never be edited');
const lines = raw.toString('utf8').split('\n');
assert.ok(lines.slice(0, 4).every((l) => l.startsWith('//')), 'the 4-line header is comment-only');
assert.strictEqual(sha(lines.slice(4).join('\n')), BODY_SHA256_B98CD04D_ORDER_FILTER, 'the body is byte-for-byte b98cd04d:xpizza-kitchen/order-filter.js');
console.log('  ✓ 1 committed sha256 pins: the whole file, and its body = b98cd04d:xpizza-kitchen/order-filter.js (no git needed, never skipped)');

// references: a filesystem walk of the repo's .js / .mjs / .html (no git)
const ROOT = path.join(__dirname, '..', '..');
const refs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|html)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('kds-filter-pre-f2')) refs.push(path.relative(ROOT, p));
  }
})(ROOT);
assert.deepStrictEqual(refs.sort(), ['xpizza-functions/access/access-census-core.js', 'xpizza-functions/access/access-census-core.test.js', 'xpizza-functions/access/kds-filter-pre-f2.guard.test.js', 'xpizza-functions/access/kds-filter-pre-f2.mjs', 'xpizza-functions/test/kds-feed-parity.emulator.test.mjs', 'xpizza-functions/test/kds-legacy-intake-parity.emulator.test.js', 'xpizza-functions/tools/access-census.js'],
  `only the census (and the two Q2 parity tests, as their baseline) references the frozen filter (${refs.join(', ')})`);
console.log('  ✓ 2 referenced only by the access census + the Q2 parity tests (filesystem walk)');
console.log('kds-filter-pre-f2.guard: OK (2)');
