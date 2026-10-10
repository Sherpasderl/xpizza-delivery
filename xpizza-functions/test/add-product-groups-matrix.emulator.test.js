'use strict';
// 1D add-product PHASE B (codex PB-1 r1 P2-4 / P2-5) — the EQUAL / UNEQUAL fixture matrix through BOTH brands, end to end
// on the emulator (part of `npm run test:add-product`):
//   portal SAVE + PUBLISH (the real cores, authoring ON) → the REAL card and cash handlers (index.js, render ON) charge a
//   CHOICE at its OWN price — the persisted pending / placed order carries it, never the launcher minimum;
//   the THIRD KDS writer (publish-menus.mjs's sequence: active pointer → previewVersion → writeKdsManifest) resyncs a
//   group-bearing catalog as whole-dish + per-choice rows;
//   SAVE refuses an option whose DERIVED name was used before (the real registry) on its ref, field choice.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'apm-secret';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'add-product-matrix-'.padEnd(48, 'x');
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const CAPS = { render: true, authoring: true };
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../catalog/platform-groups', (r) => ({ ...r, groupCapabilities: () => ({ ...CAPS }) }));
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }) }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const db = admin.firestore();
const { readFileSync } = require('fs');
const { join } = require('path');
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion, previewVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildPublishCandidate } = require('../tools/publish-version');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { writeKdsManifest } = require('../catalog/kds-manifest');
const { encodeKey } = require('../catalog/identity-registry');
const A = require('../catalog/add-product');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('add-product-groups-matrix: FAILED — exited without completing'); process.exitCode = 1; } });

const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
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
  mirror: makeRtdbMirror(rtdb), sourceSha: 'add-product-matrix', addProduct: io },
  { restaurantId: rid, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, {});

const CAT = { x_pizza: 'ny', la_musa: 'noodles' };
const CHOICES = ['Salsa Roja', 'Salsa Vodka', 'Combinada'];
// ONE portal save may carry several new groups; each gets its own tmp refs (suffix n)
const refsOf = (n) => ({ L: `tmp:llllllll-000${n}`, V: [1, 2, 3].map((i) => `tmp:vvvvvvv${n}-000${i}`) });
const { L, V } = refsOf(1);
function withGroup(base, rid, prices, { n = 1, name = 'NY Plain Slice' } = {}) {
  const s = JSON.parse(JSON.stringify(base));
  const r = refsOf(n);
  s.items.push({ ref: r.L, price: 1, display: { cat: CAT[rid], name, price: 1, desc: 'La clásica' } });
  s.structure.item_order.push(r.L);
  CHOICES.forEach((ch, i) => { s.items.push({ ref: r.V[i], price: prices[i], display: { choice: ch, variantOf: r.L, price: prices[i] } }); s.structure.item_order.push(r.V[i]); });
  s.structure.variant_items = { ...(s.structure.variant_items || {}), [r.L]: { label: 'Salsa', variantIds: r.V } };
  return s;
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, '🔴 refusing to wipe Firestore without FIRESTORE_EMULATOR_HOST');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}
async function seedBrand(rid) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'matrix-seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
}
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
let PH = 0;
const phone = () => `9977${String(PH += 1).padStart(4, '0')}`;
const order = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).val();
const charge = async (rid, oid, method, key, price) => {
  await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
  const item = rid === 'la_musa' ? { id: key, name: key, qty: 1, price, extras: [] } : { name: key, qty: 1, price, extras: [] };
  return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, { restaurant_id: rid, order_id: oid, customer_name: 'Matrix', customer_phone: phone(),
    customer_email: 'm@example.com', items_text: `1x ${key}`, order_type: 'pickup', payment_method: method, items: [item] }, { 'x-firebase-id-token': `u_${rid}` });
};

