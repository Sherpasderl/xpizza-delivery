'use strict';
// «Quitar del menú» server prerequisites (PLAN-portal-remove-product-r1 §1b; advisor 11-12), behind ONE platform switch:
//   P-R5  catalog/platform-removal.js removalCapabilities().productRemoval — OFF (shipped) = today's refusals and today's response bytes;
//         ON: getEditableCatalog states `productRemoval: true`.
//   P-R4  (d1309843 + Codex r1 P2-1) a declared removal's own entries leave with it, and an emptied extras_by_item is {} — ON only.
//   P-R3  catalogDiff never rename-pairs a DECLARED removal (its live identity is in the draft's claim) — ON only; the save, the owner
//         publish and the manager request pass the same option (removalDiffOptions), so the token re-matches.
//   P-R1  getEditableCatalog serves `pendingRemovals: [{ key, identity_id, row, after, photo }]` (sorted by key) — the live dishes the
//         SAVED draft removes: `row` the live item, `after` its live item_order predecessor (or null), `photo` its live photo entry (or null).
//   P-R2  getEditableCatalog serves `rewardKeys: [key]` — the live keys gateFlagsOf (the ONE derivation) marks redeem_eligible, sorted.
// Real seed data, the REAL save (editCatalogCore) and the REAL editor read (getEditableCatalogCore). Run: node catalog/remove-product-server.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const SW = { on: false };
{ const p = require.resolve('./platform-removal'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { removalCapabilities: () => ({ productRemoval: SW.on }) } }; }
const fs = require('fs'); const path = require('path');
const { editCatalogCore } = require('./edit-catalog-handler');
const { getEditableCatalogCore } = require('./portal-reads');
const { catalogDiff, gateFlagsOf, removalDiffOptions } = require('./catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs, canonicalize } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { NO_STAMP } = require('../test/_no-stamp');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const ON = async (fn) => { SW.on = true; try { return await fn(); } finally { SW.on = false; } };
const T0 = '2026-10-24T10:00:00.000000Z'; const T1 = '2026-10-24T11:00:00.000000Z'; const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = (rid) => { const s = clone(buildSourceFromCode(rid)); for (const it of s.items) it.display.identity_id = `id_${String(it.key).replace(/[^A-Za-z0-9]/g, '_')}`; return s; };
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const activeOf = (rid, src = base(rid)) => { const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable });
  return { built: { items: b.items, structure: b.structure, extras: i.extras }, versionId: ACTIVE, generation: 0, extraRecords: b.extras }; };
