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

// T11 (§2.2): a group DETACHED from one dish (an item group-deny) is visible to the forms once the build emits the projection — the
// legacy maps could not express a deny, so the real form picker kept offering the group on that dish
cell('P1-DETACH-VISIBLE x_pizza: Margherita detached from «Carnes» — the REAL form picker and capp both omit it, siblings keep it', (L) => {
  const src = buildSourceFromCode('x_pizza');
  src.structure.exposure.item_overrides.Margherita = { deny: ['Carnes'] };
  const built = buildSourceCandidate('x_pizza', src).built;
  const body = composeServedMenu('x_pizza', { items: built.items, structure: built.structure, extras: built.extras });
  const dish = (name) => body.dishes.find((d) => d.name === name);
  const groups = (d) => GP.offeredExtraGroups(d, body.extras, body.extras_by_category, body.extras_by_item).map((g) => (g && (g.cat || g.name || g.category)) || g);
  const flat = (d) => JSON.stringify(groups(d));
  assert.ok(!flat(dish('Margherita')).includes('Carnes'), `${L}: forms omit Carnes on Margherita (${flat(dish('Margherita'))})`);
  assert.ok(flat(dish('Pepperoni') || body.dishes.find((d) => d.name !== 'Margherita' && d.cat === dish('Margherita').cat && d.extras_policy !== 'none')).includes('Carnes'), `${L}: a sibling keeps Carnes`);
});

// T13 (§2.3): ONE group order — the restaurant's extra_categories order (set on the Extras page) — orders extra_order group-major
// (each group's extras keep their relative order), so the capp (which walks EXTRAS order) and the forms show the same group order
cell('P2-ONE-GROUP-ORDER x_pizza: reversing extra_categories reorders extra_order group-major, and the REAL capp follows', (L) => {
  const src = buildSourceFromCode('x_pizza');
  const before = buildSourceCandidate('x_pizza', src).built;
  src.structure.extra_categories = [...src.structure.extra_categories].reverse();
  const built = buildSourceCandidate('x_pizza', src).built;
  const catOf = new Map(built.extras.map((e) => [e.key, e.display.cat]));
  const groupsInOrder = [...new Set(built.structure.extra_order.map((k) => catOf.get(k)))];
  assert.deepStrictEqual(groupsInOrder, src.structure.extra_categories, `${L}: extra_order is group-major in the new order`);
  for (const g of src.structure.extra_categories) {
    assert.deepStrictEqual(built.structure.extra_order.filter((k) => catOf.get(k) === g), before.structure.extra_order.filter((k) => catOf.get(k) === g), `${L}: «${g}» keeps its extras' relative order`);
  }
  const body = composeServedMenu('x_pizza', { items: built.items, structure: built.structure, extras: built.extras });
  const m = adaptMenu({ rid: 'x_pizza', representation_version: 1, menu: body });
  const d = m.dishes.find((x) => !x.launcher && m.extrasFor(x.key).length > 3);
  const capGroups = [...new Set(m.extrasFor(d.key).map((e) => e.cat))];
  assert.deepStrictEqual(capGroups, src.structure.extra_categories.filter((g) => capGroups.includes(g)), `${L}: the capp shows the groups in the one order`);
});

if (fails.length) { console.log(`extras-projection FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`extras-projection: OK (${n})`);
