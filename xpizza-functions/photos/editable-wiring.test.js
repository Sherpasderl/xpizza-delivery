'use strict';
// DISH PHOTOS A2 step 9 (E-P3) — the photo fields through the REAL getEditableCatalogCore: byte-identical without photo data, spread
// when present, `photosPending` consumed into pendingOther (never emitted), a failing photo read omits them (the editor still loads).
// Run: node photos/editable-wiring.test.js
const assert = require('assert');
const { getEditableCatalogCore } = require('../catalog/portal-reads');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1';
const P = 'a'.repeat(32);
const src = { restaurant_id: RID, items: [{ key: 'tb_k', price: 100, display: { id: 1, name: 'K', price: 100 } }], extras: [], structure: { categories: [{ id: 'c' }], item_order: ['tb_k'] } };
const TS = { seconds: 1788754374, nanoseconds: 1 };
const deps = (over = {}) => ({
  db: {}, fsdb: {}, authorize: async () => ({ ok: true, uid: 'tb_owner', role: 'owner' }), readActiveVersionId: async () => 'v1',
  _sourceRefOf: () => ({ get: async () => ({ exists: true, data: () => src, updateTime: TS }) }), _validateSource: () => {}, ...over,
});
const req = { method: 'GET', query: { restaurantId: RID }, get: () => 'Bearer tok' };

(async () => {
  const base = await getEditableCatalogCore(deps(), req);
  assert.strictEqual(base.status, 200, `premise ${JSON.stringify(base.body).slice(0, 200)}`);
  const empty = await getEditableCatalogCore(deps({ photoReads: { fieldsFor: async () => ({}) } }), req);
  assert.strictEqual(JSON.stringify(empty), JSON.stringify(base), 'EP3W-DARK-BYTE-IDENTICAL');
  ok('photoReads answering {} → the 200 response is byte-identical to today\'s');

  const seen = [];
  const fields = { photos: { tb_k: { state: 'pid', pid: P } }, photoPreviews: { [P]: { card: 'https://storage.googleapis.com/b/photos/x', hero: 'h' } }, legacyPreviews: { tb_k: {} }, photosEnabled: true, photosPending: true };
  const r = await getEditableCatalogCore(deps({ photoReads: { fieldsFor: async (a) => { seen.push(a); return fields; } } }), req);
  assert.deepStrictEqual(seen, [{ rid: RID, source: src, activeVersionId: 'v1' }], 'EP3W-ARGS');
  for (const k of ['photos', 'photoPreviews', 'legacyPreviews', 'photosEnabled']) assert.deepStrictEqual(r.body[k], fields[k], `EP3W-FIELD ${k}`);
  assert.ok(!('photosPending' in r.body), 'EP3W-PENDING-NOT-EMITTED');
  assert.strictEqual(r.body.pendingOther, true, 'EP3W-PENDING-OTHER (a pending photo change is «something besides a name»)');
  ok('the fields are spread into the response; photosPending is consumed into pendingOther and never emitted');

  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
  const failed = await getEditableCatalogCore(deps({ photoReads: { fieldsFor: async () => { throw new Error('firestore down'); } } }), req);
  console.warn = warn;
  assert.strictEqual(JSON.stringify(failed), JSON.stringify(base), 'EP3W-FAILURE-OMITS (the editor still loads, unchanged)');
  assert.ok(warned.some((w) => w.includes('portal_photo_fields_unavailable')), 'EP3W-FAILURE-LOGGED');
  ok('a failing photo read omits the fields (response = today\'s) and logs portal_photo_fields_unavailable');

  console.log(`editable-wiring: OK (${n})`);
})().catch((e) => { console.error('editable-wiring: FAILED —', e && e.stack || e); process.exit(1); });