function saveDb(rid) {
  const state = { source: { data: base(rid), updateTime: T0 } };
  const doc = (p) => ({
    get: async () => {
      if (p === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (p === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE, generation: 0 }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
  });
  return { state, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
const save = async (rid, source, ids) => { const db = saveDb(rid); const r = await editCatalogCore({ db, authorize: owner, readActiveBuilt: async () => activeOf(rid) },
  { restaurantId: rid, source: { ...source, deleted_ids: { ids } }, baseSourceUpdateTime: T0, deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {}); return { r, saved: db.state.source.data }; };
function removed(src, key) {
  const s = clone(src);
  s.items = s.items.filter((i) => i.key !== key);
  s.structure.item_order = s.structure.item_order.filter((k) => k !== key);
  const ov = s.structure.exposure && s.structure.exposure.item_overrides; if (ov && ov[key]) delete ov[key];
  if (s.structure.extras_by_item && s.structure.extras_by_item[key]) delete s.structure.extras_by_item[key];
  if (Array.isArray(s.structure.redeem_eligible_items)) s.structure.redeem_eligible_items = s.structure.redeem_eligible_items.filter((k) => k !== key);
  return s;
}
const stamp = (rid, key) => base(rid).items.find((i) => i.key === key).display.identity_id;
const editor = (rid, source) => getEditableCatalogCore({ db: { ref: () => ({ get: async () => ({ val: () => 'Nombre' }) }) }, fsdb: NO_STAMP, authorize: owner,
  readActiveVersionId: async () => ACTIVE, readActiveBuilt: async () => activeOf(rid),
  _sourceRefOf: () => ({ get: async () => ({ exists: true, data: () => source, updateTime: { seconds: 1788754374, nanoseconds: 0 } }) }) },
{ method: 'GET', query: { restaurantId: rid }, get: () => 'Bearer tok' });
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;

(async () => {
  await cell('PR5-OFF: switch OFF — removing a dish named in an override is today\'s structure_changed; the editor read carries no removal fields', async (L) => {
    const { r } = await save('x_pizza', removed(base('x_pizza'), 'Nutella'), [stamp('x_pizza', 'Nutella')]);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'structure_changed'], `${L}: ${show(r)}`);
    const e = await editor('la_musa', canonicalize(base('la_musa')));
    assert.strictEqual(e.status, 200, show(e));
    for (const k of ['productRemoval', 'pendingRemovals', 'rewardKeys']) assert.ok(!(k in e.body), `${L}: no ${k}`);
  });
  await cell('PR5-ON: switch ON — the same removal saves; the editor read states productRemoval: true', () => ON(async () => {
    const { r } = await save('x_pizza', removed(base('x_pizza'), 'Nutella'), [stamp('x_pizza', 'Nutella')]);
    assert.strictEqual(r.status, 200, show(r));
    const e = await editor('la_musa', canonicalize(base('la_musa')));
    assert.strictEqual(e.body.productRemoval, true);
  }));
  await cell('PR1-ON: the editor read serves the SAVED draft\'s removals: { key, identity_id, row, after, photo }, sorted', () => ON(async () => {
    const rid = 'la_musa'; const live = activeOf(rid).built;
    const { r, saved } = await save(rid, removed(removed(base(rid), 'soft_01'), 'rice_03'), [stamp(rid, 'soft_01'), stamp(rid, 'rice_03')]);
    assert.strictEqual(r.status, 200, show(r));
    const e = await editor(rid, saved);
    const order = live.structure.item_order; const before = (k) => { const i = order.indexOf(k); return i > 0 ? order[i - 1] : null; };
    assert.deepStrictEqual(e.body.pendingRemovals, ['rice_03', 'soft_01'].map((k) => ({ key: k, identity_id: stamp(rid, k), row: live.items.find((it) => it.key === k), after: before(k), photo: null })));
  }));
  await cell('PR1-NONE: a draft that removes nothing serves no pendingRemovals', () => ON(async () => {
    const e = await editor('la_musa', canonicalize(base('la_musa')));
    assert.ok(!('pendingRemovals' in e.body), JSON.stringify(e.body.pendingRemovals));
  }));
  await cell('PR2-ON: rewardKeys = the live keys gateFlagsOf marks redeem_eligible (both brands), sorted', () => ON(async () => {
    for (const rid of ['x_pizza', 'la_musa']) {
      const want = [...gateFlagsOf(activeOf(rid).built)].filter(([, f]) => f.redeem_eligible).map(([k]) => k).sort();
      assert.ok(want.length > 0, `premise: ${rid} has reward dishes`);
      const e = await editor(rid, canonicalize(base(rid)));
      assert.deepStrictEqual(e.body.rewardKeys, want, rid);
    }
  }));
  await cell('PR3: a DECLARED removal + an addition at its price is removed + added (ON); OFF is today\'s rename pairing; an undeclared one still pairs', async (L) => {
    const rid = 'la_musa'; const src = base(rid);
    const gone = src.items.find((i) => i.key === 'noodle_02');
    const d = removed(src, 'noodle_02'); d.items.push({ key: 'noodle_nuevo', price: gone.price, display: { ...gone.display, id: 'noodle_nuevo', name: 'Noodle Nuevo', identity_id: undefined } }); d.structure.item_order.push('noodle_nuevo');
    d.deleted_ids = { ids: [stamp(rid, 'noodle_02')] };
    const live = builtOf(src, rid); const draft = builtOf(d, rid);
    const off = catalogDiff(live, draft, removalDiffOptions(live, d));
    assert.deepStrictEqual(off.renamed.map((x) => [x.from, x.to]), [['noodle_02', 'noodle_nuevo']], `${L}: OFF — today's pairing`);
    await ON(async () => {
      const on = catalogDiff(live, draft, removalDiffOptions(live, d));
      assert.deepStrictEqual([on.renamed, on.removed.map((x) => x.key), on.added.map((x) => x.key)], [[], ['noodle_02'], ['noodle_nuevo']], `${L}: ON — Quitado + the addition`);
      const undeclared = { ...d, deleted_ids: { ids: [] } };
      assert.deepStrictEqual(catalogDiff(live, draft, removalDiffOptions(live, undeclared)).renamed.map((x) => x.from), ['noodle_02'], `${L}: an undeclared removal still pairs`);
    });
  });
  await cell('PR3-WIRING: the save, the owner publish and the manager request diff with the SAME option (the token re-matches)', () => {
    for (const f of ['edit-catalog-handler.js', 'publish-edited-handler.js', 'publish-request.js']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'latin1');
      const calls = src.split('catalogDiff(').length - 1;
      const withOpt = (src.match(/catalogDiff\([^\n]*removalDiffOptions\(/g) || []).length;
      assert.ok(calls >= 1 && withOpt === calls, `${f}: every catalogDiff call passes removalDiffOptions (${withOpt}/${calls})`);
    }
  });
  if (fails.length) { console.error(`remove-product-server FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`remove-product-server: OK (${n})`);
})();
