'use strict';
// S2-core (PLAN-structure-S2core-r3 §3.2, §3.3; T6, T19, T22, T23) — THE Extras-page writer: every group / extra op is a
// transition on the EFFECTIVE exposure (the eligibleExtras group level), writes the minimal source change and normalizes.
// Over the REAL sources (buildSourceFromCode), read back through the REAL eligibility evaluator and the REAL build
// (buildSourceCandidate — validateSource refuses a residual reference). Run: node catalog/exposure-transitions.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const EE = require('./extras-eligibility');
const XT = require('./exposure-transitions');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const groupsOf = (src, k) => XT.effectiveGroups(EE.projectEligibility(src))[k];
const eligible = (src, k) => EE.eligibleExtras(EE.projectEligibility(src), k);
const keysOf = (src, g) => src.extras.filter((e) => e.display.cat === g).map((e) => e.key);
// the save's own order (edit-catalog-handler): allocate the new extras (extras-allocate), validateSource, build, assertBuiltValid
const { allocateExtras } = require('./extras-allocate');
const { validateSource } = require('./source-store');
const { assertBuiltValid } = require('./candidate-validate');
const builds = (rid, src) => {
  const live = buildSourceFromCode(rid);
  const c = allocateExtras({ incoming: src, activeExtras: live.extras, activeItems: live.items, keyMode: src.key_mode, switchOn: true }).source;
  validateSource(c, rid);
  const built = buildSourceCandidate(rid, c).built;
  assertBuiltValid(rid, built, `${rid} (test save)`);
  return built;
};
const refused = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return; } assert.fail(`not refused (${code})`); };
const ov = (src, k) => (src.structure.exposure.item_overrides || {})[k];

cell('XT-ATTACH-ITEM la_musa: dimsum_01 + «Proteínas» — offered, every extra of it eligible, the minimal add', (L) => {
  const s = buildSourceFromCode('la_musa');
  const t = XT.apply(s, { op: 'attach.item', item: 'dimsum_01', group: 'Proteínas' }).source;
  assert.ok(groupsOf(t, 'dimsum_01').includes('Proteínas'), `${L}: offered`);
  const stale = clone(s); stale.structure.exposure.item_overrides.dimsum_01 = { deny_extras: [keysOf(s, 'Proteínas')[0]] };   // a stale unticked extra of the group
  const t2 = XT.apply(stale, { op: 'attach.item', item: 'dimsum_01', group: 'Proteínas' }).source;
  assert.deepStrictEqual(eligible(t2, 'dimsum_01'), eligible(t, 'dimsum_01'), `${L}: attach starts the group ALL CHECKED (a stale unticked extra is cleared)`);
  for (const k of keysOf(t, 'Proteínas')) assert.ok(eligible(t, 'dimsum_01').includes(k), `${L}: ${k} eligible`);
  assert.deepStrictEqual(ov(t, 'dimsum_01'), { add: ['Proteínas'] }, `${L}: minimal write`);
  assert.ok(!ov(s, 'dimsum_01'), `${L}: the input is not mutated`);
  builds('la_musa', t);
});

cell('XT-DETACH-ITEM la_musa: dimsum_01 − «Salsas» (category origin) → deny; − «Proteínas» on rice_03 (add origin) → the add goes, the override with it', (L) => {
  const s = buildSourceFromCode('la_musa');
  const t = XT.apply(s, { op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }).source;
  assert.ok(!groupsOf(t, 'dimsum_01').includes('Salsas'), `${L}: not offered`);
  assert.deepStrictEqual(ov(t, 'dimsum_01'), { deny: ['Salsas'] }, `${L}: deny written`);
  const u = XT.apply(s, { op: 'detach.item', item: 'rice_03', group: 'Proteínas' }).source;
  assert.ok(!groupsOf(u, 'rice_03').includes('Proteínas'), `${L}: rice_03 loses Proteínas`);
  assert.strictEqual(ov(u, 'rice_03'), undefined, `${L}: an override left empty is deleted (source-store :456)`);
  builds('la_musa', t); builds('la_musa', u);
});

cell('XT-REATTACH-RESTORES la_musa (T22): detach → reattach restores the group ALL CHECKED on a plain dish and on a launcher with options', (L) => {
  const s = buildSourceFromCode('la_musa');
  s.structure.exposure.item_overrides.dimsum_01 = { deny_extras: [keysOf(s, 'Salsas')[0]] };   // the S1 checklist unticked one
  s.structure.exposure.item_overrides.noodle_01 = { deny_extras: [keysOf(s, 'Salsas')[1]] };
  const base = buildSourceFromCode('la_musa');
  for (const d of ['dimsum_01', 'noodle_01']) {
    const off = XT.apply(s, { op: 'detach.item', item: d, group: 'Salsas' }).source;
    assert.ok(!(ov(off, d).deny_extras || []).length, `${L}: ${d} detach drops the moot checklist`);
    const on = XT.apply(off, { op: 'attach.item', item: d, group: 'Salsas' }).source;
    assert.deepStrictEqual(eligible(on, d), eligible(base, d), `${L}: ${d} all checked again`);
    builds('la_musa', on);
  }
  const off = XT.apply(s, { op: 'detach.item', item: 'noodle_01', group: 'Salsas' }).source;
  for (const o of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) assert.ok(!groupsOf(off, o).includes('Salsas'), `${L}: option ${o} follows its launcher`);
  const on = XT.apply(off, { op: 'attach.item', item: 'noodle_01', group: 'Salsas' }).source;
  for (const o of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) assert.deepStrictEqual(eligible(on, o), eligible(base, o), `${L}: option ${o} restored`);
  assert.ok(!['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'].some((o) => ov(on, o)), `${L}: options never get overrides of their own`);
});

