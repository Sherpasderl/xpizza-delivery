'use strict';
// S2-core (PLAN-structure-S2core-r3 §2.2) BUILD STEP 0 — the consumer projection of the extras exposure, proven on TODAY'S sources
// before anything else changes: the derived maps are exactly today's (the advisor-approved delta is the endpoint's
// `extras_by_item: {}` on x_pizza, emitted by the public menu, never by the build), and every dish renders the same groups through
// the REAL form picker (form-group-picker.js offeredExtraGroups) and the REAL capp (capp-menu.js extrasFor).
// Run: node catalog/extras-projection.test.js
const assert = require('assert');
const path = require('path');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { composeServedMenu } = require('./public-menu');
const { projectExtrasMaps } = require('./extras-projection');
const ROOT = path.join(__dirname, '..', '..');
const GP = require(path.join(ROOT, 'xpizza-orders/form-group-picker.js'));
const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));

let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const builtOf = (rid) => buildSourceCandidate(rid, buildSourceFromCode(rid)).built;

for (const rid of ['x_pizza', 'la_musa']) {
  const built = builtOf(rid);
  const today = { byCategory: built.structure.extras_by_category || {}, byItem: built.structure.extras_by_item || {} };
  cell(`P0-MAP-DELTA-EXACT ${rid}: the projection derives today's maps byte-for-byte`, (L) => {
    const got = projectExtrasMaps({ items: built.items, extras: built.extras, structure: built.structure });
    assert.deepStrictEqual(got.byCategory, today.byCategory, `${L}: extras_by_category`);
    assert.deepStrictEqual(got.byItem, today.byItem, `${L}: extras_by_item (keyed by display.id; today's keys are display ids)`);
    assert.strictEqual(JSON.stringify(got.byCategory), JSON.stringify(today.byCategory), `${L}: same key and value ORDER`);
  });
  cell(`P0-RENDER-IDENTICAL ${rid}: every served dish offers the same groups (real form picker) and the same extras (real capp)`, (L) => {
    const menu = { items: built.items, structure: built.structure, extras: built.extras };
    const body = composeServedMenu(rid, menu);
    const got = projectExtrasMaps({ items: built.items, extras: built.extras, structure: built.structure });
    const groups = (bc, bi) => body.dishes.map((d) => JSON.stringify(GP.offeredExtraGroups(d, body.extras, bc, bi)));
    assert.deepStrictEqual(groups(got.byCategory, got.byItem), groups(today.byCategory, today.byItem), `${L}: form picker`);
    const capp = (bc, bi) => { const m = adaptMenu({ rid, representation_version: 1, menu: { ...body, extras_by_category: bc, extras_by_item: bi } }); return m.dishes.map((d) => JSON.stringify(m.extrasFor(d.key).map((e) => e.key))); };
    assert.deepStrictEqual(capp(got.byCategory, got.byItem), capp(today.byCategory, today.byItem), `${L}: capp extrasFor`);
  });
}

if (fails.length) { console.log(`extras-projection FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`extras-projection: OK (${n})`);
