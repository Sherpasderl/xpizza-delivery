'use strict';
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2) — offline structural guard for /platform_rates:
//   · a NEW top-level node, NOT under `config` (config's .write lets any dispatcher write, and a child .write:false does not
//     revoke an inherited RTDB grant);
//   · .read = signed in, not a customer, not a handheld (drivers + dispatch); .write:false with NO truthy write anywhere beneath
//     and no cascading root grant (the owner CLI writes with the Admin SDK only);
//   · driver_per_delivery/$entry .validate mirrors pay-rate.js's ONE bounds contract (integer cents MIN_CENTS–MAX_CENTS, integer
//     effective_from ≥ MIN_EFFECTIVE_FROM and ≤ now + MAX_AHEAD_MS), no other child — every bound derived from pay-rate.js, and
//     identical in the f2-narrow copies. (The Admin SDK bypasses .validate; the owner CLI is the real gate.)
// The behavioral twin is test/platform-rates-rules.emulator.test.js.
// Run: node platform-rates-rules.guard.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const P = require('./pay-rate');

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
const WANT = "newData.hasChildren(['cents', 'effective_from'])"
  + " && newData.child('cents').isNumber() && newData.child('cents').val() % 1 === 0"
  + ` && newData.child('cents').val() >= ${P.MIN_CENTS} && newData.child('cents').val() <= ${P.MAX_CENTS}`
  + " && newData.child('effective_from').isNumber() && newData.child('effective_from').val() % 1 === 0"
  + ` && newData.child('effective_from').val() >= ${P.MIN_EFFECTIVE_FROM} && newData.child('effective_from').val() <= now + ${P.MAX_AHEAD_MS}`;
assert.strictEqual(entry['.validate'], WANT, 'FAIL: the entry .validate is not exactly pay-rate.js\'s bounds contract (integer cents MIN–MAX, integer effective_from ≥ MIN_EFFECTIVE_FROM and ≤ now + MAX_AHEAD_MS)');
assert.strictEqual(entry.$other && entry.$other['.validate'], false, 'FAIL: an entry must reject any child besides cents / effective_from');
for (const f of ['N-human', 'N-full']) {
  const nr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'f2-narrow', `${f}.rules.json`), 'utf8')).rules;
  assert.deepStrictEqual(nr.platform_rates, node, `FAIL: f2-narrow/${f}.rules.json platform_rates differs from the reference (run tools/f2-narrow-rules.js --write)`);
}
ok(`driver_per_delivery/$entry: exactly pay-rate.js's bounds (integer cents ${P.MIN_CENTS}–${P.MAX_CENTS}, integer effective_from ≥ ${P.MIN_EFFECTIVE_FROM} and ≤ now + ${P.MAX_AHEAD_MS}), any other child rejected; mirrored in both f2-narrow copies`);

console.log(`\nplatform-rates-rules.guard: OK (${n})`);