cell('XT-ATTACH-CAT-CLEARS la_musa (T23): attach.cat over prior per-dish denies and unticked extras clears them all', (L) => {
  const s = buildSourceFromCode('la_musa');
  const t0 = XT.apply(s, { op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }).source;
  t0.structure.exposure.item_overrides.dimsum_02 = { deny_extras: [keysOf(s, 'Salsas')[0]] };
  const t = XT.apply(t0, { op: 'attach.cat', cat: 'dim_sum', group: 'Salsas' }).source;
  for (const d of ['dimsum_01', 'dimsum_02']) assert.deepStrictEqual(eligible(t, d), eligible(s, d), `${L}: ${d} all checked`);
  assert.ok(!ov(t, 'dimsum_01') && !ov(t, 'dimsum_02'), `${L}: the emptied overrides are deleted`);
  const u = XT.apply(s, { op: 'attach.cat', cat: 'dim_sum', group: 'Proteínas' }).source;
  assert.deepStrictEqual(u.structure.exposure.category_allow.dim_sum, ['Acompañamientos', 'Salsas', 'Proteínas'], `${L}: allow in the one group order`);
  builds('la_musa', t); builds('la_musa', u);
});

for (const rid of ['x_pizza', 'la_musa']) {
  cell(`XT-CREATE-MODES ${rid} (T19): «A toda una categoría» / «A productos que elija» / «Todavía a ninguno»`, (L) => {
    const s = buildSourceFromCode(rid);
    const cat = Object.keys(s.structure.exposure.category_allow)[0];
    const dish = s.items.find((i) => i.display.cat === cat && i.display.variantOf == null && i.display.extras_policy !== 'none').key;
    const first = { ref: 'tmp:group-new-1', name: 'Extra Del Grupo', price: 15 };
    const mk = (attach) => XT.apply(s, { op: 'group.create', group: 'Grupo Nuevo', extras: [first], attach }).source;
    const a = mk({ mode: 'cat', cat });
    assert.deepStrictEqual(a.structure.extra_categories, [...s.structure.extra_categories, 'Grupo Nuevo'], `${L}: appended to the group order`);
    assert.deepStrictEqual(a.extras[a.extras.length - 1], { ref: 'tmp:group-new-1', price: 15, display: { name: 'Extra Del Grupo', cat: 'Grupo Nuevo', price: 15 } }, `${L}: the allocator's input shape`);
    assert.ok(a.structure.exposure.category_allow[cat].includes('Grupo Nuevo'), `${L}: category mode`);
    const b = mk({ mode: 'items', items: [dish] });
    assert.deepStrictEqual(ov(b, dish).add, ['Grupo Nuevo'], `${L}: items mode attaches the chosen dish`);
    assert.ok(!b.structure.exposure.category_allow[cat].includes('Grupo Nuevo'), `${L}: items mode leaves the category`);
    const c = mk({ mode: 'none' });
    assert.deepStrictEqual(c.structure.exposure, s.structure.exposure, `${L}: none attaches nothing (m21)`);
    for (const x of [a, b, c]) builds(rid, x);   // each mode passes the save's allocation + validation
    refused(() => XT.apply(s, { op: 'group.create', group: 'Grupo Nuevo', extras: [], attach: { mode: 'none' } }), 'extras_group_empty');
    refused(() => XT.apply(s, { op: 'group.create', group: s.structure.extra_categories[0], extras: [first], attach: { mode: 'none' } }), 'group_name_taken');
  });
}

cell('XT-ORDER x_pizza: group.order sets the one group order and re-derives extra_order group-major', (L) => {
  const s = buildSourceFromCode('x_pizza');
  const order = [...s.structure.extra_categories].reverse();
  const t = XT.apply(s, { op: 'group.order', order }).source;
  assert.deepStrictEqual(t.structure.extra_categories, order, `${L}: extra_categories`);
  const built = builds('x_pizza', t); const catOf = new Map(built.extras.map((e) => [e.key, e.display.cat]));
  assert.deepStrictEqual([...new Set(built.structure.extra_order.map((k) => catOf.get(k)))], order, `${L}: the build's extra_order is group-major`);
  refused(() => XT.apply(s, { op: 'group.order', order: order.slice(1) }), 'structure_changed');
});

