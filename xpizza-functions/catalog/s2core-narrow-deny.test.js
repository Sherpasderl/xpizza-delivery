'use strict';
// S2-core (PLAN-structure-S2core-r3 §4, ruling R3; Codex r2 «narrow against the groups the emitted maps offer») — the eligibility
// document's public_deny lists, per dish, only the ineligible extras INSIDE the groups the served maps offer that dish (its category's
// list + its item list). The capp filters to those groups first, so it renders EXACTLY the same extras as with the dense complement;
// the document stops growing as dishes × extras. Through the REAL builder, the REAL doc builder and the REAL capp reader, on both brands
// plus a typed checklist deny and a dish-level detach. Run: node catalog/s2core-narrow-deny.test.js
const assert = require('assert');
const path = require('path');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildEligibilityDoc } = require('./extras-eligibility-store');
const { projectEligibility, publicDeny } = require('./extras-eligibility');
const { composeServedMenu } = require('./public-menu');
const { adaptMenu } = require(path.join(__dirname, '..', '..', 'customer-app/capp-menu.js'));
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const cases = [
  ['x_pizza', (s) => s],
  ['la_musa', (s) => s],
  ['x_pizza + checklist deny', (s) => { s.structure.exposure.item_overrides.Margherita = { deny_extras: ['Salsa Roja'] }; return s; }],
  ['x_pizza + detach Carnes', (s) => { s.structure.exposure.item_overrides.Margherita = { deny: ['Carnes'] }; return s; }],
  ['la_musa + checklist deny', (s) => { s.structure.exposure.item_overrides.rice_02 = { ...(s.structure.exposure.item_overrides.rice_02 || {}), deny_extras: ['rice_white'] }; return s; }],
];
for (const [label, mutate] of cases) {
  const rid = label.split(' ')[0];
  const src = mutate(buildSourceFromCode(rid));
  const built = buildSourceCandidate(rid, src).built;
  const doc = buildEligibilityDoc({ items: built.items, extras: built.extras, structure: built.structure });
  const dense = publicDeny(projectEligibility({ items: built.items, extras: built.extras, structure: built.structure }));
  const body = composeServedMenu(rid, { items: built.items, structure: built.structure, extras: built.extras });
  const lists = (deny) => { const m = adaptMenu({ rid, representation_version: 1, menu: { ...body, extras_eligibility: { version: 1, deny } } }); return m.dishes.map((d) => JSON.stringify(m.extrasFor(d.key).map((e) => e.key))); };
  cell(`DENY-NARROW-SAME-LISTS ${label}: the REAL capp renders identical extras for every dish, dense vs narrowed`, (L) => {
    assert.deepStrictEqual(lists(doc.public_deny), lists(dense), L);
  });
  cell(`DENY-NARROW-ONLY-OFFERED ${label}: every listed extra is in a group the served maps offer that dish`, (L) => {
    const groupOf = new Map(built.extras.map((e) => [e.key, e.display.cat]));
    for (const it of built.items) {
      const offered = new Set([...((body.extras_by_category || {})[it.display.cat] || []), ...((body.extras_by_item || {})[String(it.display.id)] || [])]);
      for (const k of (doc.public_deny[it.key] || [])) assert.ok(offered.has(groupOf.get(k)), `${L}: ${it.key} lists ${k} (group ${groupOf.get(k)}) outside its offered groups`);
    }
    assert.ok(JSON.stringify(doc.public_deny).length <= JSON.stringify(dense).length, `${L}: never larger than the dense complement`);
  });
}
if (fails.length) { console.log(`s2core-narrow-deny FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`s2core-narrow-deny: OK (${n})`);
