'use strict';
// 1D add-product PHASE A — the catalog + portal half of `npm run test:add-product`, through the REAL cores on the
// emulator (Firestore + RTDB): editCatalogCore → publishEditedCore → publishVersion, getEditableCatalogCore,
// resetDraftToLiveCore, rollbackVersion + the KDS sync, with the production add-product I/O (catalog/add-product-io.js).
// Each brand is run CERTIFIED (bootstrapped) and UNCERTIFIED.
require('./_emulator-required')('firestore', 'database');

const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'add-product-secret-'.padEnd(48, 'x');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.firestore();
const rtdb = admin.database();

const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { getEditableCatalogCore } = require('../catalog/portal-reads');
const { resetDraftToLiveCore } = require('../catalog/reset-draft');
const { publishVersion, previewVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo, hwmRefOf } = require('../catalog/add-product-io');
const { keysColOf, idsColOf, encodeKey } = require('../catalog/identity-registry');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { bootstrapIdentityStamps, readActiveVersion } = require('../catalog/identity-bootstrap');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('add-product(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const toPrecondition = (v) => {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new admin.firestore.Timestamp(Number(sec), Number(nanos));
};
const as = (role) => async () => ({ ok: true, uid: `u_${role}`, role, actor: `${role}@x.hn` });
const io = addProductIo({ fs: db, rtdb });
const readActiveBuilt = (rid) => async () => {
  const versionId = await getActiveVersionId(db, rid);
  const p = await previewVersion(db, rid, versionId);
  const extras = {}; for (const e of p.extras) extras[e.key] = e.price;
  return { built: { items: p.items, structure: p.structure, extras }, versionId, extraRecords: p.extras };
};
const readDraft = (rid) => async () => { const s = await sourceRefOf(db, rid).get(); return { source: s.data(), updateTime: encodeUpdateTime(s.updateTime) }; };
const rev = async (rid) => encodeUpdateTime((await sourceRefOf(db, rid).get()).updateTime);
const draft = async (rid) => (await sourceRefOf(db, rid).get()).data();
const save = async (rid, source, role = 'owner') => editCatalogCore({ db, authorize: as(role), readActiveBuilt: readActiveBuilt(rid), toPrecondition, addProduct: io },
  { restaurantId: rid, source, baseSourceUpdateTime: await rev(rid) }, {});