cell('XT-REMOVE-CLOSURE la_musa (T6): extra.remove closes every reference in the same draft and names its identity for the claim', (L) => {
  const s = buildSourceFromCode('la_musa');
  s.extras.forEach((e, i) => { e.display.identity_id = `xid_${i}`; });
  s.structure.exposure.item_overrides.dimsum_01 = { deny_extras: ['rice_white'] };
  s.structure.exposure.item_overrides.dimsum_02 = { add: ['rice_white'] };
  const id = s.extras.find((e) => e.key === 'rice_white').display.identity_id;
  const r = XT.apply(s, { op: 'extra.remove', key: 'rice_white' });
  assert.ok(!r.source.extras.some((e) => e.key === 'rice_white'), `${L}: row`);
  assert.ok(!(r.source.structure.extra_order || []).includes('rice_white'), `${L}: extra_order`);
  assert.ok(!r.source.structure.redeem_eligible_extras.includes('rice_white'), `${L}: redeem_eligible_extras`);
  assert.ok(!ov(r.source, 'dimsum_01') && !ov(r.source, 'dimsum_02'), `${L}: exposure references closed, empty overrides deleted`);
  assert.deepStrictEqual(r.deletedIds, [id], `${L}: the identity for the reviewed deletion claim`);
  builds('la_musa', r.source);
  const residual = clone(r.source); residual.structure.exposure.item_overrides.dimsum_02 = { add: ['rice_white'] };
  assert.throws(() => builds('la_musa', residual), /references rice_white/, `${L}: a residual reference refuses at save`);
  const fresh = XT.apply(s, { op: 'extra.add', group: 'Salsas', ref: 'tmp:salsa-new-1', name: 'Salsa Nueva', price: 20 }).source;
  const gone = XT.apply(fresh, { op: 'extra.remove', ref: 'tmp:salsa-new-1' });
  assert.deepStrictEqual(gone.source.extras, s.extras, `${L}: add-then-remove before publish is simply gone`);
  assert.deepStrictEqual(gone.deletedIds, [], `${L}: never published, no claim`);
});

cell('XT-REMOVE-LAST la_musa (T8): removing a group\'s last extra is extras_group_empty', () => {
  let s = buildSourceFromCode('la_musa');
  const ks = keysOf(s, 'Proteínas');
  for (const k of ks.slice(1)) s = XT.apply(s, { op: 'extra.remove', key: k }).source;
  refused(() => XT.apply(s, { op: 'extra.remove', key: ks[0] }), 'extras_group_empty');
});

cell('XT-REFUSALS: a legacy option-level override blocks S2 ops on its launcher; a «Sin extras» dish takes no attach; unknown targets', () => {
  const s = buildSourceFromCode('la_musa');
  s.structure.exposure.item_overrides.noodle_01_pollo = { deny: ['Salsas'] };
  refused(() => XT.apply(s, { op: 'detach.item', item: 'noodle_01', group: 'Salsas' }), 'exposure_option_override');
  refused(() => XT.apply(s, { op: 'attach.item', item: 'noodle_01_sin', group: 'Proteínas' }), 'exposure_option_override');
  const x = buildSourceFromCode('x_pizza');
  refused(() => XT.apply(x, { op: 'attach.item', item: 'Nutella', group: 'Carnes' }), 'exposure_dish_no_extras');
  refused(() => XT.apply(x, { op: 'attach.item', item: 'nope', group: 'Carnes' }), 'unknown_item');
  refused(() => XT.apply(x, { op: 'attach.item', item: 'Margherita', group: 'nope' }), 'unknown_group');
  refused(() => XT.apply(x, { op: 'nope' }), 'unknown_op');
});

cell('XT-OPTION-TARGET la_musa: an op naming an option acts on its launcher (the launcher owns the exposure)', (L) => {
  const s = buildSourceFromCode('la_musa');
  const t = XT.apply(s, { op: 'attach.item', item: 'noodle_01_pollo', group: 'Proteínas' }).source;
  assert.deepStrictEqual(ov(t, 'noodle_01'), { add: ['Proteínas'] }, `${L}: written on the launcher`);
  assert.strictEqual(ov(t, 'noodle_01_pollo'), undefined, `${L}: never on the option`);
});

cell('XT-PORTAL-SCRIPT: the same bytes run as the portal\'s classic scripts (ExtrasEligibility global first) and write the same draft', (L) => {
  const vm = require('vm'); const fs = require('fs');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('./extras-eligibility'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(require.resolve('./exposure-transitions'), 'utf8'), ctx);
  assert.strictEqual(typeof ctx.ExposureTransitions.apply, 'function', `${L}: the global`);
  const s = buildSourceFromCode('la_musa');
  const op = { op: 'attach.item', item: 'dimsum_01', group: 'Proteínas' };
  assert.strictEqual(JSON.stringify(ctx.ExposureTransitions.apply(s, op)), JSON.stringify(XT.apply(s, op)), `${L}: same draft`);
});

if (fails.length) { console.log(`exposure-transitions FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`exposure-transitions: OK (${n})`);
