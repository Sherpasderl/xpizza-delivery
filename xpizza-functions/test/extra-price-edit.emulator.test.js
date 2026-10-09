'use strict';
// codex build r1 #4 (advisor relay 2026-10-09) — AN EXTRA-PRICE EDIT IS NOT A DEAD END, end to end on the emulator:
// the REAL editCatalogCore SAVE → the REAL publishEditedCore PUBLISH → the active version → the REAL quoteOrder,
// createOrder (cash) and chargeOnlineOrder (card) price the extra at its NEW value. Both brands; and a MIXED edit
// (a new product + an extra price) on both. Part of `npm run test:add-product`.
//   Before the fix the builder priced extras from the CODE table while the charging table came from the source, so the
//   save stored a draft whose publish was refused by the candidate validator (Salsa Roja 40 ≠ 39; rice_white 51 ≠ 50).
//   Expected totals are computed INDEPENDENTLY: the code tables plus the one edit, through computeServerTotal and
//   orderBreakdownCents — never read back from the server under test.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'ep-secret';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'extra-price-edit-'.padEnd(48, 'x');
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
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('extra-price-edit: FAILED — exited without completing'); process.exitCode = 1; } });

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
  mirror: makeRtdbMirror(rtdb), sourceSha: 'extra-price-edit', addProduct: io },
  { restaurantId: rid, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, {});

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, 'x-firebase-id-token': 'u_ep' }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
let PH = 0;
const phone = () => `9977${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };

// a cart line in each brand's own addressing (x_pizza by NAME, la_musa by ID), carrying the extra
const line = (rid, key, price, extraKey, extraPrice) => (rid === 'la_musa'
  ? { id: key, name: key, qty: 1, price, extras: [{ id: extraKey, qty: 1, price: extraPrice }] }
  : { name: key, qty: 1, price, extras: [{ name: extraKey, price: extraPrice }] });
// THE EXPECTATION, independent of the server under test: the CODE tables plus exactly the edits made here
const expectedCents = (rid, cart, { menu = {}, extras = {} }) => {
  const priced = computeServerTotal(cart, rid, { restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid], ...menu }, extras: { ...EXTRAS_BY_RESTAURANT[rid], ...extras } });
  assert.ok(!priced.error, `expected total computable: ${JSON.stringify(priced)}`);
  return orderBreakdownCents(priced.total, rid).total_cents;
};
const orderBody = (rid, oid, method, cart) => ({ restaurant_id: rid, order_id: oid, customer_name: 'Extra Price', customer_phone: phone(),
  customer_email: 'ep@example.com', items_text: cart.map((c) => `1x ${c.name}`).join(', '), order_type: 'pickup', payment_method: method, items: cart });

async function priceThrough(rid, cart, expected, tag) {
  await clean();
  const q = await post(app.quoteOrder, { restaurant_id: rid, items: cart });
  assert.ok(q.json && q.json.ok === true, `${tag} quote: ${q.text.slice(0, 200)}`);
  assert.strictEqual(q.json.total_cents, expected, `${tag}: the QUOTE prices the edit`);
  await clean();
  const oid = `ep_${rid}_${tag.replace(/\W+/g, '_')}_${Date.now()}`;
  const c = await post(app.createOrder, orderBody(rid, oid, 'cash', cart));
  assert.strictEqual(c.status, 200, `${tag} cash order: ${c.text.slice(0, 300)}`);
  const stored = (await rtdb.ref(`orders/${oid}`).get()).val();
  assert.strictEqual(stored && stored.total_cents, expected, `${tag}: the CASH order is charged the edited price`);
  await clean();
  CHARGED.length = 0;
  const k = await post(app.chargeOnlineOrder, orderBody(rid, `${oid}_card`, 'online', cart));
  assert.strictEqual(k.status, 200, `${tag} card checkout: ${k.text.slice(0, 300)}`);
  assert.strictEqual(Math.round(CHARGED.at(-1) * 100), expected, `${tag}: the CARD charge is the edited price (${CHARGED.at(-1)})`);
}

async function seed(rid) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'ep-seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
}
const EXTRA = { x_pizza: 'Salsa Roja', la_musa: 'rice_white' };
const EXTRA2 = { x_pizza: 'Mozzarella', la_musa: null };
const editExtra = (src, key, delta) => {
  const e = src.extras.find((x) => x.key === key);
  assert.ok(e, `premise: the source carries the extra ${key}`);
  e.price += delta;
  if (e.display && Object.prototype.hasOwnProperty.call(e.display, 'price')) e.display.price = e.price;
  return e.price;
};
const aDish = (rid, src) => {
  // an existing dish that takes the edited extra on the order path (the first one whose code total accepts it)
  for (const it of src.items) {
    const cart = [line(rid, it.key, it.price, EXTRA[rid], EXTRAS_BY_RESTAURANT[rid][EXTRA[rid]])];
    if (!computeServerTotal(cart, rid).error) return it;
  }
  throw new Error(`${rid}: no dish accepts ${EXTRA[rid]}`);
};

// THE RESET, gated on the HANDLES themselves (index.js initializes with the production databaseURL; only the emulator
// host variables redirect it — _emulator-required has already refused a run without them, and this re-checks what the
// SDK actually resolved before a single delete): earlier suites in test:add-product leave published versions behind.
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) await seed(rid);

  // ── 1. a pure extra-price edit, both brands: SAVE → PUBLISH → active version → quote / cash / card ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = JSON.parse(JSON.stringify(await draft(rid)));
    const code = EXTRAS_BY_RESTAURANT[rid][EXTRA[rid]];
    const now = editExtra(src, EXTRA[rid], 7);
    const s = await save(rid, src);
    assert.strictEqual(s.status, 200, `${rid} save: ${JSON.stringify(s.body).slice(0, 300)}`);
    const p = await publish(rid, s);
    assert.strictEqual(p.status, 200, `${rid}: 🔴 the extra-price edit PUBLISHES (was a dead end) — ${JSON.stringify(p.body).slice(0, 300)}`);
    const active = await previewVersion(db, rid, await getActiveVersionId(db, rid));
    const rec = active.extras.find((e) => e.key === EXTRA[rid]);
    assert.strictEqual(rec.price, now, `${rid}: the active version's extra RECORD carries the edited price`);
    const dish = aDish(rid, src);
    const cart = [line(rid, dish.key, dish.price, EXTRA[rid], now)];
    const expected = expectedCents(rid, cart, { extras: { [EXTRA[rid]]: now } });
    assert.notStrictEqual(expected, expectedCents(rid, [line(rid, dish.key, dish.price, EXTRA[rid], code)], {}), 'sensitivity: the edit moves the total');
    await priceThrough(rid, cart, expected, `${rid} extra ${code}→${now}`);
    ok(`${rid}: ${EXTRA[rid]} ${code}→${now} saves, PUBLISHES, and the quote, a cash order and a card charge all price it at ${now}`);
  }

  // ── 2. a MIXED edit, both brands: a new product AND an extra price in one save/publish ──
  const mixed = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = JSON.parse(JSON.stringify(await draft(rid)));
    const key2 = EXTRA2[rid] || EXTRA[rid];
    const now = editExtra(src, key2, 3);
    const ref = 'tmp:eeeeeeee-0001';
    const cat = rid === 'la_musa' ? 'noodles' : 'individual';
    src.items.push({ ref, price: 444, display: { cat, name: 'Producto Mixto', price: 444 } });
    src.structure.item_order.push(ref);
    const s = await save(rid, src);
    assert.strictEqual(s.status, 200, `${rid} mixed save: ${JSON.stringify(s.body).slice(0, 300)}`);
    const added = s.body.source.items.at(-1);
    assert.ok(s.body.diff.added.some((a) => a.key === added.key), `${rid}: the review lists the addition`);
    const p = await publish(rid, s);
    assert.strictEqual(p.status, 200, `${rid} mixed publish: ${JSON.stringify(p.body).slice(0, 300)}`);
    const active = await previewVersion(db, rid, await getActiveVersionId(db, rid));
    assert.strictEqual(active.extras.find((e) => e.key === key2).price, now, `${rid}: the extra's new price is live`);
    assert.ok(active.items.some((i) => i.key === added.key && i.price === 444), `${rid}: and so is the new product`);
    mixed[rid] = { key2, now, added };
  }
  // the pricing instances and the intake gate cache the active pointer for 45 s — let both learn the new version
  await new Promise((r) => setTimeout(r, 46000));
  for (const rid of ['x_pizza', 'la_musa']) {
    const { key2, now, added } = mixed[rid];
    const cart = [line(rid, added.key, 444, key2, now)];
    // the new product CARRIES the edited extra — never priced alone
    assert.ok(!computeServerTotal(cart, rid, { restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid], [added.key]: 444 }, extras: { ...EXTRAS_BY_RESTAURANT[rid], [key2]: now } }).error,
      `${rid}: premise — the new product takes ${key2}`);
    const firstExtra = EXTRA[rid] === key2 ? { [key2]: now } : { [EXTRA[rid]]: EXTRAS_BY_RESTAURANT[rid][EXTRA[rid]] + 7, [key2]: now };
    const expected = expectedCents(rid, cart, { menu: { [added.key]: 444 }, extras: firstExtra });
    await priceThrough(rid, cart, expected, `${rid} mixed`);
    ok(`${rid}: a MIXED edit (new product + ${key2}→${now}) saves, publishes, and prices both through quote / cash / card`);
  }

  FINISHED = true;
  console.log(`\nextra-price-edit: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('extra-price-edit FAILED:', e && (e.stack || e)); process.exit(1); });
