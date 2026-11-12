'use strict';
// «Quitar del menú» (owner-approved; NOTE-remove-product-server §2c, advisor 11-12) — a dish named EXPLICITLY in exposure.item_overrides[key]
// or structure.redeem_eligible_items, removed through the REAL editCatalogCore with its declared deletion claim (D4-P1): its own entries leave
// WITH the removal, and nothing else may change. Real seed data: X Pizza «Nutella» (an override), La Musa «rice_03» (an override) and
// «soft_01» (an item-level reward entry). Run: node catalog/remove-dish-refs.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { editCatalogCore } = require('./edit-catalog-handler');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('remove-dish-refs: FAILED — exited without completing'); process.exitCode = 1; } });
const T0 = '2026-10-24T10:00:00.000000Z'; const T1 = '2026-10-24T11:00:00.000000Z'; const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const clone = (x) => JSON.parse(JSON.stringify(x));
// certified rows (identity stamps) in the live AND the stored draft, so a removal can be declared
const base = (rid) => { const s = clone(buildSourceFromCode(rid)); for (const it of s.items) it.display.identity_id = `id_${String(it.key).replace(/[^A-Za-z0-9]/g, '_')}`; return s; };
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const liveRead = (rid) => async () => { const src = base(rid); const i = sourceToBuildInputs(src); return { built: builtOf(src, rid), versionId: ACTIVE, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }).extras }; };
function saveDb(rid) {
  const state = { source: { data: base(rid), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE, generation: 0 }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
  });
  return { state, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
const save = (rid, source, ids) => { const db = saveDb(rid); return editCatalogCore({ db, authorize: owner, readActiveBuilt: liveRead(rid) }, { restaurantId: rid, source: { ...source, deleted_ids: { ids } }, baseSourceUpdateTime: T0, deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {}).then((r) => ({ r, db })); };
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
// the draft the portal writes for a removal: the dish leaves the items and item_order, and ITS OWN explicit entries go with it
function removed(src, key) {
  const s = clone(src);
  s.items = s.items.filter((i) => i.key !== key);
  s.structure.item_order = s.structure.item_order.filter((k) => k !== key);
  const ov = s.structure.exposure && s.structure.exposure.item_overrides; if (ov && ov[key]) delete ov[key];   // the map itself stays (the schema requires it)
  if (s.structure.extras_by_item && s.structure.extras_by_item[key]) delete s.structure.extras_by_item[key];   // its derived per-dish exposure map entry
  if (Array.isArray(s.structure.redeem_eligible_items)) s.structure.redeem_eligible_items = s.structure.redeem_eligible_items.filter((k) => k !== key);
  return s;
}
const stamp = (rid, key) => base(rid).items.find((i) => i.key === key).display.identity_id;

(async () => {
  for (const [rid, key, what] of [['x_pizza', 'Nutella', 'an item override'], ['la_musa', 'rice_03', 'an item override'], ['la_musa', 'soft_01', 'an item-level reward entry']]) {
    const { r, db } = await save(rid, removed(base(rid), key), [stamp(rid, key)]);
    assert.strictEqual(r.status, 200, `RDR-${key}: a declared removal of a dish with ${what} saves (${show(r)})`);
    const saved = db.state.source.data;
    assert.ok(!saved.items.some((i) => i.key === key), `RDR-${key}: the dish left the draft`);
    assert.ok(!((saved.structure.exposure || {}).item_overrides || {})[key] && !(saved.structure.redeem_eligible_items || []).includes(key), `RDR-${key}: its own entries left with it`);
    assert.ok(!(saved.structure.extras_by_item || {})[key], `RDR-${key}: its extras_by_item entry left with it`);
    ok(`${rid}: removing «${key}» (${what}) with its declared claim saves; its own entries leave with it`);
  }
  {   // nothing ELSE may change: dropping ANOTHER dish's override / reward entry beside the removal is still refused
    const s = removed(base('la_musa'), 'soft_01'); s.structure.redeem_eligible_items = s.structure.redeem_eligible_items.filter((k) => k !== 'soft_02');
    const { r } = await save('la_musa', s, [stamp('la_musa', 'soft_01')]);
    assert.ok(r.status >= 400 && r.body.error === 'structure_changed', `RDR-OTHER: another dish's entry cannot leave with a removal (${show(r)})`);
    const t = removed(base('la_musa'), 'soft_01'); delete t.structure.exposure.item_overrides.rice_03;
    const { r: r2 } = await save('la_musa', t, [stamp('la_musa', 'soft_01')]);
    assert.ok(r2.status >= 400 && r2.body.error === 'structure_changed', `RDR-OTHER: another dish's override cannot leave with a removal (${show(r2)})`);
    ok('nothing else may change: another dish\'s override or reward entry leaving beside a removal is still structure_changed');
  }
  {   // an UNDECLARED removal keeps today's refusal
    const { r } = await save('x_pizza', removed(base('x_pizza'), 'Nutella'), []);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'existing_item_removed'], `RDR-UNDECLARED: ${show(r)}`);
    ok('an undeclared removal is today\'s existing_item_removed');
  }
  FINISHED = true;
  console.log(`remove-dish-refs: OK (${n})`);
})().catch((e) => { console.error('remove-dish-refs FAILED:', e && e.message); process.exit(1); });
