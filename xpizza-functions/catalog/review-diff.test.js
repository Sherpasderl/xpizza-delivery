'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.6; T17, T18, T24) — THE ONE canonical review diff, reviewDiff(), over the REAL builder and
// the REAL writer (exposure-transitions + extras-allocate):
//   OLD-FORMAT-EQUAL   every edit kind possible today → byte-identical to today's fold (catalogDiff + the textEdit-on consequences),
//                      switch ON or OFF, and a token issued over today's diff verifies over the canonical one
//   S2 ops             extras are NEVER paired as renames; the extras section lists {key, name, group, price, change}; the group
//                      order change is listed; the seal (`fiscal`) lists every new priced item / extra and every repriced one, once
// Run: node catalog/review-diff.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);   // set BEFORE require (catalog-edit.test.js)
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { catalogDiff, issueEditToken, verifyEditToken, sha256 } = require('./catalog-edit');
const { withConsequences } = require('./extras-consequences');
const { allocateExtras } = require('./extras-allocate');
const XT = require('./exposure-transitions');
const { reviewDiff } = require('./review-diff');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

// the shapes the save builds (edit-catalog-handler.js:182-183): the diff side carries the price TABLE, the records ride beside it
const sides = (rid, src) => { const { inputs, built } = buildSourceCandidate(rid, src); return { diffSide: { ...built, extras: inputs.extras }, records: built.extras }; };
const allocated = (rid, src) => { const live = buildSourceFromCode(rid); return allocateExtras({ incoming: src, activeExtras: live.extras, activeItems: live.items, keyMode: src.key_mode, switchOn: true }).source; };
const today = (L, D) => withConsequences(catalogDiff(L.diffSide, D.diffSide), { live: L.diffSide, liveExtraRecords: L.records, draftBuilt: D.diffSide, draftExtraRecords: D.records });
const canon = (L, D, extrasCatalog) => reviewDiff({ live: L.diffSide, liveExtraRecords: L.records, draftBuilt: D.diffSide, draftExtraRecords: D.records, extrasCatalog });

const TODAY_EDITS = {
  'item price': (s) => { s.items[0].price += 5; s.items[0].display.price = s.items[0].price; },
  'extra price': (s) => { s.extras[0].price += 1; s.extras[0].display.price = s.extras[0].price; },
  'item text': (s) => { s.items[1].display.desc = 'Nueva descripción'; },
  'item deletion': (s) => { const k = s.items.find((i) => i.display.variantOf == null && !s.items.some((o) => String(o.display.variantOf) === String(i.display.id))).key; s.items = s.items.filter((i) => i.key !== k); s.structure.item_order = (s.structure.item_order || []).filter((x) => x !== k); for (const f of ['redeem_eligible_items']) if (Array.isArray(s.structure[f])) s.structure[f] = s.structure[f].filter((x) => x !== k); },
  'category name': (s) => { s.structure.categories[0].name = `${s.structure.categories[0].name} Nuevo`; },
  // Codex build r1 P2-7: an S1 «Sin extras» toggle and an ordinary section move change which groups a dish is offered, yet are NOT
  // Extras-page ops — today's diff, byte for byte, with the switch ON
  'S1 extras_policy none': (s) => { const d = s.items.find((i) => i.display.variantOf == null && i.display.extras_policy !== 'none' && !s.items.some((o) => String(o.display.variantOf) === String(i.display.id))); d.display.extras_policy = 'none'; },
  'section move': (s) => { const cats = s.structure.categories.map((c) => c.id); const d = s.items.find((i) => i.display.variantOf == null && !s.items.some((o) => String(o.display.variantOf) === String(i.display.id)) && !i.display.subcat); d.display.cat = cats.find((c) => c !== d.display.cat && s.items.some((o) => o.display.cat === c && !o.display.subcat)); },
  'S1 deny_extras': (s) => { const d = s.items.find((i) => i.display.variantOf == null && i.display.extras_policy !== 'none' && XT.effectiveGroups(require('./extras-eligibility').projectEligibility(s))[i.key]?.length); const g = XT.effectiveGroups(require('./extras-eligibility').projectEligibility(s))[d.key][0]; const k = s.extras.find((e) => e.display.cat === g).key; s.structure.exposure.item_overrides[d.key] = { ...(s.structure.exposure.item_overrides[d.key] || {}), deny_extras: [k] }; },
};

