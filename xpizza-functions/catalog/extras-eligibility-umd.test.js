'use strict';
// S2-10 (D4c-grill/item-s1/S2-DESIGN.md §1.6; advisor ruling G2) — the ONE extras-eligibility rule runs byte-identically on the
// server and in the portal: catalog/extras-eligibility.js is UMD-lite (the avail-key.js pattern — no `export` keyword): CommonJS
// under Node, a `ExtrasEligibility` global otherwise. The SAME bytes, loaded as a classic script with no module system, give the
// same answers. (The portal's synced copy and its drift guard land with S4.) Run: node catalog/extras-eligibility-umd.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('./extras-eligibility');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const src = fs.readFileSync(path.join(__dirname, 'extras-eligibility.js'), 'utf8');
assert.ok(!/^\s*export\s/m.test(src), 'UMD-1 no `export` keyword (a classic script must parse it)');
assert.deepStrictEqual(Object.keys(E).sort(), ['ALL', 'eligibleExtras', 'eligibleSet', 'projectEligibility', 'publicDeny'], 'UMD-2 the CommonJS exports are unchanged');
ok('CommonJS: the same five exports; no export keyword');

const sandbox = {}; sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox, { filename: 'extras-eligibility.js' });
const B = sandbox.ExtrasEligibility;
assert.ok(B && typeof B.eligibleSet === 'function', 'UMD-3 as a classic script (no module) it defines the ExtrasEligibility global');
for (const rid of ['x_pizza', 'la_musa']) {
  const s = buildSourceFromCode(rid);
  const pn = E.projectEligibility(s); const pb = B.projectEligibility(JSON.parse(JSON.stringify(s)));
  for (const it of s.items) assert.deepStrictEqual([...B.eligibleSet(pb, it.key)].sort(), [...E.eligibleSet(pn, it.key)].sort(), `UMD-4 ${rid}/${it.key}: the browser load answers exactly as Node`);
}
ok('as a classic script it answers exactly as under Node, for every item of both real sources');
console.log(`\nextras-eligibility-umd: OK (${n})`);
