'use strict';
// fix/third-brand-rid-5f (portal-ui 11-18) — the synthetic third brand's source must be one the REAL reader accepts. thirdBrandSource()
// copied x_pizza's source without re-stamping source.restaurant_id, so every publishThirdBrand stored a draft that getEditableCatalogCore
// refuses (503 source_malformed «restaurant_id mismatch», catalog/source-store.js validateSource) — publishVersion does not check it, so
// the suites that only publish (p0-third-brand, capp-s1, marketing-off) never saw it. Real writers end to end: publishThirdBrand over the
// Firestore fake, then the real getEditableCatalogCore with the real active-pointer + previewVersion reads. Run: node contract/third-brand-source.test.js
const assert = require('assert');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const { makeDb } = require('../catalog/firestore-fake');
const { THIRD, thirdBrandSource, publishThirdBrand } = require('./third-brand');
const { getEditableCatalogCore } = require('../catalog/portal-reads');
const { getActiveVersionId } = require('../catalog/catalog-firestore');
const { previewVersion } = require('../catalog/catalog-publish');

const owner = async () => ({ ok: true, uid: 'tb_owner', role: 'owner', actor: 'owner@x.hn', capabilities: undefined });
const readActiveBuilt = (db, rid) => async () => {
  const versionId = await getActiveVersionId(db, rid);
  const p = await previewVersion(db, rid, versionId);
  const extras = {}; for (const e of p.extras) extras[e.key] = e.price;
  return { built: { items: p.items, structure: p.structure, extras }, versionId, extraRecords: p.extras };
};
const editable = (db, rid) => getEditableCatalogCore({ db: {}, fsdb: db, authorize: owner, readActiveVersionId: (f, r) => getActiveVersionId(f, r), readActiveBuilt: readActiveBuilt(db, rid) },
  { method: 'GET', query: { restaurantId: rid } });

(async () => {
  for (const rid of [THIRD, 'r3_other']) {
    const db = makeDb();
    const { source, versionId } = await publishThirdBrand(db, { rid });
    assert.ok(versionId, `premise: ${rid} published through the real path`);
    assert.strictEqual(source.restaurant_id, rid, `✗ TB-RID: ${rid}: the stored source names its own restaurant (${String(source.restaurant_id)})`);
    const res = await editable(db, rid);
    assert.strictEqual(res.status, 200, `✗ TB-READ: ${rid}: the real reader accepts the third brand's draft — got ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.strictEqual(res.body.source.restaurant_id, rid, `✗ TB-READ: ${rid}: the editor serves the brand's own draft`);
  }
  ok(`publishThirdBrand stores a draft the real getEditableCatalogCore serves (200) — for ${THIRD} and for a caller-chosen rid`);
  // the pure builder: no rid ⇒ THIRD (today's callers), and it never mutates the x_pizza seed it copies
  assert.strictEqual(thirdBrandSource().source.restaurant_id, THIRD, '✗ TB-RID: thirdBrandSource() defaults to THIRD');
  assert.strictEqual(thirdBrandSource('r3_other').source.restaurant_id, 'r3_other', '✗ TB-RID: thirdBrandSource(rid) stamps rid');
  assert.strictEqual(require('../tools/seed-source-store').buildSourceFromCode('x_pizza').restaurant_id, 'x_pizza', 'the x_pizza seed is untouched');
  ok('thirdBrandSource(rid = THIRD) stamps restaurant_id; the x_pizza seed it copies is untouched');
  console.log(`third-brand-source: OK (${n})`);
})().catch((e) => { process.stderr.write(`third-brand-source: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
