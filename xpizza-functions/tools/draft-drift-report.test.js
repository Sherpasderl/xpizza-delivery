'use strict';
// 1D add-product A — tools/draft-drift-report.js on FIXTURES (the real code-seeded sources). Run: node tools/draft-drift-report.test.js
const assert = require('assert');
const { driftReport, readOnly } = require('./draft-drift-report');
const { buildSourceFromCode } = require('./seed-source-store');
const { canonicalize, sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const A = require('../catalog/add-product');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const SRC = { x_pizza: canonicalize(buildSourceFromCode('x_pizza')), la_musa: canonicalize(buildSourceFromCode('la_musa')) };
const activeOf = (rid, src) => { const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable });
  return { built: { items: b.items, structure: b.structure }, extraRecords: b.extras }; };

(async () => {
  {
    const added = A.allocateAdditions({ incoming: (() => { const s = clone(SRC.x_pizza); s.items.push({ ref: 'tmp:cccccccc-0001', price: 500, display: { cat: 'ny', name: 'Drift Probe', price: 500 } }); s.structure.item_order.push('tmp:cccccccc-0001'); return s; })(),
      stored: SRC.x_pizza, activeItems: SRC.x_pizza.items, keyMode: 'name', hwm: null, registryHasKey: () => false }).source;
    const drifted = clone(SRC.la_musa); drifted.items[0].display.name += ' X';
    const poisoned = clone(SRC.x_pizza); poisoned.items.push({ key: 'Launcher', price: 500, display: { id: 99, cat: 'ny', name: 'Launcher', price: 500 } },
      { key: 'Launcher - Roja', price: 500, display: { id: 100, cat: 'ny', name: 'Launcher - Roja', price: 500, variantOf: 99, choice: 'Roja' } });
    poisoned.structure.item_order.push('Launcher', 'Launcher - Roja'); poisoned.structure.variant_items = { 99: { label: 'Salsa', variantIds: [100] } };
    const sources = { x_pizza: SRC.x_pizza, la_musa: drifted, r3_added: added, r3_poison: poisoned, r3_nosrc: null, r3_noact: SRC.x_pizza, r3_boom: SRC.x_pizza };
    const actives = { x_pizza: activeOf('x_pizza', SRC.x_pizza), la_musa: activeOf('la_musa', SRC.la_musa), r3_added: activeOf('x_pizza', SRC.x_pizza), r3_poison: activeOf('x_pizza', SRC.x_pizza), r3_noact: null };
    // r3_* rows reuse a brand's catalog under another id: assessDraft is brand-keyed by rid, so they are run AS that brand
    const asBrand = { r3_added: 'x_pizza', r3_poison: 'x_pizza' };
    const rows = await driftReport({
      rids: ['x_pizza', 'la_musa', 'r3_nosrc', 'r3_noact', 'r3_boom'],
      readSource: async (rid) => sources[rid],
      readActive: async (rid) => { if (rid === 'r3_boom') throw new Error('read failed'); return actives[rid]; },
    });
    assert.deepStrictEqual(rows[0], { rid: 'x_pizza', status: 'publishable', additions: [], removals: [] });
    assert.strictEqual(rows[1].status, 'drift'); assert.strictEqual(rows[1].code, 'existing_item_changed');
    assert.deepStrictEqual(rows.slice(2).map((r) => r.status), ['no_source', 'no_active', 'unreadable']);
    const brandRows = await driftReport({ rids: ['x_pizza'], readSource: async () => added, readActive: async () => actives.x_pizza });
    assert.deepStrictEqual(brandRows[0], { rid: 'x_pizza', status: 'publishable', additions: ['Drift Probe'], removals: [] }, 'an unpublished ADDITION is not drift');
    const poisonRows = await driftReport({ rids: ['x_pizza'], readSource: async () => poisoned, readActive: async () => actives.x_pizza });
    assert.strictEqual(poisonRows[0].status, 'drift', 'the poisoned (variant) x_pizza draft is reported');
    assert.ok(['choices_not_supported_yet', 'draft_unbuildable'].includes(poisonRows[0].code), poisonRows[0].code);
    void asBrand;
    ok('rows: publishable (no change / an unpublished addition), drift (a La Musa rename; the poisoned variant draft), no_source, no_active, unreadable');
  }
  {
    const writes = [];
    const fake = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }), set: () => writes.push('set'), collection: () => ({ doc: () => ({ update: () => writes.push('update') }) }) }) }),
      batch: () => writes.push('batch'), runTransaction: () => writes.push('tx') };
    const ro = readOnly(fake);
    assert.strictEqual((await ro.collection('a').doc('b').get()).exists, false, 'reads pass through');
    assert.throws(() => ro.collection('a').doc('b').set({}), /read-only/);
    assert.throws(() => ro.collection('a').doc('b').collection('c').doc('d').update({}), /read-only/, 'at any depth');
    assert.throws(() => ro.batch(), /read-only/); assert.throws(() => ro.runTransaction(() => {}), /read-only/);
    assert.deepStrictEqual(writes, [], 'nothing reached the underlying handle');
    ok('the Firestore handle is read-only at every depth: set / update / batch / runTransaction throw; reads pass');
  }
  console.log(`\ndraft-drift-report: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
