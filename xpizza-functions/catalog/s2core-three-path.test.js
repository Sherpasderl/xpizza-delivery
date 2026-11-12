'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.6; T17, T25) — THREE-PATH-EQUAL: the save, the owner publish and the manager request bind
// their token to the SAME canonical review diff (review-diff.js), for S2 ops as for today's edits. The REAL save mints the token on
// one Firestore fake; the REAL manager request and the REAL owner publish recompute and verify it (the publish-request-consequences
// harness, the extrasCatalog switch stubbed ON). Run: node catalog/s2core-three-path.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'p'.repeat(32);
{ const p = require.resolve('./item-text-edit'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { textEditCapabilities: () => ({ enabled: true }) } }; }
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: true, choiceEdit: false, sections: false }) } }; }
const XT = require('./exposure-transitions');
const ACK = { list: [] };
// the save's add-product I/O, cut to what an extra allocation reads (s2core-flow.test.js)
const ADD_PRODUCT = { readKeyMode: async () => 'name', hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }), registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => require('./reserved-keys').reservedKeySet(undefined) };
const { createFakeDb } = require('../merchant/_fake-db');
const { makeDb } = require('./firestore-fake');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
const { editCatalogCore } = require('./edit-catalog-handler');
const { publishEditedCore } = require('./publish-edited-handler');
const PR = require('./publish-request');
// the PRODUCTION precondition decoder, evaluated from its own source (portal/functions.js decodeUpdateTimeForEdit; not exported, and
// requiring the deployed entry would initialize the Admin app) — the save gets exactly what production passes, and the fake accepts
// only a real Timestamp, so this harness is never laxer than production
const PROD_DECODE = (() => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../portal/functions.js'), 'utf8');
  const m = src.match(/function decodeUpdateTimeForEdit\(v\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'premise: portal/functions.js still defines decodeUpdateTimeForEdit');
  return new Function('FirestoreTimestamp', `${m[0]}; return decodeUpdateTimeForEdit;`)(require('firebase-admin/firestore').Timestamp);
})();

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const FISCAL = 'x_pizza';   // the platform-factura location (data: factura/eligibility) — the only brand a manager REQUESTS on
const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const rtdb = () => createFakeDb({
  brands: { [FISCAL]: legacy(FISCAL) },
  restaurants: { [FISCAL]: { identity: { name: 'Fiscal' } } },
  brand_members: { [FISCAL]: { owners: { ownerA: { granted_at: 1 } }, managers: { [FISCAL]: { mgrOn01: { granted_at: 1 } } },
    manager_perms: { mgrOn01: { can_edit_menu: true } }, profiles: { mgrOn01: { name: 'Dania Reyes', email: 'dania@m.hn' } } } },
});
const as = (uid) => ({ uid, token: {} });
const owner = async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' });

// a live store whose 'ny' category takes FEWER extra groups than 'individual' (data, both sides), so moving a pizza there LOSES groups
function world() {
  const fs = makeDb();
  const live = buildSourceFromCode(FISCAL);
  const meta = (id) => fs.collection('restaurants').doc(FISCAL).collection('meta').doc(id);
  const L = buildSourceCandidate(FISCAL, live);
  // the production reader's shape (publish-request.js readActiveBuiltFrom): the built catalog + the extra RECORDS
  const readActiveBuilt = async () => ({ built: { ...L.built, extras: L.inputs.extras }, versionId: 'v1', extraRecords: L.built.extras });
  const ready = Promise.all([meta('source').set(live), meta('active_version').set({ version: 'v1', generation: 3 })]);
  const save = async (mutate) => {
    await ready;
    const { source, updateTime } = await PR.readDraftFrom(fs, FISCAL);
    const draft = JSON.parse(JSON.stringify(source)); mutate(draft);
    const r = await editCatalogCore({ db: fs, authorize: owner, readActiveBuilt, toPrecondition: PROD_DECODE, addProduct: ADD_PRODUCT }, { restaurantId: FISCAL, source: draft, baseSourceUpdateTime: updateTime }, {});
    assert.strictEqual(r.status, 200, `premise: the REAL save accepts the draft (${JSON.stringify(r.body).slice(0, 200)})`);
    return r.body;
  };
  const request = (token) => PR.requestPublishCore({ fs, db: rtdb(), now: () => 5000, readActiveBuilt, addProduct: ADD_PRODUCT, readDraft: (rid) => PR.readDraftFrom(fs, rid) }, as('mgrOn01'), { restaurantId: FISCAL, token });
  const ownerPublish = async (token) => {
    const { source, updateTime } = await PR.readDraftFrom(fs, FISCAL);
    return publishEditedCore({ db: {}, authorize: owner, readActiveBuilt, addProduct: ADD_PRODUCT, readDraft: async () => ({ source, updateTime }),
      publishVersion: async (_db, _r, input) => ({ versionId: 'v2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }) },
    { restaurantId: FISCAL, token, fiscalAck: true, acknowledgedChanges: ACK.list }, {});
  };
  const slot = async () => { const s = await PR.requestRefOf(fs, FISCAL).get(); return s.exists ? s.data() : null; };
  return { fs, live, save, request, ownerPublish, slot, ready, meta };
}

const viaOps = (...ops) => (d) => { let s = d; for (const op of ops) s = XT.apply(s, op).source; Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, s); };

(async () => {
  for (const [label, mutate, s2] of [
    ['today: a price change', (d) => { d.items[0].price += 10; d.items[0].display.price = d.items[0].price; }, false],
    ['S2: detach + group order', viaOps({ op: 'detach.item', item: 'Margherita', group: 'Carnes' }, { op: 'group.order', order: ['Carnes', 'Salsas & Queso', 'Vegetales & Hierbas'] }), true],
    ['S2: a new extra + a repriced one', (d) => { viaOps({ op: 'extra.add', group: 'Carnes', ref: 'tmp:chorizo-0001', name: 'Chorizo', price: 30 })(d); d.extras[0].price += 2; d.extras[0].display.price = d.extras[0].price; }, true],
  ]) {
    await cell(`THREE-PATH-EQUAL «${label}»: the request and the owner publish recompute the save's diff exactly`, async (L) => {
      const w = world();
      const saved = await w.save(mutate);
      assert.strictEqual('fiscal' in saved.diff, s2, `${L}: premise — the S2 fields ${s2 ? 'are' : 'are not'} in the save's diff`);
      ACK.list = saved.diff.largeChangeSet;
      const r = await w.request(saved.token);
      assert.strictEqual(r.status, 200, `${L}: the manager's request verifies the save's token (got ${JSON.stringify(r)})`);
      const p = await w.ownerPublish(saved.token);
      assert.strictEqual(p.status, 200, `${L}: the owner publish verifies the save's token (got ${JSON.stringify(p.body).slice(0, 200)})`);
    });
  }
  if (fails.length) { console.log(`s2core-three-path FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`s2core-three-path: OK (${n})`);
})();
