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
  if (fails.length) { console.log(`s2core-editable FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`s2core-editable: OK (${n})`);
})();
