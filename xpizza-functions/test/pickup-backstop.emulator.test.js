'use strict';
// S2-8 (D4c-grill/item-s1/S2-DESIGN.md §1.4 + its option-A addendum; §2 r1 B/C) — THE PICKUP-ONLY BACKSTOP through the REAL
// order endpoints on the emulator. The pickup-only section is authored in the data: v1 makes x_pizza's `individual` section
// pickup-only (its live `ny` is ALSO weekend-only, which answers first on a weekday; and only a brand whose renderer draws
// pickup-only sections can author one — la_musa's build drops the field):
//   · the frozen forms' REAL quote bodies (no mode) are never refused for it; capp's explicit-delivery quote is refused early
//     (quoteOrder fail-soft 200 { ok:false, error:'pickup_only_item', item_key }; quoteRedemption 409);
//   · a DELIVERY createOrder / chargeOnline with a pickup-only item → 409 pickup_only_item, nothing written / charged, the
//     claimed card attempt retired; the same cart as a PICKUP order places;
//   · a checkout issued BEFORE the gate existed (a version without the pickup-only section) RESUMES after it is published:
//     the same live URL, nothing charged again — a payment in flight is never re-judged.
// Run: npm run test:pickup-backstop
require('./_emulator-required').harness(['firestore', 'database']);
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's1b-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 's1b-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(q.pixelpayOrderId); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));


const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pickup-backstop(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: res.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
const RID = 'x_pizza';
// publishes THIS source (the test's data, not the code catalog) through the real builder and publisher
async function publishSource(src, tag) {
  await sourceRefOf(fs, RID).set(canonicalize(src));
  const p = await getActivePointer(fs, RID).catch(() => ({ version: null }));
  const { inputs, built } = buildSourceCandidate(RID, src);
  const input = { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: tag, key_mode: built.key_mode, ...(built.frozen_keys ? { frozen_keys: built.frozen_keys } : {}) };
  return publishVersion(fs, RID, input, { expected: { activeVersionId: p.version || null }, mirror: makeRtdbMirror(rtdb) });
}
const SRC = buildSourceFromCode(RID);   // v0: the real source (`ny` pickup-only, `individual` not)
const NY = SRC.items.find((i) => i.display.cat === 'individual' && i.key !== 'Margherita');   // the dish v1 makes pickup-only
const IND = SRC.items.find((i) => i.display.cat === 'individual' && i.key !== 'Margherita' && i.key !== NY.key);   // the price-moved premise dish (never in a tested cart)
const line = (it) => ({ name: it.display.name, qty: 1, price: it.price, extras: [] });
const DLV = { order_type: 'delivery', lat: 14.11, lng: -87.19, address_detected: 'Calle Principal', address_details: 'portón negro' };
const bodyFor = (oid, phone, items, extra = {}) => ({ restaurant_id: RID, order_id: oid, customer_name: 'S2 Test', customer_phone: phone, customer_email: 's2@example.com',
  items_text: '1x test', order_type: 'pickup', payment_method: 'cash', items, ...extra });
let seq = 0;
const fresh = async () => { await rtdb.ref('rate_limits').remove(); seq += 1; return { oid: `s2pk_${seq}_${Date.now() % 100000}`, phone: `9946${String(1000 + seq).slice(-4)}` }; };
const written = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).exists();
const PICKUP_ONLY = { ok: false, error: 'pickup_only_item', item_key: NY.key };

