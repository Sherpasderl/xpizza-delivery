'use strict';
// GATE 0 baseline audit (tools/extras-baseline-audit.js). Run: node tools/extras-baseline-audit.test.js
const assert = require('assert');
const { audit } = require('./extras-baseline-audit');
const { buildSourceFromCode } = require('./seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

{ // today's code-seeded sources: exactly the two known rules
  const xp = audit(buildSourceFromCode('x_pizza'));
  assert.deepStrictEqual(xp.legacyDeny, [{ item: 'Nutella', deny: ['*'] }]);
  assert.deepStrictEqual(xp.migrationNeeded, [{ item: 'Nutella', from: "deny:['*']", to: "extras_policy:'none'" }], 'Nutella is the one migration');
  const lm = audit(buildSourceFromCode('la_musa'));
  assert.deepStrictEqual(lm.legacyAdd, [{ item: 'rice_03', add: ['Proteínas'] }]);
  for (const r of [xp, lm]) for (const f of ['variantOverrides', 'groupPolicyMismatch', 'keyCategoryCollisions', 'ambiguousLegacySelectors', 'variantSetDiffers']) assert.deepStrictEqual(r[f], [], `${f} empty today`);
  ok('code-seeded: x_pizza Nutella deny "*" (→ migration), la_musa rice_03 add Proteínas; no variant overrides, collisions or ambiguities');
}
{ // every finding kind is reported (sensitivity)
  const s = buildSourceFromCode('la_musa');
  s.extras.push({ key: 'Salsas', price: 5, display: { id: 'Salsas', cat: 'Acompañamientos', name: 'Salsas', price: 5 } });   // key == a category
  const ov = s.structure.exposure.item_overrides;
  ov.noodle_01_pollo = { add: ['Proteínas'] };                       // a VARIANT override
  ov.rice_01 = { deny: ['Salsas'] };                                 // an ambiguous legacy selector (category AND key)
  s.items.find((i) => i.key === 'noodle_01_sin').display.extras_policy = 'none';   // a group policy mismatch
  const r = audit(s);
  assert.deepStrictEqual(r.keyCategoryCollisions, ['Salsas']);
  assert.deepStrictEqual(r.variantOverrides.map((v) => v.variant), ['noodle_01_pollo']);
  assert.deepStrictEqual(r.ambiguousLegacySelectors, [{ item: 'rice_01', selector: 'Salsas' }]);
  assert.deepStrictEqual(r.groupPolicyMismatch, [{ variant: 'noodle_01_sin', launcher: 'noodle_01' }]);
  assert.ok(r.variantSetDiffers.some((v) => v.variant === 'noodle_01_pollo'), 'a variant whose set differs from its launcher’s');
  ok('sensitivity: a key/category collision, a variant override, an ambiguous legacy selector, a group policy mismatch and a differing variant set are each reported');
}
console.log(`\nextras-baseline-audit: OK (${n})`);
