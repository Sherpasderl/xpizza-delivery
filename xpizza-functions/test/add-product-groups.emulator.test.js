'use strict';
// 1D add-product PHASE B (rev 6, UNIFORM) — required-choice GROUPS through the REAL cores on the emulator, BOTH brands
// with the same fixture: editCatalogCore → publishEditedCore → publishVersion, the public menu, the KDS manifest sync, and a
// rollback (the KDS writers). Part of `npm run test:add-product`.
//   The platform switches are stubbed per cell (require.cache, before the handlers load) — production reads the committed
//   constant / generated artifact; no override exists outside this test.
require('./_emulator-required')('firestore', 'database');

const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'add-product-groups-'.padEnd(48, 'x');
const CAPS = { render: false, authoring: false };
{
  const p = require.resolve('../catalog/platform-groups');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { groupCapabilities: () => ({ ...CAPS }), parseRender: (m) => m.render } };
}
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.firestore();
const rtdb = admin.database();

const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion, previewVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime, validateSource } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildPublishCandidate } = require('../tools/publish-version');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { buildPublicMenu } = require('../catalog/public-menu');
const { groupIndexFrom } = require('../catalog/group-index');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('add-product-groups(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

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
const save = async (rid, source) => editCatalogCore({ db, authorize: as('owner'), readActiveBuilt: readActiveBuilt(rid), toPrecondition, addProduct: io },
  { restaurantId: rid, source, baseSourceUpdateTime: await rev(rid) }, {});
const publish = (rid, saved) => publishEditedCore({ db, authorize: as('owner'), readActiveBuilt: readActiveBuilt(rid), readDraft: readDraft(rid), publishVersion,
  mirror: makeRtdbMirror(rtdb), sourceSha: 'add-product-groups', addProduct: io },
  { restaurantId: rid, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, {});
const manifest = async (rid) => (await rtdb.ref(`menus/${rid}`).get()).val();

const CAT = { x_pizza: 'ny', la_musa: 'noodles' };
const L = 'tmp:llllllll-0001'; const V = ['tmp:vvvvvvvv-0001', 'tmp:vvvvvvvv-0002', 'tmp:vvvvvvvv-0003'];
// THE SAME portal-shaped group on both brands (§0d.6 uniformity fixture)
function withGroup(base, rid, { prices = [624, 624, 624] } = {}) {
  const s = JSON.parse(JSON.stringify(base));
  s.items.push({ ref: L, price: 1, display: { cat: CAT[rid], name: 'NY Plain Slice', price: 1, desc: 'La clásica', extras_policy: 'none' } });
  s.structure.item_order.push(L);
  ['Salsa Roja', 'Salsa Vodka', 'Combinada'].forEach((ch, i) => {
    s.items.push({ ref: V[i], price: prices[i], display: { choice: ch, variantOf: L, price: prices[i] } });
    s.structure.item_order.push(V[i]);
  });
  s.structure.variant_items = { ...(s.structure.variant_items || {}), [L]: { label: 'Salsa', variantIds: V } };
  return s;
}
async function seedBrand(rid) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'groups-seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, active: true, version: 1 });
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}

(async () => {
  // ── 1. AUTHORING OFF (the shipped default): a new group is refused for EVERY brand; an ordinary price edit still saves ──
  for (const rid of ['x_pizza', 'la_musa']) {
    await wipe(); await seedBrand(rid);
    Object.assign(CAPS, { render: false, authoring: false });
    const before = await rev(rid);
    const r = await save(rid, withGroup(await draft(rid), rid));
    assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'choices_not_supported_yet', 'choices'], `${rid}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok([L, ...V].includes(r.body.ref), `${rid}: the refusal names a tmp ref the portal holds`);
    assert.strictEqual(await rev(rid), before, `${rid}: nothing written`);
    const s = await draft(rid); s.items[0].price += 1; s.items[0].display.price = s.items[0].price;
    const p = await save(rid, s); assert.strictEqual(p.status, 200, `${rid}: an ordinary price save is unaffected`);
  }
  ok('authoring OFF: a new group is refused for both brands (tmp ref, nothing written); an ordinary price save is unaffected');

  // ── 2. AUTHORING ON: the SAME group saves, publishes, serves and syncs to the kitchen on BOTH brands ──
  for (const rid of ['x_pizza', 'la_musa']) {
    await wipe(); await seedBrand(rid);
    Object.assign(CAPS, { render: false, authoring: true });
    const s = await save(rid, withGroup(await draft(rid), rid, { prices: [600, 650, 700] }));
    assert.strictEqual(s.status, 200, `${rid} save: ${JSON.stringify(s.body).slice(0, 300)}`);
    const stored = await draft(rid);
    assert.doesNotThrow(() => validateSource(stored, rid), `${rid}: the stored draft is valid`);
    assert.ok(!JSON.stringify(stored).includes('tmp:'), `${rid}: no tmp ref is stored`);
    const added = stored.items.slice(-4);
    assert.deepStrictEqual(added.slice(1).map((v) => v.display.name), ['NY Plain Slice - Salsa Roja', 'NY Plain Slice - Salsa Vodka', 'NY Plain Slice - Combinada']);
    assert.deepStrictEqual(s.body.diff.added.filter((a) => a.surface === 'item').map((a) => a.key).sort(), added.map((i) => i.key).sort(), `${rid}: the review lists the launcher and every choice`);
    const p = await publish(rid, s);
    assert.strictEqual(p.status, 200, `${rid} publish: ${JSON.stringify(p.body).slice(0, 300)}`);
    const active = await previewVersion(db, rid, await getActiveVersionId(db, rid));
    const idx = groupIndexFrom({ items: active.items, structure: active.structure });
    assert.ok(idx.ok && idx.launchers.has(added[0].key) && added.slice(1).every((v) => idx.parentOf.get(v.key) === added[0].key), `${rid}: the ACTIVE catalog carries the group`);
    assert.deepStrictEqual(added.slice(1).map((v) => active.items.find((i) => i.key === v.key).price), [600, 650, 700], `${rid}: per-choice prices live (unequal, every brand)`);
    // the public menu body: whole, with the group
    const pm = await buildPublicMenu(db, rid, { known: new Set([rid]), isActive: async () => true });
    assert.ok(pm.body.variant_items && pm.body.variant_items[String(added[0].display.id)], `${rid}: the public menu serves the group`);
    assert.strictEqual(pm.body.variant_items[String(added[0].display.id)].basePrice, 600, `${rid}: "desde" derived from the choices`);
    assert.ok(pm.body.dishes.filter((d) => d.extras_policy === 'none').length === 4, `${rid}: extras_policy reaches the body on the launcher and every choice`);
    // the KDS: a whole-dish row + one row per choice (publish's writer)
    const rows = (await manifest(rid)).filter((r) => added.some((a) => a.key === r.key));
    assert.deepStrictEqual(rows.map((r) => r.key), added.map((a) => a.key), `${rid}: KDS whole-dish row + per-choice rows`);
    // a rollback removes the group from the active catalog and the kitchen list (rollback's writer)
    const now = await getActivePointer(db, rid);
    const target = (await db.collection('restaurants').doc(rid).collection('versions').orderBy('created_at').limit(1).get()).docs[0].id;   // the seed version
    assert.notStrictEqual(target, now.version, 'premise: rolling back to an older version');
    await rollbackVersion(db, rid, target, { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: now.version, activeGeneration: now.generation } });
    const k = await io.syncKds(rid, { versionId: target });
    assert.strictEqual(k.written, true, `${rid}: the rollback rewrites the KDS list ${JSON.stringify(k)}`);
    assert.ok(!(await manifest(rid)).some((r) => added.some((a) => a.key === r.key)), `${rid}: after the rollback the kitchen list no longer carries the group`);
  }
  ok('authoring ON, BOTH brands: the same group saves (derived names, no tmp ref), publishes (unequal prices live), is served whole by the public menu ("desde", extras_policy), lands in the KDS as whole-dish + per-choice rows, and a rollback removes it from the catalog and the kitchen list');

  // ── 3. la_musa's existing Pad Thai group is frozen; options for it are refused even with authoring ON ──
  {
    const rid = 'la_musa';
    await wipe(); await seedBrand(rid);
    Object.assign(CAPS, { render: false, authoring: true });
    const s = await draft(rid); s.structure.variant_items.noodle_01.label = 'Proteínas';
    const r = await save(rid, s);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'structure_changed'], JSON.stringify(r.body).slice(0, 200));
    const t = await draft(rid); t.items.push({ ref: V[0], price: 300, display: { choice: 'Tofu', variantOf: 'noodle_01', price: 300 } }); t.structure.item_order.push(V[0]);
    const r2 = await save(rid, t);
    assert.deepStrictEqual([r2.status, r2.body.error, r2.body.ref], [400, 'choices_not_supported_yet', V[0]], JSON.stringify(r2.body).slice(0, 200));
    const p = await draft(rid); const pollo = p.items.find((i) => i.key === 'noodle_01_pollo'); pollo.price += 5; pollo.display.price = pollo.price;
    const r3 = await save(rid, p);
    assert.strictEqual(r3.status, 200, 'a per-choice price edit on the existing group saves (uniform rule: per-choice prices for every brand)');
  }
  ok('la_musa’s Pad Thai group: its map is frozen and no option can be added to it, while a per-choice price edit still saves');

  FINISHED = true;
  console.log(`\nadd-product-groups(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product-groups(emulator) FAILED:', e && (e.stack || e)); process.exit(1); });
