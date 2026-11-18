'use strict';
// S1 (per-dish extras; advisor 11-11, portal-ui S1 UI plan §6 item 1) — getEditableCatalog states the platform EXTRAS-AUTHORING switch,
// ALWAYS (fail-closed like groupAuthoring / textEditEnabled), so the portal keeps the per-dish checklist and «Sin extras» dark while
// it is off. The REAL handler over the real built sources. Run: node catalog/s1-portal-reads.test.js
const assert = require('assert');
const SWITCH = { authoring: false, throws: false };
require.cache[require.resolve('./platform-extras')] = { id: require.resolve('./platform-extras'), filename: require.resolve('./platform-extras'), loaded: true,
  exports: { extrasCapabilities: () => { if (SWITCH.throws) throw new Error('switch unreadable'); return { authoring: SWITCH.authoring }; } } };
const { getEditableCatalogCore } = require('./portal-reads');
const { NO_STAMP } = require('../test/_no-stamp');   // asm5 (codex P2): F-1's fail-closed stamp read — fsdb: {} no longer means "no stamp"
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { rederiveOptionNames } = require('./add-product');
const { emptyReserved, unionReserved, reservedKeySet } = require('./reserved-keys');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s1-portal-reads: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (o) => JSON.parse(JSON.stringify(o));
const itemOf = (s, key) => s.items.find((i) => i.key === key);
const TS = { seconds: 1788754374, nanoseconds: 634000000 };
const asOwner = async () => ({ ok: true, uid: 'uidOwner001', role: 'owner', actor: 'o@m.hn' });
const gReq = (rid) => ({ method: 'GET', query: { restaurantId: rid }, get: () => 'Bearer tok' });
const builtOf = (rid, src) => { const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode, frozenKeys: i.frozenKeys }); return { built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras }; };
const read = async (rid, draft, { reserved = undefined, reservedThrows = false } = {}) => {
  const calls = { reserved: 0 };
  const r = await getEditableCatalogCore({
    db: {}, fsdb: NO_STAMP, authorize: asOwner, readActiveVersionId: async () => 'v-live',
    _sourceRefOf: () => ({ get: async () => ({ exists: true, data: () => clone(draft), updateTime: TS }) }),
    readActiveBuilt: async () => builtOf(rid, buildSourceFromCode(rid)),
    readReservedKeys: async () => { calls.reserved += 1; if (reservedThrows) throw new Error('UNAVAILABLE'); return reservedKeySet(reserved); },
  }, gReq(rid));
  return { r, calls };
};
const reservedDoc = (keys) => unionReserved(emptyReserved(), { dish: keys, extra: [] }, 'v-x').doc;

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = buildSourceFromCode(rid);
    SWITCH.authoring = false; SWITCH.throws = false;
    { const { r } = await read(rid, src); assert.strictEqual(r.status, 200, 'premise'); assert.strictEqual(r.body.extrasAuthoring, false, `S1R-OFF ${rid}: extrasAuthoring:false, always present`); }
    SWITCH.authoring = true;
    { const { r } = await read(rid, src); assert.strictEqual(r.body.extrasAuthoring, true, `S1R-ON ${rid}: extrasAuthoring:true`); }
    SWITCH.throws = true;
    { const { r } = await read(rid, src); assert.strictEqual(r.status, 200, 'the read still answers'); assert.strictEqual(r.body.extrasAuthoring, false, `S1R-THROW ${rid}: an unreadable switch reads as OFF (fail-closed)`); }
    ok(`${rid}: extrasAuthoring is always stated — off, on, and fail-closed when unreadable`);
  }
  FINISHED = true;
  console.log(`s1-portal-reads: OK (${n})`);
})().catch((e) => { console.error('s1-portal-reads FAILED:', e && e.message); process.exit(1); });
