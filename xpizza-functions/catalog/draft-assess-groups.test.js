'use strict';
// 1D add-product B (PB-3) — getEditableCatalog's assessment of a SAVED draft judges a saved, unpublished required-choice
// group by the SAME platform authoring switch the save was judged by. Without it, the first reload after saving a group
// (switch on) reported draft_unpublishable/choices_not_supported_yet and offered "Volver al menú publicado".
// Run: node catalog/draft-assess-groups.test.js
const assert = require('assert');
const CAPS = { render: true, authoring: false };
{
  const p = require.resolve('./platform-groups');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { groupCapabilities: () => ({ ...CAPS }), parseRender: (m) => m.render } };
}
const A = require('./add-product');
const { assessDraft } = require('./draft-assess');
const { canonicalize, sourceToBuildInputs } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2 } = require('./form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const SRC = { x_pizza: canonicalize(buildSourceFromCode('x_pizza')), la_musa: canonicalize(buildSourceFromCode('la_musa')) };
const MODE = { x_pizza: 'name', la_musa: 'id' };
const CAT = { x_pizza: 'ny', la_musa: 'noodles' };
const build = (rid, src) => { const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras }); return { items: b.items, extras: b.extras, structure: b.structure }; };
const active = (rid) => { const b = build(rid, SRC[rid]); return { built: { items: b.items, structure: b.structure }, extraRecords: b.extras }; };
const L = 'tmp:llllllll-0001'; const V = ['tmp:vvvvvvvv-0001', 'tmp:vvvvvvvv-0002'];

// the SAVED draft: the portal's group, allocated by the real save path (authoring on at save time)
function savedGroup(rid) {
  const s = clone(SRC[rid]);
  s.items.push({ ref: L, price: 624, display: { cat: CAT[rid], name: 'NY Plain Slice', price: 624 } });
  s.structure.item_order.push(L);
  ['Salsa Roja', 'Salsa Vodka'].forEach((ch, i) => { s.items.push({ ref: V[i], price: 624 + i * 20, display: { choice: ch, variantOf: L, price: 624 + i * 20 } }); s.structure.item_order.push(V[i]); });
  s.structure.variant_items = { ...(s.structure.variant_items || {}), [L]: { label: 'Salsa', variantIds: V } };
  return A.allocateAdditions({ incoming: s, stored: SRC[rid], activeItems: SRC[rid].items, keyMode: MODE[rid], hwm: null, registryHasKey: () => false, authoring: true });
}

for (const rid of ['x_pizza', 'la_musa']) {
  const { source, additions } = savedGroup(rid);
  CAPS.authoring = true;
  const on = assessDraft(rid, source, active(rid));
  assert.strictEqual(on.publishable, true, `🔴 ${rid}: switch ON — a saved, unpublished group is publishable (${on.code || ''} ${on.detail || ''})`);
  assert.deepStrictEqual(on.additions.slice().sort(), additions.map((a) => a.key).sort(), `${rid}: every row of the unit is a pending addition (the portal marks them NUEVO / Quitar)`);
  CAPS.authoring = false;
  const off = assessDraft(rid, source, active(rid));
  assert.deepStrictEqual([off.publishable, off.code], [false, 'choices_not_supported_yet'], `${rid}: switch OFF — the same draft is not publishable, as a save would be refused`);
  // a plain draft is unaffected either way
  for (const a of [true, false]) { CAPS.authoring = a; assert.strictEqual(assessDraft(rid, SRC[rid], active(rid)).publishable, true, `${rid}: an unchanged draft is publishable (switch ${a})`); }
}
ok('assessDraft judges a saved group by the platform authoring switch: ON → publishable, every unit row a pending addition; OFF → choices_not_supported_yet; plain drafts unaffected — both brands');

console.log(`\ndraft-assess-groups: OK (${n})`);
