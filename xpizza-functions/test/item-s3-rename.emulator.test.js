'use strict';
// S3 (D4c-grill/item-s1/S3-DESIGN.md §4 «Rename», the editor-path ruling) — a RENAME made by the portal editor's OWN cores against a
// REAL (emulated) Firestore: seed → v1 → editCatalogCore (text edit: rederive → recordRenames → frozen keys) → publishEditedCore →
// buildPublicMenu (the endpoint's served body, item_keys overlay ON) → the customer app's real adaptMenu + serialize → the server's
// own resolveLines over the pricing tables the endpoints read. The light suites prove the same through the editor's pure steps on
// the strict fake (item-s3-fixtures.mjs); this proves the editor path end to end.
// Run: npm run test:item-s3-rename
require('./_emulator-required')('firestore', 'database');
const SWITCH = { enabled: true };   // the one platform text-edit switch (catalog/item-text-edit.js), ON for this walk only
require.cache[require.resolve('../catalog/item-text-edit')] = { id: require.resolve('../catalog/item-text-edit'), filename: require.resolve('../catalog/item-text-edit'), loaded: true,
  exports: { textEditCapabilities: () => ({ enabled: SWITCH.enabled }) } };
const assert = require('assert');
const path = require('path');
const admin = require('firebase-admin');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'e2e-secret-least-32-characters-long!!';

