'use strict';
// BRAND-AGNOSTIC SERVER B1 (PLAN-brand-agnostic-server r0 §1.3) — OWNER STANDING RULE: ONLY X. Pizza ever issues facturas.
// factura/eligibility's FACTURA_PLATFORM_RESTAURANTS is the authority that tools/identity-factura-flag.js projects onto
// restaurants/{rid}/identity/uses_platform_factura (what dispatch reads). It must equal exactly ['x_pizza'].
// Read in a FRESH process: catalog/portal-reads.test.js mutates the set in-process, so an in-process require could see a
// test's edit instead of the module's own value.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const MOD = path.join(__dirname, 'eligibility.js');
const read = (prelude = '') => {
  const r = spawnSync(process.execPath, ['-e', `${prelude}const m = require(${JSON.stringify(MOD)}); process.stdout.write(JSON.stringify([...m.FACTURA_PLATFORM_RESTAURANTS]) + '\\n');`], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, `could not load ${MOD}: ${r.stderr}`);
  // the child's FIRST line only: under the gate the count-marks preload reaches children too and appends a ##CELLS trailer
  return JSON.parse(r.stdout.split('\n')[0]);
};
const check = (members) => assert.deepStrictEqual(members, ['x_pizza'],
  'FAIL: FACTURA_PLATFORM_RESTAURANTS must be exactly {x_pizza} — OWNER STANDING RULE: only X. Pizza issues facturas. '
  + 'Changing it needs the owner, then the re-projection runbook: node tools/identity-factura-flag.js --project <id> (dry run), '
  + '--apply, and a read-back of every identity.');

check(read());

// non-vacuity: the same check, fed a two-member set from a fresh process that adds one, FAILS
const two = read(`const m0 = require(${JSON.stringify(MOD)}); m0.FACTURA_PLATFORM_RESTAURANTS.add('tb_centro');`);
assert.deepStrictEqual(two, ['x_pizza', 'tb_centro'], 'the probe saw the added member');
assert.throws(() => check(two), /OWNER STANDING RULE/, 'a two-member set must fail the guard');
assert.throws(() => check([]), /OWNER STANDING RULE/, 'an empty set must fail the guard');

console.log('factura-authority.guard: OK (FACTURA_PLATFORM_RESTAURANTS === {x_pizza} in a fresh process; a two-member / empty set fails)');
