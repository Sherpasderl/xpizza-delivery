'use strict';
// S3 B1 (advisor 2026-11-13, for portal-ui's S3 UI plan) — getEditableCatalog ALWAYS states `choiceEdit`, fail-closed, exactly like
// S2-core's extrasCatalog: the SAME constant the writer enforces (catalog/platform-structure.js structureCapabilities — editCatalog's
// choiceOn). true only when the switch is on; false when off, missing or throwing.
// Through the REAL getEditableCatalogCore (the s2core-editable harness). Run: node catalog/s3-choice-editable.test.js
const assert = require('assert');
const STRUCT = { mode: 'off' };
{ const p = require.resolve('./platform-structure'); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => {
  if (STRUCT.mode === 'throw') throw new Error('unreadable');
  if (STRUCT.mode === 'junk') return { choiceEdit: 'yes' };
  return { ...real.structureCapabilities(), choiceEdit: STRUCT.mode === 'on' };
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
    await cell(`ED-CHOICE-${mode.toUpperCase()}: the switch ${mode} → choiceEdit:${want}, always stated`, async (L) => {
      STRUCT.mode = mode;
      const r = await read();
      assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.ok(Object.prototype.hasOwnProperty.call(r.body, 'choiceEdit'), `${L}: stated`);
      assert.strictEqual(r.body.choiceEdit, want, L);
    });
  }
  // the shipped constant, unstubbed: the read states exactly what editCatalog's choiceOn reads
  await cell('ED-CHOICE-SHIPPED: unstubbed, choiceEdit === platform-structure\'s shipped CHOICE_EDIT (false at ship)', async (L) => {
    STRUCT.mode = 'off';
    const real = require.cache[require.resolve('./platform-structure')].exports;
    delete require.cache[require.resolve('./platform-structure')];
    try {
      const shipped = require('./platform-structure').structureCapabilities().choiceEdit;
      const r = await read();
      assert.strictEqual(r.body.choiceEdit, shipped === true, L);
      assert.strictEqual(shipped, false, `${L}: the switch ships OFF`);
    } finally { require.cache[require.resolve('./platform-structure')] = { id: require.resolve('./platform-structure'), filename: require.resolve('./platform-structure'), loaded: true, exports: real }; }
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`OK(${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
