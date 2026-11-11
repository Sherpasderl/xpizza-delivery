'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.1, §3.1; T3, T4) — the Extras page through the REAL editCatalogCore / publishEditedCore, the
// extrasCatalog switch stubbed ON then OFF: a new extra (a tmp ref) saves with its server-allocated key and publishes; a draft saved
// while the switch was on cannot publish its extras change after it is turned off. Run: node catalog/s2core-flow.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
// the platform extras-authoring switch, made settable (shipped OFF; cell 4 turns it ON) — before the handlers load it
const EXTRAS = { authoring: false };
const STRUCT = { extrasCatalog: true };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: STRUCT.extrasCatalog, choiceEdit: false, sections: false }) } }; }
{ const p = require.resolve('./platform-extras'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { extrasCapabilities: () => ({ ...EXTRAS }) } }; }
const { editCatalogCore } = require('./edit-catalog-handler');
const { publishEditedCore } = require('./publish-edited-handler');
const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublicMenu } = require('./public-menu');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2core-flow: FAILED — exited without completing'); process.exitCode = 1; } });

const T0 = '2026-10-24T10:00:00.000000Z';
const T1 = '2026-10-24T11:00:00.000000Z';
const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const asRole = (role) => async () => ({ ok: true, uid: `u_${role}`, role, actor: `${role}@x.hn` });
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = (rid) => clone(buildSourceFromCode(rid));
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const liveRead = (rid) => async () => {
  const src = base(rid); const i = sourceToBuildInputs(src);
  return { built: builtOf(src, rid), versionId: ACTIVE, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }).extras };
};
const NAMES = { x_pizza: ['Pizzas de 12', 'NY de 18'], la_musa: ['Dim Sum de la Casa'] };
const renamed = (rid) => { const s = base(rid); NAMES[rid].forEach((nm, i) => { s.structure.categories[i].name = nm; }); return s; };

// The save side: a source doc with a faithful update-time precondition (the edit-catalog.test.js stub, cut to what a
// rename touches).
function saveDb(rid) {
  const state = { source: { data: base(rid), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => {
      if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; }
      state.source = { data, updateTime: T1 }; return { writeTime: T1 };
    },
  });
  return { state, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
const save = (rid, source, { authorize = owner } = {}) => {
  const db = saveDb(rid);
  const addProduct = { readKeyMode: async () => (rid === 'la_musa' ? 'id' : 'name'), hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }), registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => require('./reserved-keys').reservedKeySet(undefined) };
  return editCatalogCore({ db, authorize, readActiveBuilt: liveRead(rid), addProduct }, { restaurantId: rid, source, baseSourceUpdateTime: T0 }, {}).then((r) => ({ r, db }));
};
// The publish side: the draft the save wrote, the live version, and every publish attempt recorded.
const publishDeps = (rid, draft, { authorize = owner, draftUpdateTime = T1 } = {}) => {
  const state = { publishes: [] };
  return {
    state,
    deps: {
      db: {}, authorize, readActiveBuilt: liveRead(rid),
      readDraft: async () => ({ source: draft, updateTime: draftUpdateTime }),
      publishVersion: async (_db, r, input, opts) => { state.publishes.push({ r, input, opts }); return { versionId: 'v-new-2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; },
    },
  };
};
// The served menu of what the publish handler ACTUALLY handed to publishVersion: that exact input (and its options),
// through the real publishVersion on a fresh store, read back by buildPublicMenu.
async function served(rid, captured) {
  const db = makeDb();
  // the INPUT is exactly the handler's; only the flip CAS is re-aimed — a fresh store has no active version and no draft
  // revision to compare against (the handler's own CAS is pinned by publish-edited.test.js)
  await publishVersion(db, rid, captured.input, { expected: { activeVersionId: null } });
  return (await buildPublicMenu(db, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true })).body;
}


(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const draft = base(rid); const g = draft.extras[0].display.cat;
    draft.extras.push({ ref: 'tmp:nuevo00001', price: 15, display: { name: 'Extra Nuevo', cat: g, price: 15 } });
    STRUCT.extrasCatalog = true;
    const { r, db } = await save(rid, draft);
    assert.strictEqual(r.status, 200, `SF-SAVE ${rid}: the Extras-page draft saves (${JSON.stringify(r.body).slice(0, 200)})`);
    const stored = db.state.source.data;
    const row = stored.extras.find((e) => e.display && e.display.name === 'Extra Nuevo');
    assert.ok(row && typeof row.key === 'string' && !('ref' in row), `SF-ALLOC ${rid}: the server allocated the key (${JSON.stringify(row)})`);
    assert.strictEqual(row.key, rid === 'la_musa' ? 'extra_nuevo' : 'Extra Nuevo', `SF-ALLOC ${rid}: the key mapping`);
    const p = publishDeps(rid, stored);
    const pub = await publishEditedCore(p.deps, { restaurantId: rid, token: r.body.token, acknowledgedChanges: r.body.diff.largeChangeSet, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {});
    assert.strictEqual(pub.status, 200, `SF-PUBLISH ${rid}: publishes (${JSON.stringify(pub.body).slice(0, 200)})`);
    assert.ok(Object.prototype.hasOwnProperty.call(p.state.publishes[0].input.extras, row.key), `SF-PUBLISH ${rid}: the version carries the new extra`);
    STRUCT.extrasCatalog = false;   // T3: saved ON, published OFF
    const p2 = publishDeps(rid, stored);
    const off = await publishEditedCore(p2.deps, { restaurantId: rid, token: r.body.token, acknowledgedChanges: r.body.diff.largeChangeSet, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {});
    assert.ok(off.status >= 400 && p2.state.publishes.length === 0, `SF-SWITCH-OFF-PUBLISH ${rid}: refused, nothing published (${off.status} ${JSON.stringify(off.body).slice(0, 160)})`);
    // m3: the publish's OWN structural judgment follows the switch — even a token bound to the switch-OFF diff of that very draft
    // (the token re-match cannot be what refuses here) cannot publish the extras change
    {
      const L0 = await liveRead(rid)(); const { inputs: i, built: b } = require('./candidate-validate').buildSourceCandidate(rid, stored);
      const offDiff = require('./review-diff').reviewDiff({ live: L0.built, liveExtraRecords: L0.extraRecords, draftBuilt: { ...b, extras: i.extras }, draftExtraRecords: b.extras, extrasCatalog: false });
      const tok = issueEditToken({ rid, baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(stored), diff: offDiff });
      const p3 = publishDeps(rid, stored);
      const judged = await publishEditedCore(p3.deps, { restaurantId: rid, token: tok, acknowledgedChanges: offDiff.largeChangeSet, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {});
      assert.deepStrictEqual([judged.status, judged.body.error, p3.state.publishes.length], [400, 'extras_changed', 0], `SF-SWITCH-OFF-COMPARE ${rid}: the publish's compare refuses the extras change (${judged.status} ${JSON.stringify(judged.body).slice(0, 160)})`);
    }
    const { r: r2 } = await save(rid, draft);
    assert.deepStrictEqual([r2.status, r2.body.error], [400, 'extras_catalog_not_supported_yet'], `SF-SWITCH-OFF-SAVE ${rid}: (${JSON.stringify(r2.body).slice(0, 160)})`);
    STRUCT.extrasCatalog = true;
    ok(`${rid}: a new extra saves with its server key and publishes (switch ON); OFF, the save and the publish of that change are refused`);
  }
  FINISHED = true;
  console.log(`s2core-flow: OK (${n})`);
})().catch((e) => { console.error('s2core-flow FAILED:', e && e.message); process.exit(1); });
