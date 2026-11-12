'use strict';
// S2-core (advisor 2026-11-11, for portal-ui's Extras page) — getEditableCatalog ALWAYS states `extrasCatalog`, fail-closed: the SAME
// constant the writers enforce (catalog/platform-structure.js structureCapabilities — editCatalog's allocator, compareToActive at the
// save / draft check / publish, the structure gate). true only when the switch is on; false when off, missing or throwing.
// Through the REAL getEditableCatalogCore (the s2-off-golden editor-read harness). Run: node catalog/s2core-editable.test.js
const assert = require('assert');
const STRUCT = { mode: 'off' };
{ const p = require.resolve('./platform-structure'); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => {
  if (STRUCT.mode === 'throw') throw new Error('unreadable');
  if (STRUCT.mode === 'junk') return { extrasCatalog: 'yes' };
  return { ...real.structureCapabilities(), extrasCatalog: STRUCT.mode === 'on' };
} } }; }
const { getEditableCatalogCore } = require('./portal-reads');
const { NO_STAMP } = require('../test/_no-stamp');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const XP = buildSourceFromCode('x_pizza');
const readActiveBuilt = async () => { const i = sourceToBuildInputs(XP); const b = buildCatalogV2('x_pizza', { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode }); return { built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras }; };
const read = () => getEditableCatalogCore({ db: {}, fsdb: NO_STAMP, authorize: async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' }), readActiveVersionId: async () => 'v-live',
  _sourceRefOf: () => ({ get: async () => ({ exists: true, data: () => JSON.parse(JSON.stringify(XP)), updateTime: { seconds: 1788754374, nanoseconds: 634000000 } }) }), readActiveBuilt },
{ method: 'GET', query: { restaurantId: 'x_pizza' }, get: () => 'Bearer tok' });

(async () => {
  for (const [mode, want] of [['on', true], ['off', false], ['throw', false], ['junk', false]]) {
    await cell(`ED-XCAT-${mode.toUpperCase()}: the switch ${mode} → extrasCatalog:${want}, always stated`, async (L) => {
      STRUCT.mode = mode;
      const r = await read();
      assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.ok(Object.prototype.hasOwnProperty.call(r.body, 'extrasCatalog'), `${L}: stated`);
      assert.strictEqual(r.body.extrasCatalog, want, L);
    });
  }
  // S2 UI plan review (#1): what the save requires for an existing-extra removal — the deletion baseline {version, generation} the save
  // checks deleted_ids_loaded_base against (the SAME pointer read), and the adopted claim's ids, normalized (stored as an object { ids, … })
  const { makeDb } = require('./firestore-fake');
  const readWith = async (src, pointer) => {
    const fs = makeDb(); if (pointer) await fs.collection('restaurants').doc('x_pizza').collection('meta').doc('active_version').set(pointer);
    return getEditableCatalogCore({ db: {}, fsdb: fs, authorize: async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' }), readActiveVersionId: async () => (pointer ? pointer.version : 'v-live'),
      _sourceRefOf: () => ({ get: async () => ({ exists: true, data: () => JSON.parse(JSON.stringify(src)), updateTime: { seconds: 1788754374, nanoseconds: 634000000 } }) }), readActiveBuilt },
    { method: 'GET', query: { restaurantId: 'x_pizza' }, get: () => 'Bearer tok' });
  };
  STRUCT.mode = 'on';
  await cell('ED-DELETION-BASE: the active pointer\'s {version, generation} is served as deletionBase (the save\'s own baseline check)', async (L) => {
    const r = await readWith(XP, { version: 'v-live', generation: 7 });
    assert.deepStrictEqual(r.body.deletionBase, { version: 'v-live', generation: 7 }, `${L}: ${JSON.stringify(r.body.deletionBase)}`);
  });
  await cell('ED-DELETION-BASE-UNREADABLE: an unreadable pointer serves deletionBase:null (stated; the save then refuses deleted_ids_unbound)', async (L) => {
    const r = await readWith(XP, null);
    assert.strictEqual(r.status, 200, L);
    assert.ok(Object.prototype.hasOwnProperty.call(r.body, 'deletionBase') && r.body.deletionBase === null, `${L}: ${JSON.stringify(r.body.deletionBase)}`);
  });
  for (const [tag, claim, want] of [['OBJECT', { ids: ['b', 'a'], base_version: 'v-live', base_generation: 7 }, ['a', 'b']], ['ARRAY', ['c'], ['c']], ['NONE', undefined, []]]) {
    await cell(`ED-DELETION-CLAIM-${tag}: the adopted claim is served as deletionClaim { ids } (sorted strings)`, async (L) => {
      const src = JSON.parse(JSON.stringify(XP)); if (claim !== undefined) src.deleted_ids = claim;
      const r = await readWith(src, { version: 'v-live', generation: 7 });
      assert.deepStrictEqual(r.body.deletionClaim, { ids: want }, `${L}: ${JSON.stringify(r.body.deletionClaim)}`);
    });
  }
  if (fails.length) { console.log(`s2core-editable FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`s2core-editable: OK (${n})`);
})();
