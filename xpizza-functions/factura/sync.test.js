/**
 * Drift guard: the four factura logic modules here must stay byte-identical to their
 * source of truth in xpizza-factura/src/ (which carries the full unit-test suite).
 * Run: `node factura/sync.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'xpizza-factura', 'src');
const MODULES = ['money.js', 'allocate.js', 'build-record.js', 'factura-helpers.js'];

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

for (const m of MODULES) {
  const here = fs.readFileSync(path.join(__dirname, m), 'utf8');
  const srcPath = path.join(SRC, m);
  assert.ok(fs.existsSync(srcPath), `source missing: ${srcPath}`);
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.equal(here, src, `${m} has drifted from xpizza-factura/src/${m} — re-copy it`);
  ok(`${m} byte-identical to source of truth`);
}

console.log(`\nAll ${pass} sync checks passed.`);