(async () => {
  assert.ok(NY && IND, 'premise: a pickup-only dish and a plain one');
  // v0: a version WITHOUT the pickup-only section (the world before the gate) — a card checkout is issued for a delivery NY order
  await publishSource(SRC, 's2pk-v0');
  await backfillIdentities(fs, RID, catalogSnapshot(RID), { captured: await getActivePointer(fs, RID) });
  await rtdb.ref(`restaurants/${RID}/identity`).set(identityFor(RID));
  const uid = 'u_s2pk';
  const inflight = await fresh();
  const issued = await post(app.chargeOnlineOrder, bodyFor(inflight.oid, inflight.phone, [line(NY)], { ...DLV, payment_method: 'online' }), { 'x-firebase-id-token': uid });
  assert.strictEqual(issued.status, 200, `premise: before the gate a delivery NY checkout is issued (${issued.text.slice(0, 200)})`);
  const url = issued.json.checkout_url; const charged0 = CHARGED.length;

  // v1: the gate is published (and one plain dish's price moves, so the test can PROVE v1 is the version served)
  const q0 = await post(app.quoteOrder, { restaurant_id: RID, items: [line(IND)] });
  const v1src = JSON.parse(JSON.stringify(SRC)); v1src.structure.pickup_only_cats = ['ny', 'individual']; const ind1 = v1src.items.find((i) => i.key === IND.key); ind1.price += 1; ind1.display.price += 1;
  await publishSource(v1src, 's2pk-v1');
  await new Promise((r) => setTimeout(r, 46000));   // the handlers cache the active pointer for 45 s
  const q1 = await post(app.quoteOrder, { restaurant_id: RID, items: [{ ...line(IND), price: IND.price + 1 }] });
  assert.notDeepStrictEqual(q1.json, q0.json, `premise: v1 (the gate) is the version served (${q1.text.slice(0, 160)})`);

  // ── a payment in flight is never re-judged ──
  {
    const resumed = await post(app.chargeOnlineOrder, bodyFor(inflight.oid, inflight.phone, [line(NY)], { ...DLV, payment_method: 'online' }), { 'x-firebase-id-token': uid });
    assert.strictEqual(resumed.status, 200, `S2PK-RESUME the checkout issued before the gate resumes (${resumed.text.slice(0, 200)})`);
    assert.strictEqual(resumed.json.checkout_url, url, 'S2PK-RESUME the SAME live URL');
    assert.strictEqual(CHARGED.length, charged0, 'S2PK-RESUME nothing charged again');
    ok('a checkout issued before the gate resumes after it is published: the same URL, nothing charged again');
  }
  // ── binding endpoints ──
  {
    const a = await fresh();
    const co = await post(app.createOrder, bodyFor(a.oid, a.phone, [line(NY)], DLV), { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([co.status, co.json], [409, PICKUP_ONLY], `S2PK-CREATE a delivery cash order with a pickup-only item (${co.text.slice(0, 200)})`);
    assert.strictEqual(await written(a.oid), false, 'S2PK-CREATE nothing written');
    const b = await fresh();
    const pick = await post(app.createOrder, bodyFor(b.oid, b.phone, [line(NY)]), { 'x-firebase-id-token': uid });
    assert.strictEqual(pick.status, 200, `S2PK-PICKUP the same cart as a pickup order places (${pick.text.slice(0, 200)})`);
    const c = await fresh(); const before = CHARGED.length;
    const ch = await post(app.chargeOnlineOrder, bodyFor(c.oid, c.phone, [line(NY)], { ...DLV, payment_method: 'online' }), { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([ch.status, ch.json], [409, PICKUP_ONLY], `S2PK-CHARGE a fresh delivery charge with a pickup-only item (${ch.text.slice(0, 200)})`);
    assert.strictEqual(CHARGED.length, before, 'S2PK-CHARGE no checkout created');
    const ord = (await rtdb.ref(`orders/${c.oid}`).get()).val();
    const att = ord && ord.active_attempt_id ? (await rtdb.ref(`payment_attempts/${ord.active_attempt_id}`).get()).val() : null;
    assert.ok(!att || att.hosted_state === 'failed_create', `S2PK-CHARGE the claimed attempt is retired (${att && att.hosted_state})`);
    ok('binding: a delivery order / fresh charge with a pickup-only item → 409, nothing written or charged; pickup places (a plain cart: the unit S2P-BIND-PLAIN)');
  }
  // ── quotes: the frozen forms' real bodies vs capp's explicit mode ──
  {
    const form = await post(app.quoteOrder, { restaurant_id: RID, items: [line(NY)] });   // xpizza-orders/index.html:3420-3421 — no mode
    assert.strictEqual(form.status, 200, 'S2PK-FORM-QUOTE premise');
    assert.notStrictEqual(form.json && form.json.error, 'pickup_only_item', `S2PK-FORM-QUOTE the frozen form's quote (no mode) is never refused for it (${form.text.slice(0, 200)})`);
    const capp = await post(app.quoteOrder, { restaurant_id: RID, items: [line(NY)], mode: 'delivery', pin: { lat: 14.11, lng: -87.19, confirmed: true } });
    assert.deepStrictEqual([capp.status, capp.json], [409, PICKUP_ONLY], `S2PK-CAPP-QUOTE capp's explicit delivery quote is refused early with 409 (${capp.text.slice(0, 200)})`);
    const inval = await post(app.quoteOrder, { restaurant_id: RID, items: [line(NY)], mode: 'drone' });
    assert.notStrictEqual(inval.json && inval.json.error, 'pickup_only_item', 'S2PK-QUOTE-INVALID an invalid mode is not refused for it');
    const redeem = { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' };
    await rtdb.ref(`user_rewards/${uid}/${RID}`).set({ balance: 100000, reserved: 0 }); await rtdb.ref('config/redemption_enabled').set(true);
    const rForm = await post(app.quoteRedemption, { restaurant_id: RID, items: [line(NY)], redeem }, { 'x-firebase-id-token': uid });
    assert.notStrictEqual(rForm.json && rForm.json.error, 'pickup_only_item', `S2PK-FORM-REDEEM the frozen form's reward quote is never refused for it (${rForm.text.slice(0, 200)})`);
    const rDel = await post(app.quoteRedemption, { restaurant_id: RID, items: [line(NY)], redeem, mode: 'delivery' }, { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([rDel.status, rDel.json], [409, PICKUP_ONLY], `S2PK-REDEEM-DELIVERY an explicit delivery reward quote → 409 (${rDel.text.slice(0, 200)})`);
    ok('quotes: the frozen forms\' bodies (no mode) are never refused for it; an explicit delivery quote is (409 on both quotes)');
  }
  FINISHED = true;
  console.log(`\npickup-backstop(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