for (const rid of ['x_pizza', 'la_musa']) {
  const L = sides(rid, buildSourceFromCode(rid));
  for (const [kind, edit] of Object.entries(TODAY_EDITS)) {
    cell(`OLD-FORMAT-EQUAL ${rid} «${kind}»: the canonical diff is today's fold byte for byte (switch ON and OFF); today's token verifies`, (Lb) => {
      const s = buildSourceFromCode(rid); edit(s);
      const D = sides(rid, s);
      const old = today(L, D);
      for (const on of [false, true]) assert.strictEqual(JSON.stringify(canon(L, D, on)), JSON.stringify(old), `${Lb}: switch ${on ? 'ON' : 'OFF'}`);
      const state = { rid, baseActiveVersionId: 'v1', sourceUpdateTime: 't1', sourceHash: sha256(s) };
      const tok = issueEditToken({ ...state, diff: old });
      assert.ok(verifyEditToken(tok, { ...state, diff: canon(L, D, true) }).ok, `${Lb}: a pre-deploy token verifies`);
    });
  }
}

cell('S2-EXTRAS-NEVER-PAIRED la_musa (T18): a removed extra and a new one at the same price stay a removal and an addition', (Lb) => {
  const s0 = buildSourceFromCode('la_musa');
  const gone = s0.extras.find((e) => e.display.cat === 'Salsas');
  let s = XT.apply(s0, { op: 'extra.remove', key: gone.key }).source;
  s = XT.apply(s, { op: 'extra.add', group: 'Salsas', ref: 'tmp:new-salsa-1', name: 'Salsa Nueva', price: gone.price }).source;
  s = allocated('la_musa', s);
  const L = sides('la_musa', buildSourceFromCode('la_musa')); const D = sides('la_musa', s);
  const old = today(L, D);
  assert.ok(old.renamed.some((r) => r.surface === 'extra'), `${Lb}: premise — today's fold pairs them as a rename`);
  const d = canon(L, D, true);
  assert.ok(!d.renamed.some((r) => r.surface === 'extra'), `${Lb}: never paired`);
  assert.ok(d.removed.some((r) => r.surface === 'extra' && r.key === gone.key), `${Lb}: removal listed`);
  assert.ok(d.added.some((r) => r.surface === 'extra' && r.key === 'salsa_nueva'), `${Lb}: addition listed`);
  assert.ok(d.largeChangeSet.some((r) => r.surface === 'extra' && r.key === 'salsa_nueva' && r.reason === 'new_priced'), `${Lb}: the new-price acknowledgment never drops an extra`);
  assert.deepStrictEqual(d.extras, [
    { key: gone.key, name: gone.display.name, group: 'Salsas', price: gone.price, change: 'removed' },
    { key: 'salsa_nueva', name: 'Salsa Nueva', group: 'Salsas', price: gone.price, change: 'added' },
  ], `${Lb}: the extras section`);
});

cell('S2-SEAL x_pizza (T18): fiscal lists the new priced extra and every repriced line, once each', (Lb) => {
  let s = buildSourceFromCode('x_pizza');
  s = XT.apply(s, { op: 'extra.add', group: 'Carnes', ref: 'tmp:new-chorizo-1', name: 'Chorizo', price: 30 }).source;
  s.extras[0].price += 2; s.extras[0].display.price = s.extras[0].price;
  s.items[0].price += 5; s.items[0].display.price = s.items[0].price;
  s = allocated('x_pizza', s);
  const L = sides('x_pizza', buildSourceFromCode('x_pizza')); const D = sides('x_pizza', s);
  const d = canon(L, D, true);
  const base = buildSourceFromCode('x_pizza');
  assert.deepStrictEqual(d.fiscal, {
    added: [{ surface: 'extra', key: 'Chorizo', name: 'Chorizo', price: 30 }],
    repriced: [
      { surface: 'extra', key: base.extras[0].key, name: base.extras[0].display.name, old: base.extras[0].price, new: base.extras[0].price + 2 },
      { surface: 'item', key: base.items[0].key, name: base.items[0].display.name, old: base.items[0].price, new: base.items[0].price + 5 },
    ],
  }, `${Lb}: the seal`);
  assert.ok(d.extras.some((x) => x.key === base.extras[0].key && x.change === 'repriced' && x.price === base.extras[0].price + 2), `${Lb}: the repriced extra row`);
});

