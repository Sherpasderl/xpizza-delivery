'use strict';
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2) — offline structural guard for /platform_rates:
//   · a NEW top-level node, NOT under `config` (config's .write lets any dispatcher write, and a child .write:false does not
//     revoke an inherited RTDB grant);
//   · .read = signed in, not a customer, not a handheld (drivers + dispatch); .write:false with NO truthy write anywhere beneath
//     and no cascading root grant (the owner CLI writes with the Admin SDK only);
//   · driver_per_delivery/$entry keeps a shape .validate ({cents ≥ 1, effective_from ≥ 0}, no other child) for the record.
// The behavioral twin is test/platform-rates-rules.emulator.test.js.
// Run: node platform-rates-rules.guard.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const node = rules.platform_rates;
assert.ok(node, 'FAIL: top-level /platform_rates rule missing');
assert.ok(!(rules.config && rules.config.platform_rates), 'FAIL: the rate must not live under config (dispatcher-writable)');
assert.strictEqual(node['.read'], 'auth != null && auth.token.customer !== true && auth.token.handheld !== true', 'FAIL: /platform_rates .read must be signed-in, non-customer, non-handheld');
assert.strictEqual(node['.write'], false, 'FAIL: /platform_rates must have .write:false (Admin SDK only)');
(function walk(nd, segs) {
  if (nd === null || typeof nd !== 'object') return;
  for (const [k, v] of Object.entries(nd)) {
    if (k === '.write') assert.strictEqual(v, false, `FAIL: a write grant under platform_rates/${segs.join('/')}`);
    else if (k === '.read' && segs.length) assert.fail(`FAIL: a nested .read under platform_rates/${segs.join('/')} (the top-level read is the only one)`);
    else if (!k.startsWith('.')) walk(v, segs.concat(k));
  }
})(node, []);
assert.ok(!rules['.read'] && !rules['.write'], 'FAIL: a root grant would cascade over /platform_rates');
ok('/platform_rates: top level (not config); .read = signed-in non-customer non-handheld; .write:false, no write grant beneath, no root grant');

const entry = node.driver_per_delivery && node.driver_per_delivery.$entry;
assert.ok(entry && typeof entry['.validate'] === 'string', 'FAIL: driver_per_delivery/$entry needs its shape .validate');
for (const t of ["newData.hasChildren(['cents', 'effective_from'])", "newData.child('cents').isNumber()", "newData.child('cents').val() >= 1", "newData.child('effective_from').isNumber()"]) {
  assert.ok(entry['.validate'].includes(t), `FAIL: the entry .validate lacks ${t}`);
}
assert.strictEqual(entry.$other && entry.$other['.validate'], false, 'FAIL: an entry must reject any child besides cents / effective_from');
ok('driver_per_delivery/$entry: {cents ≥ 1, effective_from ≥ 0} required, any other child rejected (the record of the shape the owner CLI writes)');

console.log(`\nplatform-rates-rules.guard: OK (${n})`);
