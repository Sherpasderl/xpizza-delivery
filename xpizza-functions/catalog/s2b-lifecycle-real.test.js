'use strict';
// S2b (PLAN-structure-S2b-r3 §7 LIFECYCLE; Codex S2b r1 P2-7) — THREE affected extras at three different prices (two RENAMED, one RETIRED
// name re-added under a MINTED key) through the REAL sequence on ONE Firestore fake: the save (editCatalogCore) → the owner publish
// (publishEditedCore → publishVersion) → a later save (a price edit) → the manager's request (requestPublishCore; x_pizza, the
// platform-factura brand) → the owner publish. After each publish, the REAL pricing tables price each extra at ITS key and price and
// label it; the server-owned frozen_extra_keys is kept across the second save. Switches: S2-core Extras ON, the dark S2b switch ON (stubbed;
// shipped OFF). Run: node catalog/s2b-lifecycle-real.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'l'.repeat(32);
{ const p = require.resolve('./platform-structure'); const real = require('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), extrasCatalog: true }) } }; }
{ const p = require.resolve('./extra-identity'); const real = require('./extra-identity'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, extraIdentityCapabilities: () => ({ mintExtras: true }) } }; }
const { makeDb } = require('./firestore-fake');
const { createFakeDb } = require('../merchant/_fake-db');
const { publishVersion, rollbackVersion, previewVersion } = require('./catalog-publish');
const { resetDraftToLiveCore } = require('./reset-draft');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('./source-store');
const { editCatalogCore } = require('./edit-catalog-handler');
const { publishEditedCore } = require('./publish-edited-handler');
const PR = require('./publish-request');
const { addProductIo } = require('./add-product-io');
const { createCatalogReader } = require('./catalog');
const { createPricingResolver } = require('./pricing-tables');
const CF = require('./catalog-firestore');
const MP = require('../menu-pricing');
const XT = require('./exposure-transitions');
const PROD_DECODE = (() => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../portal/functions.js'), 'utf8');
  const m = src.match(/function decodeUpdateTimeForEdit\(v\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'premise: portal/functions.js still defines decodeUpdateTimeForEdit');
  return new Function('FirestoreTimestamp', `${m[0]}; return decodeUpdateTimeForEdit;`)(require('firebase-admin/firestore').Timestamp);
})();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2b-lifecycle-real: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (o) => JSON.parse(JSON.stringify(o));
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
const owner = async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' });
const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });

function withoutExtra(src, key) {
  const s = clone(src); s.extras = s.extras.filter((e) => e.key !== key);
  if (Array.isArray(s.structure.extra_order)) s.structure.extra_order = s.structure.extra_order.filter((k) => k !== key);
  for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(key); if (i >= 0) v.splice(i, 1); }
  if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.filter((k) => k !== key);
  return s;
}
const inputOf = (rid, src, sha) => { const { inputs, built } = buildSourceCandidate(rid, src);
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }), ...(built.frozen_extra_keys == null ? {} : { frozen_extra_keys: built.frozen_extra_keys }) }; };

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const fs = makeDb();
    const rtdb = createFakeDb({ brands: { [rid]: legacy(rid) }, restaurants: { [rid]: { identity: { name: 'L' } } },
      brand_members: { [rid]: { owners: { ownerA: { granted_at: 1 } }, managers: { [rid]: { mgrOn01: { granted_at: 1 } } }, manager_perms: { mgrOn01: { can_edit_menu: true } }, profiles: { mgrOn01: { name: 'Gerente', email: 'g@m.hn' } } } } });
    const seed = canonicalize(buildSourceFromCode(rid));
    await fs.collection('restaurants').doc(rid).set({ pricing_key_mode: rid === 'la_musa' ? 'id' : 'name' });   // the restaurant profile the add-product I/O reads
    const [A, B, C] = seed.extras;
    // v0 = the seed; v1 = the seed WITHOUT C (C's key is then reserved as an extra's — a retired name)
    const v0 = (await quiet(() => publishVersion(fs, rid, inputOf(rid, seed, 'l0'), { expected: { activeVersionId: null } }))).versionId;
    const live1 = canonicalize(withoutExtra(seed, C.key));
    await quiet(() => publishVersion(fs, rid, inputOf(rid, live1, 'l1'), { expected: { activeVersionId: v0 } }));
    await sourceRefOf(fs, rid).set(live1);
    const deps = { db: fs, authorize: owner, readActiveBuilt: (r) => PR.readActiveBuiltFrom(fs, r), toPrecondition: PROD_DECODE, addProduct: addProductIo({ fs, rtdb }) };
    const save = async (draftOf) => { const { source, updateTime } = await PR.readDraftFrom(fs, rid); const d = draftOf(clone(source));
      return quiet(() => editCatalogCore(deps, { restaurantId: rid, source: d, baseSourceUpdateTime: updateTime }, {})); };
    const publish = async (token, diff) => quiet(() => publishEditedCore({ db: fs, authorize: owner, readActiveBuilt: (r) => PR.readActiveBuiltFrom(fs, r), readDraft: (r) => PR.readDraftFrom(fs, r), publishVersion, addProduct: addProductIo({ fs, rtdb }) },
      { restaurantId: rid, token, acknowledgedChanges: ((diff && diff.largeChangeSet) || []).map((l) => ({ key: l.key, surface: l.surface })), ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {}));
    const tables = async () => quiet(() => createPricingResolver({ reader: createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(fs, r) }), alarm: () => {} }).getPricingTables(rid));
    // ── save 1: rename A and B, re-add the retired C at a NEW price (three prices) ──
    const BP = B.price + 3;   // B is renamed AND repriced: three different prices
    const s1 = await save((d) => { const x = XT.apply(XT.apply(XT.apply(d, { op: 'extra.rename', key: A.key, name: 'Alfa Renombrada' }).source, { op: 'extra.rename', key: B.key, name: 'Beta Renombrada' }).source,
      { op: 'extra.add', group: C.display.cat, ref: 'tmp:life-reuse-01', name: C.display.name, price: C.price + 7 }).source; const b = x.extras.find((e) => e.key === B.key); b.price = BP; b.display.price = BP; return x; });
    assert.strictEqual(s1.status, 200, `S2BLR-SAVE1 ${rid}: ${show(s1)}`);
    const src1 = (await PR.readDraftFrom(fs, rid)).source;
    const minted = src1.extras.find((e) => e.display.name === C.display.name);
    assert.ok(minted && minted.key !== C.key && /^i_/.test(minted.key), `S2BLR-SAVE1 ${rid}: C is minted (${minted && minted.key})`);
    assert.deepStrictEqual(Object.keys(src1.frozen_extra_keys).sort(), [A.key, B.key, minted.key].sort(), `S2BLR-SAVE1 ${rid}: three recorded entries`);
    assert.ok(new Set([A.price, BP, C.price + 7]).size === 3, 'premise: three different prices');
    const p1 = await publish(s1.body.token, s1.body.diff);
    assert.strictEqual(p1.status, 200, `S2BLR-PUBLISH1 ${rid}: ${show(p1)}`);
    const check = async (label, cPrice) => {
      const T = await tables(); const L = MP.labelsOfTables(T) || {};
      assert.deepStrictEqual([T.extras[A.key], T.extras[B.key], T.extras[minted.key]], [A.price, BP, cPrice], `${label} ${rid}: each extra priced at ITS key`);
      assert.deepStrictEqual([L[`x:${A.key}`], L[`x:${B.key}`], L[`x:${minted.key}`]], ['Alfa Renombrada', 'Beta Renombrada', C.display.name], `${label} ${rid}: each labelled`);
      assert.ok(!Object.prototype.hasOwnProperty.call(T.extras, C.key), `${label} ${rid}: the retired key prices nothing`);
    };
    await check('S2BLR-AFTER1', C.price + 7);
    const vP1 = await CF.getActiveVersionId(fs, rid);
    // ── save 2: a later price edit of the minted extra; the map is kept ──
    const s2 = await save((d) => { const x = d.extras.find((e) => e.key === minted.key); x.price += 2; x.display.price = x.price; return d; });
    assert.strictEqual(s2.status, 200, `S2BLR-SAVE2 ${rid}: ${show(s2)}`);
    assert.deepStrictEqual((await PR.readDraftFrom(fs, rid)).source.frozen_extra_keys, src1.frozen_extra_keys, `S2BLR-SAVE2 ${rid}: the server-owned map is kept`);
    if (rid === 'x_pizza') {
      const req = await quiet(() => PR.requestPublishCore({ fs, db: rtdb, now: () => 5000, readActiveBuilt: (r) => PR.readActiveBuiltFrom(fs, r), readDraft: (r) => PR.readDraftFrom(fs, r) }, { uid: 'mgrOn01', token: {} }, { restaurantId: rid, token: s2.body.token }));
      assert.deepStrictEqual([req.status, req.body.ok], [200, true], `S2BLR-REQUEST ${rid}: the manager's request (${show(req)})`);
    }
    const p2 = await publish(s2.body.token, s2.body.diff);
    assert.strictEqual(p2.status, 200, `S2BLR-PUBLISH2 ${rid}: ${show(p2)}`);
    await check('S2BLR-AFTER2', C.price + 9);
    // ── rollback to the first published version, then reset the draft to it (Codex S2b r2 P2-7) ──
    const vP2 = await CF.getActiveVersionId(fs, rid);
    await quiet(() => rollbackVersion(fs, rid, vP1, { expected: { activeVersionId: vP2 } }));
    await check('S2BLR-ROLLBACK', C.price + 7);
    { const snap = await sourceRefOf(fs, rid).get();
      const r = await quiet(() => resetDraftToLiveCore({ db: fs, authorize: owner, readActiveVersionId: async () => vP1, previewVersion, toPrecondition: PROD_DECODE },
        { restaurantId: rid, expectedRevision: encodeUpdateTime(snap.updateTime) }, {}));
      assert.strictEqual(r.status, 200, `S2BLR-RESET ${rid}: ${show(r)}`);
      const d = (await PR.readDraftFrom(fs, rid)).source;
      assert.deepStrictEqual(d.frozen_extra_keys, src1.frozen_extra_keys, `S2BLR-RESET ${rid}: the draft takes the rolled-back version's map`);
      assert.strictEqual(d.extras.find((e) => e.key === minted.key).price, C.price + 7, `S2BLR-RESET ${rid}: the draft takes its prices`); }
    ok(`${rid}: two renamed + one minted extra at three prices — save → publish → save → ${rid === 'x_pizza' ? 'manager request → ' : ''}publish → rollback → reset, each priced and labelled at its own key; the map kept`);
  }
  FINISHED = true;
  console.log(`s2b-lifecycle-real: OK (${n})`);
})().catch((e) => { console.error('s2b-lifecycle-real FAILED:', e && (e.stack || e.message)); process.exit(1); });