cell('S2-GROUP-ORDER x_pizza: a group order change is the structure section; nothing else appears', (Lb) => {
  const s = XT.apply(buildSourceFromCode('x_pizza'), { op: 'group.order', order: [...buildSourceFromCode('x_pizza').structure.extra_categories].reverse() }).source;
  const L = sides('x_pizza', buildSourceFromCode('x_pizza')); const D = sides('x_pizza', s);
  const d = canon(L, D, true);
  assert.deepStrictEqual(d.structure, { extra_categories: { old: L.diffSide.structure.extra_categories, new: s.structure.extra_categories } }, `${Lb}: listed`);
  assert.deepStrictEqual(d.fiscal, { added: [], repriced: [] }, `${Lb}: nothing to seal`);
  assert.strictEqual(JSON.stringify(canon(L, D, false)), JSON.stringify(today(L, D)), `${Lb}: switch OFF is today's diff`);
});

cell('S2-DETACH la_musa: an attach / detach reaches the review as consequences (ungated) with the S2 fields', (Lb) => {
  const s = XT.apply(buildSourceFromCode('la_musa'), { op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }).source;
  const L = sides('la_musa', buildSourceFromCode('la_musa')); const D = sides('la_musa', s);
  const d = canon(L, D, true);
  assert.deepStrictEqual(d.consequences, [{ key: 'dimsum_01', kind: 'extras', gained: [], lost: ['Salsas'] }], `${Lb}: consequences`);
  assert.deepStrictEqual(d.extras, [], `${Lb}: no extras rows`);
});

// S2 UI plan review (#3): the authored attachment transitions are in the token-bound diff even when they change no effective extra, with
// the authoritative reach («en N productos») of every changed group
cell('S2-ATTACH-ROWS la_musa: detaching «Salsas» from a dish whose Salsas extras are all unticked has no consequence yet is a reviewed row', (Lb) => {
  const s0 = buildSourceFromCode('la_musa');
  s0.structure.exposure.item_overrides.dimsum_01 = { deny_extras: s0.extras.filter((e) => e.display.cat === 'Salsas').map((e) => e.key) };
  const s = XT.apply(s0, { op: 'detach.item', item: 'dimsum_01', group: 'Salsas' }).source;
  const L = sides('la_musa', s0); const D = sides('la_musa', s);
  const d = canon(L, D, true);
  assert.deepStrictEqual(d.consequences || [], [], `${Lb}: premise — no effective consequence`);
  assert.deepStrictEqual(d.attachments, [{ group: 'Salsas', scope: 'item', target: 'dimsum_01', change: 'detached' }], `${Lb}: the row`);
  const P = require('./extras-eligibility').projectEligibility({ items: D.diffSide.items, extras: D.records, structure: D.diffSide.structure });
  const E = XT.effectiveGroups(P); const want = Object.keys(E).filter((k) => !P.items[k].launcherKey && E[k] && E[k].includes('Salsas')).length;
  assert.deepStrictEqual(d.reach, { Salsas: want }, `${Lb}: reach counts the sellable products (launchers once) offered Salsas`);
});
cell('S2-ATTACH-CAT la_musa: a category attach is one category row; reach of the group', (Lb) => {
  const s0 = buildSourceFromCode('la_musa');
  const s = XT.apply(s0, { op: 'attach.cat', cat: 'dim_sum', group: 'Proteínas' }).source;
  const d = canon(sides('la_musa', s0), sides('la_musa', s), true);
  assert.deepStrictEqual(d.attachments, [{ group: 'Proteínas', scope: 'category', target: 'dim_sum', change: 'attached' }], Lb);
  assert.ok(Number.isInteger(d.reach['Proteínas']) && d.reach['Proteínas'] > 1, `${Lb}: reach ${JSON.stringify(d.reach)}`);
});

if (fails.length) { console.log(`review-diff FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`review-diff: OK (${n})`);
