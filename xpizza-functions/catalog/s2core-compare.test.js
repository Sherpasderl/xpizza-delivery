'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.3, §3.3; T3, T6–T8, T21) — compareToActive's EXACT claims for the Extras page, behind the
// extrasCatalog switch (OFF: today's rules, byte for byte):
//   extras added (already allocated) · extras removed — each certified one (identity stamp) named in the reviewed deletion claim
//   (existing_extra_removed otherwise) · extra_order = today's order minus removals plus additions, group-major (no in-group reorder) ·
//   extra_categories reordered or appended (a group emptied → extras_group_empty) · exposure attach / detach (category_allow,
//   item add / deny) — nothing else in it · redeem_eligible_extras: only the removed keys may leave · existing extras: price only.
// Over the REAL builder (buildSourceCandidate), both brands. Run: node catalog/s2core-compare.test.js
const assert = require('assert');
const AP = require('./add-product');
const { buildSourceCandidate } = require('./candidate-validate');
const { rendererContract } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const builtOf = (rid, src) => buildSourceCandidate(rid, src).built;
// the live version carries identity stamps on its records (stamped at activation)
const activeOf = (rid) => { const b = builtOf(rid, buildSourceFromCode(rid)); b.extras.forEach((e, i) => { e.display.identity_id = `xid_${i}`; }); return b; };
const cmp = (rid, src, { on = true, deletedIds = [], active = activeOf(rid) } = {}) => AP.compareToActive({ draftBuilt: builtOf(rid, src), activeBuilt: active,
  draftAuthored: Object.keys(src.structure), renderedCategories: rendererContract(rid).renderedCategories, deletedIds, extrasCatalog: on });
const refused = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return; } assert.fail(`not refused (${code})`); };
const newExtra = (rid, name, cat, price = 15) => (rid === 'la_musa'
  ? { key: name.toLowerCase().replace(/\s+/g, '_'), price, display: { id: name.toLowerCase().replace(/\s+/g, '_'), name, cat, price } }
  : { key: name, price, display: { id: 'e99', name, cat, price } });

for (const rid of ['x_pizza', 'la_musa']) {
  const base = () => { const src = buildSourceFromCode(rid); src.extras.forEach((e, i) => { e.display.identity_id = `xid_${i}`; }); return src; };   // the draft carries the live stamps
  const g0 = base().extras[0].display.cat;
  cell(`SC-ADD ${rid}: an allocated extra added to an existing group passes with the switch ON, refused OFF (today)`, () => {
    const s = base(); s.extras.push(newExtra(rid, 'Nuevo Extra', g0));
    cmp(rid, s);
    refused(() => cmp(rid, s, { on: false }), 'extras_changed');
  });
  cell(`SC-REMOVE-CLAIM ${rid}: a certified extra removed needs its identity in the deletion claim`, () => {
    const s = base(); const gone = s.extras.findIndex((e, i) => i > 0 && e.display.cat === g0) >= 0 ? s.extras.findIndex((e, i) => i > 0 && e.display.cat === g0) : 1;
    const idx = gone; const key = s.extras[idx].key; s.extras.splice(idx, 1);
    if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.filter((k) => k !== key);
    refused(() => cmp(rid, s), 'existing_extra_removed');
    const active = activeOf(rid); const stamp = active.extras.find((e) => e.key === key).display.identity_id;
    cmp(rid, s, { deletedIds: [stamp], active });
  });
  cell(`SC-ORDER ${rid}: an in-group reorder is refused; a group reorder (extra_categories) passes`, () => {
    const s = base(); const inG = s.extras.filter((e) => e.display.cat === g0);
    if (inG.length >= 2) { const a = s.extras.indexOf(inG[0]), b = s.extras.indexOf(inG[1]); [s.extras[a], s.extras[b]] = [s.extras[b], s.extras[a]]; refused(() => cmp(rid, s), 'structure_changed'); }
    const t = base(); t.structure.extra_categories = [...t.structure.extra_categories].reverse();
    cmp(rid, t);
  });
  cell(`SC-GROUP-CREATE ${rid}: a new group with its extra, appended to extra_categories, passes`, () => {
    const s = base(); s.structure.extra_categories = [...s.structure.extra_categories, 'Grupo Nuevo']; s.extras.push(newExtra(rid, 'Extra Del Grupo', 'Grupo Nuevo'));
    cmp(rid, s);
  });
  cell(`SC-GROUP-EMPTY ${rid}: removing every extra of a group is extras_group_empty`, () => {
    const s = base(); const active = activeOf(rid);
    const ids = active.extras.filter((e) => e.display.cat === g0).map((e) => e.display.identity_id);
    const keys = new Set(s.extras.filter((e) => e.display.cat === g0).map((e) => e.key));
    s.extras = s.extras.filter((e) => e.display.cat !== g0);
    s.structure.extra_categories = s.structure.extra_categories.filter((c) => c !== g0);
    if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.filter((k) => !keys.has(k));
    for (const ov of Object.values(s.structure.exposure.category_allow || {})) { const i = ov.indexOf(g0); if (i >= 0) ov.splice(i, 1); }
    refused(() => { try { cmp(rid, s, { deletedIds: ids, active }); } catch (e) { if (e.code) throw e; throw Object.assign(new Error(e.message), { code: 'invalid_source_at_build' }); } }, 'extras_group_empty');
  });
  cell(`SC-ATTACH-DETACH ${rid}: an item-level attach / detach passes; another exposure change is still refused`, () => {
    const s = base(); const dish = s.items.find((i) => !i.display.variantOf && i.display.extras_policy !== 'none' && !(s.structure.variant_items || {})[i.display.id]);
    s.structure.exposure.item_overrides[dish.key] = { ...(s.structure.exposure.item_overrides[dish.key] || {}), deny: [g0] };
    cmp(rid, s);
    const t = base(); t.structure.exposure.tb_unknown = 1;
    refused(() => cmp(rid, t), 'structure_changed');
  });
}
cell('SC-REDEEM-CLEANUP la_musa: only a removed extra may leave redeem_eligible_extras', () => {
  const s = buildSourceFromCode('la_musa'); s.extras.forEach((e, i) => { e.display.identity_id = `xid_${i}`; }); s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.slice(1);
  refused(() => cmp('la_musa', s), 'structure_changed');
});

if (fails.length) { console.log(`s2core-compare FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`s2core-compare: OK (${n})`);
