'use strict';
// «Quitar del menú» × rollback (Codex #176 P2-1, advisor 11-19). Removing a dish takes its OWN references with it (P-R4:
// exposure.item_overrides[key], extras_by_item[key], its redeem_eligible_items entry). A rollback to a version that still has the dish
// restores the dish's row, identity stamp and item_order into the editable source (catalog-publish's re-add) — and must restore those
// same references too, or the restored source no longer matches the live version and the next assessment / save is refused
// (structure_changed on redeem_eligible_items).
//   RB-REFS  la_musa soft_01 (an item-level reward entry) and x_pizza Nutella (an item override): remove → owner publish → rollback →
//            the draft carries the dish's own references as the live version has them, and assessDraft is publishable.
// Real sequence on ONE Firestore fake: editCatalogCore → publishEditedCore → publishVersion → rollbackVersion → assessDraft.
// Run: node catalog/rollback-refs.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'r'.repeat(32);
const { makeDb } = require('./firestore-fake');
const { createFakeDb } = require('../merchant/_fake-db');
const { publishVersion, rollbackVersion } = require('./catalog-publish');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('./source-store');
const { editCatalogCore } = require('./edit-catalog-handler');
const { publishEditedCore } = require('./publish-edited-handler');
const { assessDraft } = require('./draft-assess');
const PR = require('./publish-request');
const { addProductIo } = require('./add-product-io');
const CF = require('./catalog-firestore');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 260)}`;
const owner = async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' });
const PROD_DECODE = (() => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../portal/functions.js'), 'utf8');
  const m = src.match(/function decodeUpdateTimeForEdit\(v\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'premise: portal/functions.js still defines decodeUpdateTimeForEdit');
  return new Function('FirestoreTimestamp', `${m[0]}; return decodeUpdateTimeForEdit;`)(require('firebase-admin/firestore').Timestamp);
})();
const inputOf = (rid, src, sha) => { const { inputs, built } = buildSourceCandidate(rid, src);
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }; };
function removed(src, key) {   // the portal's removal: the row, its order slot and its OWN references (P-R4)
  const s = clone(src);
  s.items = s.items.filter((i) => i.key !== key);
  s.structure.item_order = s.structure.item_order.filter((k) => k !== key);
  const ov = s.structure.exposure && s.structure.exposure.item_overrides; if (ov && ov[key]) delete ov[key];
  if (s.structure.extras_by_item && s.structure.extras_by_item[key]) delete s.structure.extras_by_item[key];
  if (Array.isArray(s.structure.redeem_eligible_items)) s.structure.redeem_eligible_items = s.structure.redeem_eligible_items.filter((k) => k !== key);
  return s;
}

async function run(rid, KEY) {
  const fs = makeDb();
  const rtdb = createFakeDb({ brands: { [rid]: { name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } } }, restaurants: { [rid]: { identity: { name: 'L' } } },
    brand_members: { [rid]: { owners: { ownerA: { granted_at: 1 } } } } });
  await fs.collection('restaurants').doc(rid).set({ pricing_key_mode: rid === 'la_musa' ? 'id' : 'name' });
  const seed = canonicalize(buildSourceFromCode(rid));
  const refsOf = (st) => ({ ov: ((st.exposure || {}).item_overrides || {})[KEY] || null, ebi: (st.extras_by_item || {})[KEY] || null, rei: (st.redeem_eligible_items || []).includes(KEY) });
  const r0 = refsOf(seed.structure);
  assert.ok(r0.ov || r0.ebi || r0.rei, `premise: ${rid} ${KEY} has an own reference`);
  const v0 = (await quiet(() => publishVersion(fs, rid, inputOf(rid, seed, 'rb0'), { expected: { activeVersionId: null } }))).versionId;
  await sourceRefOf(fs, rid).set(seed);
  await quiet(() => require('./identity-bootstrap').bootstrapIdentityStamps(fs, rid));   // the REAL cutover certifies v0 and stamps the source
  const live0 = await PR.readActiveBuiltFrom(fs, rid);
  const stampOf = live0.built.items.find((i) => i.key === KEY).display.identity_id;
  assert.ok(typeof stampOf === 'string' && stampOf, 'premise: the published dish carries an identity stamp');
  const gen = (await fs.collection('restaurants').doc(rid).collection('meta').doc('active_version').get()).data().generation;

  // remove soft_01 (with its reward entry) → the owner publishes it
  const deps = { db: fs, authorize: owner, readActiveBuilt: (r) => PR.readActiveBuiltFrom(fs, r), toPrecondition: PROD_DECODE, addProduct: addProductIo({ fs, rtdb }) };
  const { source, updateTime } = await PR.readDraftFrom(fs, rid);
  const s1 = await quiet(() => editCatalogCore(deps, { restaurantId: rid, source: { ...removed(source, KEY), deleted_ids: { ids: [stampOf] } }, baseSourceUpdateTime: updateTime,
    deleted_ids_loaded_base: { version: v0, generation: gen } }, {}));
  assert.strictEqual(s1.status, 200, `RB-REFS premise: the removal saves (${show(s1)})`);
  const p1 = await quiet(() => publishEditedCore({ db: fs, authorize: owner, readActiveBuilt: (r) => PR.readActiveBuiltFrom(fs, r), readDraft: (r) => PR.readDraftFrom(fs, r), publishVersion, addProduct: addProductIo({ fs, rtdb }) },
    { restaurantId: rid, token: s1.body.token, acknowledgedChanges: ((s1.body.diff && s1.body.diff.largeChangeSet) || []).map((l) => ({ key: l.key, surface: l.surface })), ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {}));
  assert.strictEqual(p1.status, 200, `RB-REFS premise: the removal publishes (${show(p1)})`);
  const v1 = await CF.getActiveVersionId(fs, rid);
  assert.ok(!(await PR.readActiveBuiltFrom(fs, rid)).built.items.some((i) => i.key === KEY), 'RB-REFS premise: the dish is off the live menu');
  assert.deepStrictEqual(refsOf((await PR.readDraftFrom(fs, rid)).source.structure), { ov: null, ebi: null, rei: false }, 'RB-REFS premise: the draft dropped its own references');

  // rollback to v0 (which has soft_01 and its reward entry)
  await quiet(() => rollbackVersion(fs, rid, v0, { expected: { activeVersionId: v1 } }));
  const live = await PR.readActiveBuiltFrom(fs, rid);
  assert.ok(live.built.items.some((i) => i.key === KEY), 'RB-REFS premise: the rollback put the dish back live');
  const draft = (await PR.readDraftFrom(fs, rid)).source;
  assert.ok(draft.items.some((i) => i.key === KEY), 'RB-REFS premise: the rollback re-added the dish row to the draft');
  assert.deepStrictEqual(refsOf(draft.structure), refsOf(live.built.structure), `🔴 RB-REFS ${rid}: the rollback restores ${KEY}'s OWN references (as the live version has them)`);
  assert.deepStrictEqual(draft.structure.redeem_eligible_items, live.built.structure.redeem_eligible_items, `🔴 RB-REFS ${rid}: the reward list equals the live version's, in order`);
  const a = assessDraft(rid, draft, live);
  assert.strictEqual(a.publishable, true, `🔴 RB-REFS: the rolled-back draft is publishable (${JSON.stringify(a).slice(0, 200)})`);
  ok(`RB-REFS ${rid} ${KEY} (${Object.entries(r0).filter(([, v]) => v).map(([k]) => k).join('+')}): remove → publish → rollback restores its row, order AND its own references; the draft assesses publishable`);
}
(async () => {
  await run('la_musa', 'soft_01');   // an item-level reward entry
  await run('x_pizza', 'Nutella');   // an item override (Codex remove-refs r1's case)
  console.log(`rollback-refs: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
