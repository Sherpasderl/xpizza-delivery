'use strict';
// S0 — key mode as per-restaurant DATA (PLAN-portal-item-edit r6 S0; RELAY-key-strategy-config).
// Run: node catalog/key-strategy.test.js
//   1. defaultKeyMode is today's exact rid rule (the frozen fallback for pre-snapshot data).
//   2. Every item-key accessor, with the mode ABSENT, returns exactly what today's rid ternary returns (the no-op),
//      and with the mode PRESENT is driven by it alone — a config-only third restaurant keys by id with no code change.
//   3. A present-but-malformed mode is refused (never silently replaced by the rid default).
//   4. The server stamp still wins over the raw field, under either mode.
//   5. The fiscal fence judges the EFFECTIVE mode: absent on x_pizza passes; id on a platform-factura restaurant refuses.
const assert = require('assert');
const MP = require('../menu-pricing');
const FMS = require('./form-menu-source');
const { rawLegacyKey } = require('./identity-grace');
const { assertFiscalKeyMode } = require('../factura/eligibility');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const ternaryField = (rid) => (rid === 'la_musa' ? 'id' : 'name');   // today's rule, written out independently
const RIDS = ['x_pizza', 'la_musa', 'tb_merch_3', '', undefined, null];
const probe = () => ({ id: 'tb_slug', name: 'TB Name' });

assert.strictEqual(MP.defaultKeyMode('la_musa'), 'id', 'KS-DEFAULT la_musa');
assert.strictEqual(MP.defaultKeyMode('x_pizza'), 'name', 'KS-DEFAULT x_pizza');
for (const rid of RIDS) assert.strictEqual(MP.defaultKeyMode(rid), ternaryField(rid), `defaultKeyMode(${rid})`);
ok('defaultKeyMode is today\'s rid rule for every rid shape (la_musa → id, anything else → name)');

const ACCESSORS = [
  ['itemPricingKey', (o, rid, m) => MP.itemPricingKey(o, rid, m)],
  ['extraPricingKey', (o, rid, m) => MP.extraPricingKey(o, rid, m)],
  ['pricingKeyOf', (o, rid, m) => FMS.pricingKeyOf(rid, o, m)],
  ['extrasKeyOf', (o, rid, m) => FMS.extrasKeyOf(rid, o, m)],
  ['rawLegacyKey', (o, rid, m) => rawLegacyKey(rid, o, m)],
];
for (const [name, f] of ACCESSORS) {
  for (const rid of RIDS) {
    const today = probe()[ternaryField(rid)];
    assert.strictEqual(f(probe(), rid), today, `${name}(${rid}) with the mode absent is today's key`);
    assert.strictEqual(f(probe(), rid, undefined), today, `${name}(${rid}, undefined)`);
    assert.strictEqual(f(probe(), rid, null), today, `${name}(${rid}, null)`);
    assert.strictEqual(f(probe(), rid, MP.defaultKeyMode(rid)), today, `${name}(${rid}, default)`);
    assert.strictEqual(f(probe(), rid, 'id'), 'tb_slug', `${name}(${rid}, 'id')`);
    assert.strictEqual(f(probe(), rid, 'name'), 'TB Name', `${name}(${rid}, 'name')`);
  }
  for (const bad of ['ID', 'Name', '', 0, 1, true, {}, ['id'], 'slug']) {
    assert.throws(() => f(probe(), 'x_pizza', bad), /key_mode_invalid/, `${name}: a malformed mode ${JSON.stringify(bad)} is refused`);
  }
  ok(`${name}: absent mode = today's key on every rid; a present mode alone decides; a malformed mode is refused`);
}
for (const rid of RIDS) {
  assert.strictEqual(MP.availIdentityField(rid), ternaryField(rid));
  assert.strictEqual(MP.availIdentityField(rid, 'id'), 'id');
  assert.strictEqual(MP.availIdentityField(rid, 'name'), 'name');
}
assert.throws(() => MP.availIdentityField('x_pizza', 'ID'), /key_mode_invalid/);
ok('availIdentityField: absent = today; present decides; malformed refused');

// null-safety exactly as before: extras accessors and the raw copy tolerate a missing node; pricingKeyOf never did.
for (const m of [undefined, 'id', 'name']) {
  assert.strictEqual(MP.extraPricingKey(null, 'la_musa', m), null);
  assert.strictEqual(FMS.extrasKeyOf('x_pizza', undefined, m), undefined);
  assert.strictEqual(rawLegacyKey('la_musa', null, m), null);
  assert.throws(() => FMS.pricingKeyOf('x_pizza', null, m), TypeError);
}
ok('null handling of each accessor is unchanged under every mode');

{
  const stamped = { id: 'tb_slug', name: 'TB Name', [MP.PRICING_KEY_STAMP]: 'tb_stamped' };
  for (const m of [undefined, 'id', 'name']) assert.strictEqual(MP.itemPricingKey(stamped, 'x_pizza', m), 'tb_stamped');
  for (const m of [undefined, 'id', 'name']) assert.strictEqual(rawLegacyKey('x_pizza', stamped, m), probe()[m || 'name'], 'the raw copy never sees the stamp');
  ok('the server stamp still wins in itemPricingKey under every mode; the raw copy stays stamp-blind');
}

{
  // R4 — the raw copy is pinned to the money accessor under BOTH modes (and the default), and the grace walk keys by the mode
  const { occurrences } = require('./identity-grace');
  for (const rid of ['x_pizza', 'la_musa', 'tb_merch_3']) for (const m of [undefined, 'id', 'name']) {
    assert.strictEqual(rawLegacyKey(rid, probe(), m), MP.itemPricingKey(probe(), rid, m), `pin ${rid}/${m}`);
  }
  const items = [{ id: 'tb_slug', name: 'TB Name', dish_id: 'd1', extras: [{ id: 'tb_x', name: 'TB X', extra_id: 'e1' }] }];
  assert.deepStrictEqual(occurrences('tb_merch_3', items, 'id').map((o) => o.raw), ['tb_slug', 'tb_x'], 'KS-GRACE the walk keys by the mode');
  assert.deepStrictEqual(occurrences('tb_merch_3', items).map((o) => o.raw), ['TB Name', 'TB X'], 'no mode = today');
  ok('rawLegacyKey is pinned to itemPricingKey under both modes; the grace walk keys by the mode');
}

assert.doesNotThrow(() => assertFiscalKeyMode('x_pizza', undefined), 'a pre-snapshot x_pizza version (mode absent) passes');
assert.doesNotThrow(() => assertFiscalKeyMode('x_pizza', 'name'));
assert.throws(() => assertFiscalKeyMode('x_pizza', 'id'), /fiscal_key_mode_unsupported/, 'KS-FENCE an id mode on a platform-factura restaurant is refused');
assert.throws(() => assertFiscalKeyMode('x_pizza', 'ID'), /key_mode_invalid/);
for (const m of [undefined, 'id', 'name']) assert.doesNotThrow(() => assertFiscalKeyMode('la_musa', m), 'not a platform-factura restaurant');
assert.doesNotThrow(() => assertFiscalKeyMode('tb_merch_3', 'id'));
ok('fiscal fence: effective mode — absent passes on x_pizza, id refuses on a platform-factura restaurant, others untouched');

console.log(`\nkey-strategy: OK (${n})`);