const { editCatalogCore, encodeUpdateTime } = require('../catalog/edit-catalog-handler');
const { Timestamp } = require('firebase-admin/firestore');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion, previewVersion } = require('../catalog/catalog-publish');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { getActiveVersionId, readVersionDocs } = require('../catalog/catalog-firestore');
const CF = require('../catalog/catalog-firestore');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildPublicMenu } = require('../catalog/public-menu');
const { createCatalogReader } = require('../catalog/catalog');
const { createPricingResolver } = require('../catalog/pricing-tables');
const { resolveLines } = require('../catalog/resolve-lines');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { flagRefOf, FLAG_FIELD } = require('../catalog/identity-flags');
const { computeServerTotal } = require('../menu-pricing');
const CAPP = path.join(__dirname, '..', '..', 'customer-app');
const { adaptMenu } = require(path.join(CAPP, 'capp-menu.js'));
const { createCart } = require(path.join(CAPP, 'capp-cart.js'));
const { serialize } = require(path.join(CAPP, 'capp-serialize.js'));

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.firestore();
const rtdb = admin.database();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('item-s3-rename(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'x_pizza', KEY = 'Carnivora', TO = 'Carnívora Suprema';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'owner@sherpa.hn' });
// the same live-version read index.js wires in (as edit-e2e)
async function readActiveBuilt(rid) {
  const versionId = await getActiveVersionId(db, rid);
  if (versionId == null) throw new Error(`no_active_version: ${rid}`);
  const [preview, docs] = await Promise.all([previewVersion(db, rid, versionId), readVersionDocs(db, rid, versionId)]);
  const { extras } = buildTablesFromDocs(docs.itemDocs, docs.extraDocs);
  return { built: { items: preview.items, structure: preview.structure, extras }, versionId, extraRecords: preview.extras };
}
async function readDraft(rid) {
  const snap = await sourceRefOf(db, rid).get();
  return { source: snap.data(), updateTime: encodeUpdateTime(snap.updateTime) };
}
const toPrecondition = (v) => { const [s2, ns] = String(v).split('.'); return new Timestamp(Number(s2), Number(ns)); };
// a rename is checked against the registry and the reserved keys: the editor's real io, as portal/functions.js wires it
const deps = { db, authorize: owner, readActiveBuilt, readDraft, publishVersion, toPrecondition, mirror: makeRtdbMirror(rtdb), addProduct: addProductIo({ fs: db, rtdb }) };
// what a client is served, and what the four endpoints resolve against — both from the emulated db
async function served() {
  const m = await buildPublicMenu(db, RID, { known: new Set([RID]), isActive: async () => true });
  const reader = createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(db, r) });
  const tables = await createPricingResolver({ reader, alarm: () => {} }).getPricingTables(RID);
  const body = JSON.parse(JSON.stringify(m.body));
  return { env: { rid: m.rid, representation_version: m.representation_version, menu: body }, body, tables };
}
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const lineFor = (P, pick) => { const m = adaptMenu(P.env); const d = m.dishes.find(pick); assert.ok(d, 'premise: the dish is served'); const c = createCart(m); c.inc(d.key); return { d, items: serialize(c, m).items }; };
const priced = (P, items) => { const b = JSON.parse(JSON.stringify({ items })); const r = resolveLines(RID, b, P.tables); return { r, total: r.ok ? computeServerTotal(b.items, RID, P.tables).total : null }; };

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();

  // ── SEED: the store, and v1 published from it (key mode from the build, as the publish path writes it) ─────────────────────
  const seeded = canonicalize(buildSourceFromCode(RID));
  await sourceRefOf(db, RID).set(seeded);
  const { inputs, built } = buildSourceCandidate(RID, seeded);
  await quiet(() => publishVersion(db, RID, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's3-rename-seed',
    ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }, { expected: { activeVersionId: null } }));
  await flagRefOf(db, RID).set({ [FLAG_FIELD]: true });
  const v1 = await getActiveVersionId(db, RID);
  const P0 = await served();
  const before = lineFor(P0, (x) => x.item_key === KEY);
  const p0 = priced(P0, before.items);
  assert.deepStrictEqual(p0.r, { ok: true }, 'premise: before the rename the line resolves');
  ok(`v1 live: ${KEY} served with item_key ${KEY}, its line resolves at L ${p0.total}`);

  // ── RENAME through the editor's own cores ───────────────────────────────────────────────────────────────────────────────
  const d0 = await readDraft(RID);
  const draft = JSON.parse(JSON.stringify(d0.source));
  draft.items.find((i) => i.key === KEY).display.name = TO;
  const e = await quiet(() => editCatalogCore(deps, { restaurantId: RID, source: draft, baseSourceUpdateTime: d0.updateTime }, {}));
  assert.strictEqual(e.status, 200, `the editor accepts the rename (${JSON.stringify(e.body).slice(0, 200)})`);
  const stored = (await readDraft(RID)).source;
  assert.strictEqual((stored.frozen_keys || {})[String(seeded.items.find((i) => i.key === KEY).display.id)], KEY, 'the editor recorded the rename: the dish keeps its key (frozen_keys)');
  const ack = ((e.body.diff && e.body.diff.largeChangeSet) || []).map((l) => ({ key: l.key, surface: l.surface }));
  const p = await quiet(() => publishEditedCore(deps, { restaurantId: RID, token: e.body.token, acknowledgedChanges: ack, fiscalAck: true }, {}));
  assert.strictEqual(p.status, 200, `the rename publishes (${JSON.stringify(p.body).slice(0, 200)})`);
  assert.notStrictEqual(await getActiveVersionId(db, RID), v1, 'a new version is live');
  ok(`editCatalogCore → publishEditedCore: «${TO}» is live, its key frozen at ${KEY}`);

  // ── WHAT A CLIENT IS SERVED, AND WHAT THE SERVER DOES WITH ITS LINE ─────────────────────────────────────────────────────
  const P1 = await served();
  const after = lineFor(P1, (x) => x.name === TO);
  assert.strictEqual(after.d.item_key, KEY, '🔴 the served body maps the renamed dish to its KEPT key (S3-EDITOR-RENAME-SERVED)');
  const line = after.items[0];
  assert.deepStrictEqual([line.name, line.item_key, 'id' in line], [TO, KEY, false], '🔴 the customer app sends {new label, kept key} (S3-EDITOR-RENAME-LINE)');
  const p1 = priced(P1, after.items);
  assert.deepStrictEqual(p1.r, { ok: true }, '🔴 the server resolves the renamed line (S3-EDITOR-RENAME-RESOLVE)');
  assert.strictEqual(p1.total, p0.total, '🔴 priced exactly as before the rename (S3-EDITOR-RENAME-PRICE)');
  const stripped = after.items.map((l) => { const { item_key, ...rest } = l; return rest; });
  assert.strictEqual(priced(P1, stripped).r.code, 'menu_changed', 'premise: the same line without item_key is the server\'s menu_changed — the field is load-bearing');
  ok(`after the rename: the line {name «${TO}», item_key ${KEY}} resolves at the same L ${p1.total}; without item_key → menu_changed`);

  FINISHED = true;
  console.log(`item-s3-rename(emulator): OK (${n})`);
  process.exit(0);
})().catch((err) => { console.error('item-s3-rename(emulator) FAILED:', err && err.stack || err); process.exit(1); });
