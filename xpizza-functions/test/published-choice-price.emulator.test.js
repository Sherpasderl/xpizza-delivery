'use strict';
// Portal A (advisor ruling, 2026-10-12) — A PUBLISHED CHOICE'S PRICE IS STILL EDITABLE, end to end on the emulator. The
// grouped list shows a published group's choices read-only; their prices moved into the product's drawer, which writes
// them through the list boxes' own write (onPrice → editor.setItemPrice on the choice's key). This proves no capability
// was lost: the PORTAL's real editor (xpizza-portal/editor.js) changes La Musa's published "Pad Thai - Pollo"; the REAL
// editCatalogCore SAVES it, the REAL publishEditedCore PUBLISHES it, and the REAL quoteOrder, createOrder (cash) and
// chargeOnlineOrder (card) charge the NEW price. "Mismo precio para todas" (every choice set at once) likewise.
//   Expected totals are computed INDEPENDENTLY: the code tables plus the one edit, through computeServerTotal and
//   orderBreakdownCents — never read back from the server under test. Part of `npm run test:add-product`.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'pcp-secret';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'published-choice-price-'.padEnd(48, 'x');
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(q.amountLempiras); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const db = admin.firestore();
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion, previewVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, computeServerTotal } = require('../menu-pricing');
const { orderBreakdownCents } = require('../order-money');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('published-choice-price: FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'la_musa';
const LAUNCHER = 'noodle_01';
const CHOICES = ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'];

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
const draftOf = async (rid) => (await sourceRefOf(db, rid).get()).data();
const save = async (rid, source) => editCatalogCore({ db, authorize: as('owner'), readActiveBuilt: readActiveBuilt(rid), toPrecondition, addProduct: io },
  { restaurantId: rid, source, baseSourceUpdateTime: await rev(rid) }, {});
const publish = (rid, saved) => publishEditedCore({ db, authorize: as('owner'), readActiveBuilt: readActiveBuilt(rid), readDraft: readDraft(rid), publishVersion,
  mirror: makeRtdbMirror(rtdb), sourceSha: 'published-choice-price', addProduct: io },
  { restaurantId: rid, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, {});

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, 'x-firebase-id-token': 'u_pcp' }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
let PH = 0;
const phone = () => `9966${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };

const line = (key, price) => ({ id: key, name: key, qty: 1, price, extras: [] });   // la_musa addresses by ID
const expectedCents = (cart, menu) => {
  const priced = computeServerTotal(cart, RID, { restaurantId: RID, menu: { ...MENU_BY_RESTAURANT[RID], ...menu }, extras: { ...EXTRAS_BY_RESTAURANT[RID] } });
  assert.ok(!priced.error, `expected total computable: ${JSON.stringify(priced)}`);
  return orderBreakdownCents(priced.total, RID).total_cents;
};
const orderBody = (oid, method, cart) => ({ restaurant_id: RID, order_id: oid, customer_name: 'Choice Price', customer_phone: phone(),
  customer_email: 'pcp@example.com', items_text: cart.map((c) => `1x ${c.name}`).join(', '), order_type: 'pickup', payment_method: method, items: cart });

async function priceThrough(cart, expected, tag) {
  await clean();
  const q = await post(app.quoteOrder, { restaurant_id: RID, items: cart });
  assert.ok(q.json && q.json.ok === true, `${tag} quote: ${q.text.slice(0, 200)}`);
  assert.strictEqual(q.json.total_cents, expected, `${tag}: the QUOTE prices the edit (quote ${q.json.total_cents} vs expected ${expected})`);
  await clean();
  const oid = `pcp_${tag.replace(/\W+/g, '_')}_${Date.now()}`;
  const c = await post(app.createOrder, orderBody(oid, 'cash', cart));
  assert.strictEqual(c.status, 200, `${tag} cash order: ${c.text.slice(0, 300)}`);
  const stored = (await rtdb.ref(`orders/${oid}`).get()).val();
  assert.strictEqual(stored && stored.total_cents, expected, `${tag}: the CASH order is charged the edited price`);
  await clean();
  CHARGED.length = 0;
  const k = await post(app.chargeOnlineOrder, orderBody(`${oid}_card`, 'online', cart));
  assert.strictEqual(k.status, 200, `${tag} card checkout: ${k.text.slice(0, 300)}`);
  assert.strictEqual(Math.round(CHARGED.at(-1) * 100), expected, `${tag}: the CARD charge is the edited price (${CHARGED.at(-1)})`);
}

async function seed(rid) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'pcp-seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}
const livePrice = async (key) => (await previewVersion(db, RID, await getActiveVersionId(db, RID))).items.find((i) => i.key === key).price;

(async () => {
  // the PORTAL's own editor — the module the drawer's price fields write through
  const editor = await import(pathToFileURL(path.join(__dirname, '../../xpizza-portal/editor.js')).href);
  await wipe();
  await seed(RID);

  // premise: La Musa's Pad Thai is a PUBLISHED group (launcher + its choices), as the portal reads it
  {
    const d = editor.createDraft(await draftOf(RID));
    const g = editor.choiceGroup(d, LAUNCHER);
    assert.ok(g && g.options.length === 3, `premise — the portal sees Pad Thai as a group of 3 (${g && g.options.length})`);
    assert.deepStrictEqual(g.options.map((o) => editor.rowId(o)).sort(), [...CHOICES].sort(), 'premise — its choices are the three Pad Thai rows');
    assert.strictEqual(editor.setChoicePrice(d, 'noodle_01_pollo', '999'), d, 'premise');
    assert.deepStrictEqual(editor.pendingChanges(d), [], 'premise — the NEW-product mutator refuses a published group (why the drawer uses setItemPrice)');
  }

  // ── 1. ONE published choice repriced through the drawer's write → saves, publishes, charged everywhere ──
  {
    const code = MENU_BY_RESTAURANT[RID].noodle_01_pollo;
    const now = code + 11;
    const d = editor.createDraft(await draftOf(RID));
    editor.setItemPrice(d, 'noodle_01_pollo', String(now));   // the drawer field's write (onPrice → setItemPrice)
    const changes = editor.pendingChanges(d);
    assert.deepStrictEqual(changes.map((c) => `${c.surface}::${c.key}`), ['item::noodle_01_pollo'], 'the drawer edit is exactly one price change on the choice');
    const s = await save(RID, editor.draftSource(d));
    assert.strictEqual(s.status, 200, `save: ${JSON.stringify(s.body).slice(0, 300)}`);
    const p = await publish(RID, s);
    assert.strictEqual(p.status, 200, `🔴 a published choice's price edit PUBLISHES — ${JSON.stringify(p.body).slice(0, 300)}`);
    assert.strictEqual(await livePrice('noodle_01_pollo'), now, 'the active version carries the new choice price');
    const cart = [line('noodle_01_pollo', now)];
    const expected = expectedCents(cart, { noodle_01_pollo: now });
    assert.notStrictEqual(expected, expectedCents([line('noodle_01_pollo', code)], {}), 'sensitivity: the edit moves the total');
    await priceThrough(cart, expected, `pollo ${code}→${now}`);
    ok(`la_musa "Pad Thai - Pollo" ${code}→${now} through the portal editor's write: saves, PUBLISHES, and the quote, a cash order and a card charge all price it at ${now}`);
  }

  // ── 2. "Mismo precio para todas": every choice set at once (the drawer calls the same write per choice) ──
  {
    const d = editor.createDraft(await draftOf(RID));
    const g = editor.choiceGroup(d, LAUNCHER);
    const min = Math.min(...g.options.map((o) => o.price));
    for (const o of g.options) editor.setItemPrice(d, editor.rowId(o), String(min));
    assert.ok(editor.optionPricesEqual(d, LAUNCHER), 'the group now has one price');
    const s = await save(RID, editor.draftSource(d));
    assert.strictEqual(s.status, 200, `same-price save: ${JSON.stringify(s.body).slice(0, 300)}`);
    const p = await publish(RID, s);
    assert.strictEqual(p.status, 200, `same-price publish: ${JSON.stringify(p.body).slice(0, 300)}`);
    for (const k of CHOICES) assert.strictEqual(await livePrice(k), min, `${k} is live at L ${min}`);
    // the pricing instances and the intake gate cache the active pointer for 45 s (section 1 warmed them) — let them
    // learn the new version, as extra-price-edit does between its publishes
    await new Promise((r) => setTimeout(r, 46000));
    const cart = [line('noodle_01_camaron', min)];
    await priceThrough(cart, expectedCents(cart, Object.fromEntries(CHOICES.map((k) => [k, min]))), `same price ${min}`);
    ok(`"Mismo precio para todas" (L ${min}) saves, publishes, and the dearest choice (Camarones) is now charged L ${min} by quote, cash and card`);
  }

  FINISHED = true;
  console.log(`\npublished-choice-price: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('published-choice-price FAILED:', e); process.exit(1); });
