'use strict';
// S2b (PLAN-structure-S2b-r3 §0, §1.3, §3) — extra renames and retired-name reuse through the REAL editCatalogCore, the S2-core Extras
// switch ON and the dark S2b switch stubbed (shipped OFF). Drafts written by the REAL Extras-page writer (exposure-transitions).
// OFF: today's refusals. ON: a rename saves under its kept key and is RECORDED; a name already taken (another extra's name or key) is
// name_taken; a reused retired name mints; frozen_extra_keys is server-owned (a client entry refused, an omitted map restored).
// Run: node catalog/s2b-save.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const XI = { mintExtras: false };
{ const p = require.resolve('./platform-structure'); const real = require('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), extrasCatalog: true }) } }; }
{ const p = require.resolve('./extra-identity'); const real = require('./extra-identity'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, extraIdentityCapabilities: () => ({ mintExtras: XI.mintExtras }) } }; }
const { editCatalogCore } = require('./edit-catalog-handler');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { slugify } = require('./add-product');
const XT = require('./exposure-transitions');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2b-save: FAILED — exited without completing'); process.exitCode = 1; } });
const T0 = '2026-10-24T10:00:00.000000Z'; const T1 = '2026-10-24T11:00:00.000000Z'; const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const clone = (x) => JSON.parse(JSON.stringify(x));
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
// the live version as the publisher builds it — with the source's OWN extras table (a retired extra is gone from it)
const liveRead = (rid, live) => async () => { const { inputs, built } = require('./candidate-validate').buildSourceCandidate(rid, live); return { built: { ...built, extras: inputs.extras }, versionId: ACTIVE, extraRecords: built.extras }; };
function saveDb(rid, stored) {
  const state = { source: { data: clone(stored), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE, generation: 0 }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
  });
  const batch = () => { const ops = []; return { update: (r, d, p) => ops.push(() => r.update(d, p)), create: (r, d) => ops.push(async () => { state.hwm = d; }), commit: async () => { const out = []; for (const op of ops) out.push(await op()); return out; } }; };
  return { state, batch, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
const addProductOf = (rid, reserved = new Map()) => ({ readKeyMode: async () => (rid === 'la_musa' ? 'id' : 'name'), hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }), registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => reserved });
const save = (rid, live, stored, source, reserved) => { const db = saveDb(rid, stored); return editCatalogCore({ db, authorize: owner, readActiveBuilt: liveRead(rid, live), addProduct: addProductOf(rid, reserved) }, { restaurantId: rid, source, baseSourceUpdateTime: T0 }, {}).then((r) => ({ r, db })); };
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const live = buildSourceFromCode(rid); const x = live.extras[0];
    const renamed = XT.apply(live, { op: 'extra.rename', key: x.key, name: 'Nombre Nuevo S2b' }).source;
    XI.mintExtras = false;
    { const { r } = await save(rid, live, live, renamed);
      assert.ok(r.status >= 400 && r.status < 500, `S2BS-RENAME-OFF ${rid}: today's refusal (${show(r)})`); }
    XI.mintExtras = true;
    { const { r, db } = await save(rid, live, live, renamed);
      assert.strictEqual(r.status, 200, `S2BS-RENAME ${rid}: ${show(r)}`);
      const s = db.state.source.data; const y = s.extras.find((e) => e.key === x.key);
      assert.ok(y && y.display.name === 'Nombre Nuevo S2b', `S2BS-RENAME ${rid}: the key is kept under the new name`);
      assert.deepStrictEqual(s.frozen_extra_keys, { [x.key]: { display_id: String(x.display.id), field: 'name' } }, `S2BS-RENAME ${rid}: the rename is recorded`); }
    { const taken = XT.apply(live, { op: 'extra.rename', key: x.key, name: live.extras[1].display.name }).source;
      const { r } = await save(rid, live, live, taken);
      assert.deepStrictEqual([r.status, r.body.error], [400, 'name_taken'], `S2BS-TAKEN-NAME ${rid}: ${show(r)}`);
      const onKey = XT.apply(live, { op: 'extra.rename', key: x.key, name: live.extras[1].key }).source;
      const { r: r2 } = await save(rid, live, live, onKey);
      assert.deepStrictEqual([r2.status, r2.body.error], [400, 'name_taken'], `S2BS-TAKEN-KEY ${rid}: another extra's key (${show(r2)})`); }
    { const forged = clone(live); forged.frozen_extra_keys = { [x.key]: { display_id: String(x.display.id), field: 'name' } };
      const { r } = await save(rid, live, live, forged);
      assert.deepStrictEqual([r.status, r.body.error], [409, 'frozen_extra_keys_server_owned'], `S2BS-OWNED ${rid}: a client entry (${show(r)})`);
      const stored = clone(live); stored.frozen_extra_keys = { [x.key]: { display_id: String(x.display.id), field: 'name' } }; stored.extras[0].display.name = 'Ya Renombrado';
      const liveR = clone(stored);
      const omit = clone(stored); delete omit.frozen_extra_keys; omit.extras[0].price += 1; omit.extras[0].display.price = omit.extras[0].price;
      const { r: r2, db } = await save(rid, liveR, stored, omit);
      assert.strictEqual(r2.status, 200, `S2BS-OWNED ${rid}: an omitted map is restored (${show(r2)})`);
      assert.deepStrictEqual(db.state.source.data.frozen_extra_keys, stored.frozen_extra_keys, `S2BS-OWNED ${rid}: restored`); }
    { // Codex S2b r1 P1-1 / P1-4: ON, an i_… name (new or renamed) is extra_name_opaque; a NEW extra named like another extra's ACTIVE key is name_taken
      XI.mintExtras = true;
      const g = live.extras[0].display.cat;
      const opq = XT.apply(live, { op: 'extra.add', group: g, ref: 'tmp:opaque-name-01', name: 'i_abcdefghijkl', price: 10 }).source;
      const { r } = await save(rid, live, live, opq);
      assert.deepStrictEqual([r.status, r.body.error], [400, 'extra_name_opaque'], `S2BS-OPAQUE-NEW ${rid}: ${show(r)}`);
      const opr = XT.apply(live, { op: 'extra.rename', key: x.key, name: 'i_abcdefghijk2' }).source;
      const { r: r2 } = await save(rid, live, live, opr);
      assert.deepStrictEqual([r2.status, r2.body.error], [400, 'extra_name_opaque'], `S2BS-OPAQUE-RENAME ${rid}: ${show(r2)}`);
      const both = XT.apply(XT.apply(live, { op: 'extra.rename', key: x.key, name: 'Otro Nombre S2b' }).source, { op: 'extra.add', group: g, ref: 'tmp:onkey-0001', name: x.key, price: 11 }).source;
      const { r: r3 } = await save(rid, live, live, both);
      assert.deepStrictEqual([r3.status, r3.body.error], [400, 'name_taken'], `S2BS-NEW-ON-KEY ${rid}: a new extra named like the renamed extra's kept key (${show(r3)})`);
      XI.mintExtras = false;
      const { r: r4 } = await save(rid, live, live, opq);
      assert.strictEqual(r4.status, 200, `S2BS-OPAQUE-OFF ${rid}: OFF accepts an i_… extra name (today) (${show(r4)})`);
    }
    { // P1-4: the owner publish / manager request gate (structure-gate.judge) runs the name rules on the FULL candidate even when every key exists
      XI.mintExtras = true;
      const opr = XT.apply(live, { op: 'extra.rename', key: x.key, name: 'i_abcdefghijk3' }).source;
      const L = await liveRead(rid, live)();
      let err = null;
      try { await require('./structure-gate').judge({ rid, draft: opr, draftRecords: { items: L.built.items, extras: L.extraRecords.map((e) => (e.key === x.key ? { ...e, display: { ...e.display, name: 'i_abcdefghijk3' } } : e)), structure: L.built.structure }, live: L.built, liveExtraRecords: L.extraRecords, addProduct: addProductOf(rid) }); } catch (e) { err = e; }
      assert.strictEqual(err && err.code, 'extra_name_opaque', `S2BS-GATE-NAMES ${rid}: the gate refuses (${err && err.code})`);
      XI.mintExtras = false;
    }
    ok(`${rid}: rename OFF refused / ON saved + recorded; a taken name or key is name_taken; the map is server-owned (client entry refused, omission restored)`);
  }
  { // a RETIRED name re-added through the real save mints (switch ON) — name_needs_new_id OFF
    for (const rid of ['x_pizza', 'la_musa']) {
      const base = buildSourceFromCode(rid); const gone = base.extras[0];
      const live = clone(base); live.extras = live.extras.slice(1);
      if (Array.isArray(live.structure.extra_order)) live.structure.extra_order = live.structure.extra_order.filter((k) => k !== gone.key);
      for (const f of ['extras_by_category', 'extras_by_item']) if (live.structure[f]) for (const v of Object.values(live.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(gone.key); if (i >= 0) v.splice(i, 1); }
      if (Array.isArray(live.structure.redeem_eligible_extras)) live.structure.redeem_eligible_extras = live.structure.redeem_eligible_extras.filter((k) => k !== gone.key);
      const derived = rid === 'la_musa' ? slugify(gone.display.name) : gone.display.name;
      const draft = XT.apply(live, { op: 'extra.add', group: gone.display.cat, ref: 'tmp:reuse-save-01', name: gone.display.name, price: gone.price }).source;
      XI.mintExtras = false;
      const { r: off } = await save(rid, live, live, draft, new Map([[derived, ['extra']]]));
      assert.deepStrictEqual([off.status, off.body.error], [400, 'name_needs_new_id'], `S2BS-REUSE-OFF ${rid}: ${show(off)}`);
      XI.mintExtras = true;
      const { r, db } = await save(rid, live, live, draft, new Map([[derived, ['extra']]]));
      assert.strictEqual(r.status, 200, `S2BS-REUSE ${rid}: ${show(r)}`);
      const s = db.state.source.data; const row = s.extras.find((e) => e.display.name === gone.display.name);
      assert.ok(row && /^i_[a-z2-7]{12}$/i.test(row.key) && s.frozen_extra_keys[row.key] && s.frozen_extra_keys[row.key].reuses === derived, `S2BS-REUSE ${rid}: minted + recorded (${JSON.stringify(row && row.key)})`);
    }
    XI.mintExtras = false;
    ok('a retired extra name re-added through the real save: name_needs_new_id OFF; minted + recorded ON (both brands)');
  }
  FINISHED = true;
  console.log(`s2b-save: OK (${n})`);
})().catch((e) => { console.error('s2b-save FAILED:', e && e.message); process.exit(1); });