const publish = (rid, saved, role = 'owner') => publishEditedCore({ db, authorize: as(role), readActiveBuilt: readActiveBuilt(rid), readDraft: readDraft(rid), publishVersion,
  mirror: makeRtdbMirror(rtdb), sourceSha: 'add-product', addProduct: io },
  { restaurantId: rid, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, {});
const editable = (rid) => getEditableCatalogCore({ db: rtdb, fsdb: db, authorize: as('owner'), readActiveVersionId: (f, r) => getActiveVersionId(f, r), readActiveBuilt: readActiveBuilt(rid) },
  { method: 'GET', query: { restaurantId: rid } });
let T = 0;
const tmp = () => `tmp:aaaaaaaa-${String(T += 1).padStart(4, '0')}`;
const CAT = { x_pizza: 'ny', la_musa: 'noodles' };
const withAdds = (rid, src, names) => {
  const s = JSON.parse(JSON.stringify(src));
  for (const name of names) { const ref = tmp(); s.items.push({ ref, price: 555, display: { cat: CAT[rid], name, price: 555, desc: 'nuevo' } }); s.structure.item_order.push(ref); }
  return s;
};
const priced = (src, delta = 1) => { const s = JSON.parse(JSON.stringify(src)); s.items[0].price += delta; s.items[0].display.price = s.items[0].price; return s; };
const manifest = async (rid) => (await rtdb.ref(`menus/${rid}`).get()).val();
const meta = async (rid) => (await rtdb.ref(`menus/_meta/${rid}`).get()).val();

async function seedBrand(rid, { certify }) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = require('../tools/publish-version').buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  if (certify) { const b = await bootstrapIdentityStamps(db, rid); assert.ok(b.stamped, `${rid}: certified baseline ${JSON.stringify(b)}`); }
}
const wipe = async () => {
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
};

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const certify of [true, false]) {
      const tag = `${rid}/${certify ? 'certified' : 'uncertified'}`;
      await wipe(); await seedBrand(rid, { certify });
      const base = await draft(rid);
      // ── SAVE: allocation, stable across saves ──
      const s1 = await save(rid, withAdds(rid, base, ['Producto Nuevo']));
      assert.strictEqual(s1.status, 200, `${tag} save: ${JSON.stringify(s1.body).slice(0, 300)}`);
      const added = s1.body.source.items.at(-1);
      assert.ok(!('ref' in added) && typeof added.key === 'string', `${tag}: allocated`);
      if (rid === 'x_pizza') {
        assert.ok(Number.isInteger(added.display.id) && added.display.id > Math.max(...base.items.map((i) => i.display.id)), `${tag}: id above the live max`);
        assert.strictEqual((await hwmRefOf(db, rid).get()).data().value, added.display.id, `${tag}: the high-water mark advanced in the same commit`);
      } else assert.strictEqual(added.key, 'producto_nuevo');
      assert.deepStrictEqual(await draft(rid), s1.body.source, `${tag}: the response IS the stored canonical source`);
      const s2 = await save(rid, s1.body.source);   // back to editing → review again
      assert.strictEqual(s2.status, 200);
      assert.deepStrictEqual(s2.body.source.items.at(-1), added, `${tag}: allocation is stable across saves`);
      assert.ok(s2.body.diff.added.some((a) => a.key === added.key) && s2.body.diff.largeChangeSet.some((x) => x.key === added.key), `${tag}: the review lists it and it needs an ack`);
      // ── PUBLISH ──
      const p1 = await publish(rid, s2);
      assert.strictEqual(p1.status, 200, `${tag} publish: ${JSON.stringify(p1.body).slice(0, 300)}`);
      assert.ok(!('kds_sync_pending' in p1.body), `${tag}: the KDS list synced`);
      const live = await previewVersion(db, rid, await getActiveVersionId(db, rid));
      assert.ok(live.items.some((i) => i.key === added.key), `${tag}: live`);
      const ptr = await getActivePointer(db, rid);
      assert.ok((await manifest(rid)).some((r) => r.key === added.key && r.category === CAT[rid]), `${tag}: the KDS manifest has the new row`);
      assert.deepStrictEqual([(await meta(rid)).source_generation, (await meta(rid)).version_id], [ptr.generation, ptr.version], `${tag}: stamped with the activation`);
      const keyRow = await keysColOf(db, rid, 'dish').doc(encodeKey(added.key)).get();
      assert.ok(keyRow.exists, `${tag}: the identity was registered on publish`);
      // ── publish → immediate price edit → publish (no stale revision; stamps present when certified) ──
      const e1 = await editable(rid);
      assert.strictEqual(e1.status, 200); assert.ok(!('draft_unpublishable' in e1.body), `${tag}: ${JSON.stringify(e1.body.draft_unpublishable)}`);
      const s3 = await save(rid, priced(e1.body.source));
      assert.strictEqual(s3.status, 200, `${tag} price edit: ${JSON.stringify(s3.body).slice(0, 300)}`);
      assert.strictEqual((await publish(rid, s3)).status, 200, `${tag}: price publish after the add`);
      ok(`${tag}: add → allocate (stable) → review (+ack) → publish → live + KDS row (stamped with the activation) + identity registered → immediate price edit publishes`);

      // ── refusals at SAVE (nothing written) ──
      const before = await rev(rid);
      const cur = await draft(rid);
      const staff = await save(rid, withAdds(rid, cur, ['Por Staff']), 'staff');
      assert.deepStrictEqual([staff.status, staff.body.error], [403, 'not_owner']);
      const twin = await save(rid, withAdds(rid, cur, [added.display.name.toUpperCase()]));
      assert.deepStrictEqual([twin.status, twin.body.error], [400, 'name_taken'], `${tag}: ${JSON.stringify(twin.body)}`);
      await keysColOf(db, rid, 'dish').doc(encodeKey(rid === 'x_pizza' ? 'Ya Existio' : 'ya_existio')).set({ canonical_id: 'old', legacy_key: 'x' });
      const reused = await save(rid, withAdds(rid, cur, ['Ya Existio']));
      assert.deepStrictEqual([reused.status, reused.body.error, reused.body.detail], [400, 'name_previously_used', 'Ese nombre ya existió en tu menú — usá otro nombre.']);
      const many = await save(rid, withAdds(rid, cur, Array.from({ length: 21 }, (_, i) => `Muchos ${i}`)));
      assert.deepStrictEqual([many.status, many.body.error], [400, 'too_many_additions']);
      const renamed = JSON.parse(JSON.stringify(cur)); renamed.items[0].display.desc = 'cambiada';
      const rn = await save(rid, renamed);
      assert.deepStrictEqual([rn.status, rn.body.error], [400, 'existing_item_changed']);
      const forged = withAdds(rid, cur, ['Con Llave']); forged.items.at(-1).key = 'Con Llave';
      const fk = await save(rid, forged);
      assert.deepStrictEqual([fk.status, fk.body.error], [400, 'client_supplied_key']);
      assert.strictEqual(await rev(rid), before, `${tag}: no refused save wrote anything`);
      ok(`${tag}: refused at save with nothing written — staff adds (403), a folded duplicate name, a name with a registry row ("Ese nombre ya existió…"), > 20 additions, an existing item changed, a client key`);

      // ── ROLLBACK after the add (certified target → retired; uncertified → stays live) ──
      const versions = (await db.collection('restaurants').doc(rid).collection('versions').get()).docs.map((d) => d.id);
      const seedVersion = (await db.collection('restaurants').doc(rid).collection('versions').orderBy('created_at').limit(1).get()).docs[0].id;
      assert.ok(versions.length >= 3);
      const target = await readActiveVersion(db, rid).then(() => seedVersion);
      const targetCertified = ((await db.collection('restaurants').doc(rid).collection('versions').doc(target).get()).data() || {}).identity_certified === true;
      const addedId = (await keysColOf(db, rid, 'dish').doc(encodeKey(added.key)).get()).data().canonical_id;
      const now = await getActivePointer(db, rid);
      await rollbackVersion(db, rid, target, { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: now.version, activeGeneration: now.generation } });
      const k = await io.syncKds(rid, { versionId: target });
      assert.strictEqual(k.written, true, `${tag}: the rollback rewrites the KDS list ${JSON.stringify(k)}`);
      assert.ok(!(await manifest(rid)).some((r) => r.key === added.key), `${tag}: the KDS list dropped the product`);
      assert.strictEqual((await meta(rid)).source_generation, (await getActivePointer(db, rid)).generation);
      // §0b.2: a CERTIFIED target retires the added identity; an UNCERTIFIED one leaves it live (no reconciliation, as today)
      const idDoc = (await idsColOf(db, rid, 'dish').doc(addedId).get()).data() || {};
      assert.strictEqual(idDoc.status, targetCertified ? 'retired' : 'live', `${tag}: rollback to a ${targetCertified ? 'certified' : 'uncertified'} target → identity ${idDoc.status}`);
      // the saved source still carries the addition (unpublished); the owner removes it with "Quitar" — a save without it
      const afterRb = await draft(rid);
      assert.ok(afterRb.items.some((i) => i.key === added.key), `${tag}: the source retains the addition after a rollback`);
      const assessed = await editable(rid);
      assert.strictEqual(assessed.status, 200);
      const quitar = JSON.parse(JSON.stringify(afterRb));
      quitar.items = quitar.items.filter((i) => i.key !== added.key); quitar.structure.item_order = quitar.structure.item_order.filter((x) => x !== added.key);
      const q = await save(rid, quitar);
      assert.strictEqual(q.status, 200, `${tag} Quitar: ${JSON.stringify(q.body).slice(0, 300)}`);
      const back = await save(rid, priced(q.body.source));
      assert.strictEqual((await publish(rid, back)).status, 200, `${tag}: a price publish after the rollback`);
      /* Re-adding the SAME name after the rollback (§2: "no promise beyond the key namespace"):
         • a certified target RETIRED the identity and DELETED its key row — for a name-keyed brand the name is free
           again and a fresh identity is minted on publish; for a slug brand the retired id keeps the slug reserved,
           so it is refused (re-adding would otherwise save and then fail every publish with identity_slug_retired);
         • an uncertified target left the identity LIVE with its key row — refused for both. */
      const again = await save(rid, withAdds(rid, await draft(rid), [added.display.name]));
      if (targetCertified && rid === 'x_pizza') assert.strictEqual(again.status, 200, `${tag}: the name is free again: ${JSON.stringify(again.body).slice(0, 200)}`);
      else assert.deepStrictEqual([again.status, again.body.error], [400, 'name_previously_used'], `${tag}: the name stays taken after a rollback`);
      ok(`${tag}: rollback → identity ${targetCertified ? 'RETIRED' : 'stays LIVE'} (§0b.2) → the KDS list drops the product (re-stamped) → the source keeps it as an unpublished addition → "Quitar" → a price publish succeeds → re-adding the name: ${targetCertified && rid === 'x_pizza' ? 'free again (key row deleted)' : 'refused'}`);
    }
  }

  // ── a POISONED draft (written directly, as a pre-existing one would be) → draft_unpublishable → reset → price publish ──
  {
    const rid = 'x_pizza';
    await wipe(); await seedBrand(rid, { certify: false });
    const p = await draft(rid);
    const poisoned = JSON.parse(JSON.stringify(p));
    const maxId = Math.max(...p.items.map((i) => i.display.id));
    poisoned.items.push({ key: 'Launcher', price: 600, display: { id: maxId + 1, cat: 'ny', name: 'Launcher', price: 600 } },
      { key: 'Launcher - Roja', price: 600, display: { id: maxId + 2, cat: 'ny', name: 'Launcher - Roja', price: 600, variantOf: maxId + 1, choice: 'Roja' } });
    poisoned.structure.item_order.push('Launcher', 'Launcher - Roja'); poisoned.structure.variant_items = { [maxId + 1]: { label: 'Salsa', variantIds: [maxId + 2] } };
    await sourceRefOf(db, rid).set(poisoned);
    const e = await editable(rid);
    assert.ok(e.body.draft_unpublishable, `the poisoned draft is reported: ${JSON.stringify(e.body).slice(0, 200)}`);
    const refused = await save(rid, priced(poisoned));
    assert.strictEqual(refused.status, 400, 'and it can no longer be saved');
    const r = await resetDraftToLiveCore({ db, authorize: as('owner'), readActiveVersionId: (f, x) => getActiveVersionId(f, x), previewVersion, toPrecondition },
      { restaurantId: rid, expectedRevision: e.body.sourceUpdateTime }, {});
    assert.strictEqual(r.status, 200, `reset: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(!(await editable(rid)).body.draft_unpublishable, 'publishable after the reset');
    const s = await save(rid, priced(await draft(rid)));
    assert.strictEqual(s.status, 200, `price save after reset: ${JSON.stringify(s.body).slice(0, 200)}`);
    assert.strictEqual((await publish(rid, s)).status, 200, 'price publish after reset');
    const stale = await resetDraftToLiveCore({ db, authorize: as('owner'), readActiveVersionId: (f, x) => getActiveVersionId(f, x), previewVersion, toPrecondition },
      { restaurantId: rid, expectedRevision: e.body.sourceUpdateTime }, {});
    assert.deepStrictEqual([stale.status, stale.body.error], [409, 'stale_edit'], 'a reset is conditional on the revision');
    const staffReset = await resetDraftToLiveCore({ db, authorize: as('staff'), readActiveVersionId: (f, x) => getActiveVersionId(f, x), previewVersion, toPrecondition },
      { restaurantId: rid, expectedRevision: await rev(rid) }, {});
    assert.deepStrictEqual([staffReset.status, staffReset.body.error], [403, 'not_owner']);
    ok('a poisoned draft is reported (draft_unpublishable) and can no longer be saved; resetDraftToLive (owner, conditional) restores a publishable draft and a price save/publish succeeds');
  }

  // ── c2a: an evidence collision → typed 409, pointer UNCHANGED ──
  {
    const rid = 'x_pizza';
    await wipe(); await seedBrand(rid, { certify: false });
    const s = await save(rid, withAdds(rid, await draft(rid), ['Choque']));
    const before = await getActivePointer(db, rid);
    await db.collection('restaurants').doc(rid).collection('identity_evidence').doc(`g${String(before.generation + 1).padStart(20, '0')}`).set({ planted: true });
    const p = await publish(rid, s);
    assert.deepStrictEqual([p.status, p.body.error], [409, 'flip_evidence_exists'], JSON.stringify(p.body).slice(0, 200));
    assert.deepStrictEqual(await getActivePointer(db, rid), before, 'the pointer did not move');
    ok('c2a: flip_evidence_exists → a typed 409 with the pointer unchanged');
  }

  FINISHED = true;
  console.log(`\nadd-product(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product(emulator) FAILED:', e && (e.stack || e)); process.exit(1); });
