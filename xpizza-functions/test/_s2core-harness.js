'use strict';
// S2-core (Codex build r1) — ONE real-handler harness for the Extras page: the REAL editCatalogCore, publishEditedCore and
// requestPublishCore on one Firestore fake (the publish-request-consequences / s2core-three-path world), both brands, every switch
// MUTABLE through SW (require this file BEFORE any handler: it installs the switch stubs first). The production precondition decoder
// is evaluated from its own source, so the save is never laxer than production.
//   const H = require('../test/_s2core-harness'); H.SW.extrasCatalog = false; const w = H.world('la_musa');
//   await w.save(source | (draft) => mutate)  → the raw { status, body }
//   await w.store(source)                     → writes the draft directly (a draft an older server or a raced save left)
//   await w.tokenFor()                        → a VALID token for the stored draft (the canonical diff under the current switch)
//   await w.ownerPublish(token) / w.request(token) / w.publishes
const assert = require('assert');
const path = require('path');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'p'.repeat(32);
const SW = { extrasCatalog: true, extrasAuthoring: false, textEdit: true };
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsOf(real) }; };
stub('../catalog/item-text-edit', (r) => ({ ...r, textEditCapabilities: () => ({ enabled: SW.textEdit }) }));
stub('../catalog/platform-structure', (r) => ({ ...r, structureCapabilities: () => ({ ...r.structureCapabilities(), extrasCatalog: SW.extrasCatalog }) }));
stub('../catalog/platform-extras', (r) => ({ ...r, extrasCapabilities: () => ({ ...r.extrasCapabilities(), authoring: SW.extrasAuthoring }) }));

const { createFakeDb } = require('../merchant/_fake-db');
const { makeDb } = require('../catalog/firestore-fake');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { issueEditToken, sha256 } = require('../catalog/catalog-edit');
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const PR = require('../catalog/publish-request');
const PROD_DECODE = (() => {
  const src = require('fs').readFileSync(path.join(__dirname, '../portal/functions.js'), 'utf8');
  const m = src.match(/function decodeUpdateTimeForEdit\(v\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'premise: portal/functions.js still defines decodeUpdateTimeForEdit');
  return new Function('FirestoreTimestamp', `${m[0]}; return decodeUpdateTimeForEdit;`)(require('firebase-admin/firestore').Timestamp);
})();
const clone = (o) => JSON.parse(JSON.stringify(o));
const owner = async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' });
// the platform-factura location is the only brand a manager REQUESTS on (factura/eligibility data)
const managerDb = (rid) => createFakeDb({
  brands: { [rid]: { name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } } },
  restaurants: { [rid]: { identity: { name: 'Fiscal' } } },
  brand_members: { [rid]: { owners: { ownerA: { granted_at: 1 } }, managers: { [rid]: { mgrOn01: { granted_at: 1 } } },
    manager_perms: { mgrOn01: { can_edit_menu: true } }, profiles: { mgrOn01: { name: 'Dania Reyes', email: 'dania@m.hn' } } } },
});
const addProductOf = (rid, reserved) => ({ readKeyMode: async () => (rid === 'la_musa' ? 'id' : 'name'), hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }),
  registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => reserved() });

function world(rid, { live: liveSource = null, reserved = () => require('../catalog/reserved-keys').reservedKeySet(undefined) } = {}) {
  const fs = makeDb();
  const live = liveSource ? clone(liveSource) : buildSourceFromCode(rid);
  const meta = (id) => fs.collection('restaurants').doc(rid).collection('meta').doc(id);
  const L = buildSourceCandidate(rid, live);
  const readActiveBuilt = async () => ({ built: { ...L.built, extras: L.inputs.extras }, versionId: 'v1', extraRecords: L.built.extras });
  const ready = Promise.all([meta('source').set(clone(live)), meta('active_version').set({ version: 'v1', generation: 3 })]);
  const addProduct = addProductOf(rid, reserved);
  const publishes = [];
  const draft = async () => { await ready; return PR.readDraftFrom(fs, rid); };
  const save = async (srcOrMutate) => {
    const { source, updateTime } = await draft();
    let next = clone(source);
    if (typeof srcOrMutate === 'function') srcOrMutate(next); else next = clone(srcOrMutate);
    return editCatalogCore({ db: fs, authorize: owner, readActiveBuilt, toPrecondition: PROD_DECODE, addProduct }, { restaurantId: rid, source: next, baseSourceUpdateTime: updateTime }, {});
  };
  const store = async (source) => { await ready; await meta('source').set(clone(source)); };
  const tokenFor = async () => {
    const { source, updateTime } = await draft();
    const D = buildSourceCandidate(rid, source);
    const diff = require('../catalog/review-diff').reviewDiff({ live: { ...L.built, extras: L.inputs.extras }, liveExtraRecords: L.built.extras,
      draftBuilt: { ...D.built, extras: D.inputs.extras }, draftExtraRecords: D.built.extras, extrasCatalog: SW.extrasCatalog });
    return { token: issueEditToken({ rid, baseActiveVersionId: 'v1', sourceUpdateTime: updateTime, sourceHash: sha256(source), diff }), diff };
  };
  const ownerPublish = async (token, ack = []) => {
    const { source, updateTime } = await draft();
    return publishEditedCore({ db: {}, authorize: owner, readActiveBuilt, readDraft: async () => ({ source, updateTime }), addProduct,
      publishVersion: async (_db, _r, input) => { publishes.push(input); return { versionId: 'v2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; } },
    { restaurantId: rid, token, fiscalAck: true, acknowledgedChanges: ack }, {});
  };
  const request = (token) => PR.requestPublishCore({ fs, db: managerDb(rid), now: () => 5000, readActiveBuilt, addProduct, readDraft: (r) => PR.readDraftFrom(fs, r) }, { uid: 'mgrOn01', token: {} }, { restaurantId: rid, token });
  const slot = async () => { const s = await PR.requestRefOf(fs, rid).get(); return s.exists ? s.data() : null; };
  return { fs, live, L, save, store, draft, tokenFor, ownerPublish, request, slot, publishes };
}

module.exports = { SW, world, clone };