(async () => {
  // ── the matrix: equal / unequal × both brands — authored in the portal (BOTH groups in ONE save + publish, so the
  //    handlers' pricing / gate readers first read the catalog AFTER it is published — no pointer-TTL staleness), charged
  //    at the CHOICE's own price ──
  const FIXTURES = { equal: [624, 624, 624], unequal: [600, 650, 700] };
  const NAMES = { equal: 'NY Plain Slice', unequal: 'NY Cheese Slice' };
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) await seedBrand(rid);
  for (const rid of ['x_pizza', 'la_musa']) {
    let src = await draft(rid);
    src = withGroup(src, rid, FIXTURES.equal, { n: 1, name: NAMES.equal });
    src = withGroup(src, rid, FIXTURES.unequal, { n: 2, name: NAMES.unequal });
    const s = await save(rid, src);
    assert.strictEqual(s.status, 200, `${rid} save: ${JSON.stringify(s.body).slice(0, 240)}`);
    const p = await publish(rid, s);
    assert.strictEqual(p.status, 200, `${rid} publish: ${JSON.stringify(p.body).slice(0, 240)}`);
    const stored = (await draft(rid)).items;
    for (const [fx, prices] of Object.entries(FIXTURES)) {
      const launcher = stored.find((i) => i.display.name === NAMES[fx]);
      const keys = [launcher.key, ...CHOICES.map((c) => stored.find((i) => i.display.name === `${NAMES[fx]} - ${c}`).key)];   // [launcher, Roja, Vodka, Combinada]
      const vodka = keys[2];
      const card = await charge(rid, `apm_card_${rid}_${fx}`, 'online', vodka, prices[1]);
      assert.strictEqual(card.status, 200, `${rid}/${fx} card: ${card.text.slice(0, 240)}`);
      const pend = await order(`apm_card_${rid}_${fx}`);
      assert.strictEqual(pend.total_cents, prices[1] * 100, `🔴 ${rid}/${fx}: the PENDING card order is priced at the choice (L ${prices[1]}), never the launcher minimum (L ${Math.min(...prices)})`);
      const cash = await charge(rid, `apm_cash_${rid}_${fx}`, 'cash', vodka, prices[1]);
      assert.strictEqual(cash.status, 200, `${rid}/${fx} cash: ${cash.text.slice(0, 240)}`);
      const placed = await order(`apm_cash_${rid}_${fx}`);
      assert.strictEqual(Number(placed.total), prices[1], `🔴 ${rid}/${fx}: the PLACED cash order's total is the choice's price`);
      assert.ok(String(placed.items_text).includes(vodka) || JSON.stringify(placed).includes('NY Plain Slice - Salsa Vodka'), `${rid}/${fx}: the persisted order names the choice`);
      const bare = await charge(rid, `apm_bare_${rid}_${fx}`, 'cash', keys[0], Math.min(...prices));
      assert.deepStrictEqual([bare.status, bare.json && bare.json.error], [409, 'choice_required'], `${rid}/${fx}: the bare launcher is refused`);
      // the THIRD KDS writer — publish-menus.mjs's exact sequence — over this group-bearing active catalog
      await rtdb.ref(`menus/${rid}`).remove(); await rtdb.ref(`menus/_meta/${rid}`).remove();
      const ptr = await getActivePointer(db, rid);
      const items = (await previewVersion(db, rid, ptr.version)).items;
      const w = await writeKdsManifest(rtdb, rid, { catalog: { items }, generation: ptr.generation, versionId: ptr.version });
      assert.strictEqual(w.written, true, `${rid}/${fx}: publish-menus resync writes ${JSON.stringify(w)}`);
      const rows = ((await rtdb.ref(`menus/${rid}`).get()).val() || []).filter((r) => keys.includes(r.key)).map((r) => r.key);
      assert.deepStrictEqual(rows, keys, `🔴 ${rid}/${fx}: the resynced kitchen list carries the whole-dish row + one row per choice`);
    }
  }
  const pm = readFileSync(join(__dirname, '..', 'publish-menus.mjs'), 'utf8');
  assert.ok(/getActivePointer\(fs, rid\)/.test(pm) && /previewVersion\(fs, rid, ptr\.version\)\)\.items/.test(pm) && /writeKdsManifest\(admin\.database\(\), rid, \{ catalog: \{ items \}, generation: ptr\.generation, versionId: ptr\.version \}\)/.test(pm),
    'premise: publish-menus.mjs runs exactly this sequence (pointer → previewVersion → writeKdsManifest)');
  ok('matrix (equal + unequal × both brands): portal save + publish → the card PENDING order and the cash PLACED order carry the choice\'s own price; the bare launcher is refused; the publish-menus resync lists whole-dish + per-choice rows');

  // ── P2-4: SAVE refuses an option whose DERIVED name was used before — the REAL registry, field-mapped to the choice ──
  for (const rid of ['x_pizza', 'la_musa']) {
    await wipe(); await seedBrand(rid);
    const mode = rid === 'la_musa' ? 'id' : 'name';
    const derived = A.optionName('NY Plain Slice', 'Combinada');
    const key = mode === 'name' ? A.tidyName(derived) : A.slugify(derived);
    await db.doc(`restaurants/${rid}/identity/dish/keys/${encodeKey(key)}`).set({ key, retired: true });
    if (mode === 'id') await db.doc(`restaurants/${rid}/identity/dish/ids/${key}`).set({ id: key, retired: true });
    const before = await rev(rid);
    const r = await save(rid, withGroup(await draft(rid), rid, FIXTURES.equal));
    assert.deepStrictEqual([r.status, r.body.error, r.body.ref, r.body.field], [409, 'name_previously_used', V[2], 'choice'].map((v, i) => (i === 0 ? r.status : v)),
      `🔴 ${rid}: a historical DERIVED option name → name_previously_used on its ref, field choice — ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(r.status >= 400 && r.status < 500, `${rid}: a typed client refusal (${r.status})`);
    assert.strictEqual(await rev(rid), before, `${rid}: nothing written`);
  }
  ok('SAVE (both brands): an option whose derived name exists in the real identity registry is refused BEFORE allocation commits — name_previously_used on its tmp ref, field choice, nothing written');

  FINISHED = true;
  console.log(`\nadd-product-groups-matrix: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product-groups-matrix FAILED:', e && (e.stack || e)); process.exit(1); });
