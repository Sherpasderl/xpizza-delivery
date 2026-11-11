'use strict';
// DELIVERY PRICING APP-ONLY (PLAN-delivery-pricing-app-only r2 §4 + addendum A + G2) — end to end on the emulator through the REAL
// index.js handlers and the real Admin SDK:
//   A  FORM GOLDENS: every form-shaped request (no entry_mode) gives the SAME status, body and stored record under an ACTIVE
//      table as under no table at all — cash delivery (pin-less) / pickup / reward, the card's pending order + gateway amount,
//      quoteOrder, quoteRedemption, and the token cases (a signed form quote, a stale cart, a lower ceiling). Each run starts
//      from the same RTDB snapshot with the same ids, so the records compare whole (only clocks and random ids masked).
//   B  ON → OFF (app, the table removed after issuance): a live checkout is REUSED at its issued economics (no tip, tip, zero
//      fee); an expired one is never re-issued (503, no new checkout).
//   C  THE WRITER on the real SDK: the first save through the null-first transaction; the server timestamp resolves inside the
//      transaction (verify-first); a gap-keyed stored history is reset; the order path reads exactly what was saved; G2 lists
//      every registry branch.
// Run: npm run test:dpao
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'dpao-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'dpao-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.PIXELPAY_MERCHANT_EMAIL = 'merchant@example.com';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
// tokens: 'admin_*' → a portal (non-customer) user; anything else → a customer
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => (String(t).startsWith('admin_') ? { uid: String(t) } : { uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const DW = require('../delivery/delivery-wire');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('dpao: FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body, hdr = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...hdr }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 14.1, lng: -87.2 };
const north = (km) => ({ lat: HUB.lat + km / 111.195, lng: HUB.lng });
const BANDS = [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }, { max_km: 7, cents: 7000 }];
const PATH = 'platform_config/delivery_pricing';
const RID = 'x_pizza';
const LINE = { name: 'Margherita', qty: 1, price: 0 };
const MEMBER = 'u_dpao_member';
const REDEEM = { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' };
const setTable = (t) => (t ? rtdb.ref(PATH).set(t) : rtdb.ref(PATH).remove());
const ACTIVE = { policy_version: 1, bands: BANDS, restaurants: { x_pizza: { active: true, free_delivery: true }, la_musa: { active: true, free_delivery: false } } };

// a FORM-shaped body (no entry_mode) with a FIXED id + phone — the two runs differ only in the table
const formBody = (id, { type = 'delivery', method = 'cash', km = 4, extra = {} } = {}) => {
  const p = north(km);
  return { restaurant_id: RID, order_id: `dpao_${id}`, customer_name: 'Dpao Form', customer_phone: '99880001', customer_email: 'dpao@example.com',
    items_text: `1x ${LINE.name}`, order_type: type, payment_method: method, items: [LINE],
    ...(type === 'delivery' ? { lat: p.lat, lng: p.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1' } : {}), ...extra };
};
// clocks and random ids masked; everything else compared whole
const VOLATILE = /token|tracking|attempt_id|poll|checkout_url|quote_id|uuid|_at$|^ts$|^at$|expires|issued/;
function mask(v, k = '') {
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, mask(v[kk], kk)]));
  if (VOLATILE.test(k)) return '·';
  if (typeof v === 'number' && v > 1.5e12) return 'T';
  return v;
}
const rec = async (id) => mask((await rtdb.ref(`orders/dpao_${id}`).get()).val());

async function formRun(seedSnap) {
  await rtdb.ref().set(seedSnap);   // the SAME starting state for both runs
  const out = {};
  const call = async (name, handler, b, hdr = {}) => { CHARGED.length = 0; const r = await post(handler, b, hdr); out[name] = { status: r.status, json: mask(r.json), charged: [...CHARGED] }; return r; };
  await call('cash-delivery-pinless', app.createOrder, formBody('c1'));
  out['cash-delivery-pinless'].rec = await rec('c1');
  await call('cash-pickup', app.createOrder, formBody('c2', { type: 'pickup' }));
  out['cash-pickup'].rec = await rec('c2');
  await call('card-delivery-pinless', app.chargeOnlineOrder, formBody('k1', { method: 'online' }));
  out['card-delivery-pinless'].rec = await rec('k1');
  await call('quoteOrder', app.quoteOrder, { restaurant_id: RID, items: [LINE] });
  await call('quoteOrder-with-mode', app.quoteOrder, { restaurant_id: RID, items: [LINE], mode: 'delivery', pin: { ...north(4), confirmed: true } });
  await call('quoteRedemption', app.quoteRedemption, { restaurant_id: RID, items: [LINE], redeem: REDEEM }, { 'x-firebase-id-token': MEMBER });
  await call('cash-reward', app.createOrder, formBody('r1', { extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
  out['cash-reward'].rec = await rec('r1');
  const q = await post(app.quoteOrder, { restaurant_id: RID, items: [LINE] });
  await call('cash-signed-form-token', app.createOrder, formBody('t1', { extra: { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } }));
  out['cash-signed-form-token'].rec = await rec('t1');
  const q2 = await post(app.quoteOrder, { restaurant_id: RID, items: [{ ...LINE, qty: 2 }] });
  await call('cash-stale-cart-token', app.createOrder, formBody('t2', { extra: { quote_token: q2.json.quote_token, expected_net_cents: q2.json.net_total_cents } }));
  out['cash-stale-cart-token'].rec = await rec('t2');
  await call('cash-lower-ceiling', app.createOrder, formBody('t3', { extra: { expected_net_cents: q.json.net_total_cents - 1000 } }));
  out['cash-lower-ceiling'].rec = await rec('t3');
  await call('card-signed-form-token', app.chargeOnlineOrder, formBody('t4', { method: 'online', extra: { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } }));
  out['card-signed-form-token'].rec = await rec('t4');
  return out;
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'dpao-seed' });
    const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
  }
  await rtdb.ref('config/redemption_enabled').set(true);
  await rtdb.ref(`user_rewards/${MEMBER}/${RID}`).set({ balance: 20, reserved: 0 });
  await setTable(null);
  const seedSnap = (await rtdb.ref().get()).val();

  // ── A. FORM GOLDENS: an ACTIVE table changes nothing for a form-shaped request ──
  const dark = await formRun(seedSnap);
  const active = await formRun({ ...seedSnap, platform_config: { ...(seedSnap.platform_config || {}), delivery_pricing: ACTIVE } });
  assert.ok(dark['cash-delivery-pinless'].status === 200 && dark['cash-delivery-pinless'].rec && dark['card-delivery-pinless'].charged.length === 1, `premise: the dark run places orders (${JSON.stringify(dark['cash-delivery-pinless']).slice(0, 200)})`);
  assert.ok(dark['cash-reward'].status === 200 && dark['quoteRedemption'].status === 200, `premise: the reward paths run (${JSON.stringify([dark['cash-reward'].json, dark['quoteRedemption'].json]).slice(0, 200)})`);
  for (const k of Object.keys(dark)) assert.deepStrictEqual(active[k], dark[k], `🔴 FORM ${k}: an active table must change nothing (status, body, record, gateway amount)`);
  for (const k of ['cash-delivery-pinless', 'card-delivery-pinless', 'cash-reward', 'cash-signed-form-token']) {
    const r = active[k].rec;
    assert.ok(r && !['delivery_cents', 'promo_discount_cents', 'delivery_snapshot', 'tip_cents'].some((x) => x in r), `${k}: no envío/tip field on a form order`);
  }
  ok(`A FORM GOLDENS: ${Object.keys(dark).length} form requests (cash delivery/pickup/reward, card + gateway amount, quoteOrder ±mode, quoteRedemption, signed / stale / lower-ceiling tokens) are byte-identical under an active table and under none`);

  // ── B. ON → OFF: the app checkout issued under the table, then the table removed ──
  await rtdb.ref().set(seedSnap);
  const appBody = (id, extra = {}) => ({ ...formBody(id, { method: 'online', extra: { pin_confirmed: true, entry_mode: 'app', ...extra } }) });
  const issue = async (id, table, extra) => { await setTable(table); CHARGED.length = 0; const b = appBody(id, extra); const r = await post(app.chargeOnlineOrder, b); assert.ok(r.status === 200 && CHARGED.length === 1, `premise: ${id} issued (${r.text.slice(0, 160)})`); return { b, amount: CHARGED[0] }; };
  const retap = async (b) => { CHARGED.length = 0; const r = await post(app.chargeOnlineOrder, b); const atts = Object.values((await rtdb.ref('payment_attempts').get()).val() || {}).filter((a) => a && a.order_id === b.order_id).length; return { r, charged: [...CHARGED], atts }; };
  const food = dark['cash-pickup'].rec.total_cents;
  for (const [label, table, extra, want] of [
    ['no tip, fee > 0', { policy_version: 2, bands: BANDS }, {}, food + 5000],
    ['tip', { policy_version: 3, bands: BANDS }, { tip_cents: 2000 }, food + 7000],
    ['zero fee', { policy_version: 4, bands: [{ max_km: 7, cents: 0 }] }, {}, food],
  ]) {
    const { b, amount } = await issue(`on_${label.replace(/\W/g, '')}`, table, extra);
    assert.strictEqual(Math.round(amount * 100), want, `${label}: issued at the table's economics`);
    await setTable(null);
    const t = await retap(b);
    assert.deepStrictEqual([t.r.status, t.charged.length, t.atts, (await rtdb.ref(`orders/${b.order_id}/total_cents`).get()).val()], [200, 0, 1, want], `🔴 ${label}: the live checkout is REUSED at its issued economics after the table is removed (${t.r.text.slice(0, 160)})`);
  }
  {
    const { b } = await issue('on_expired', { policy_version: 5, bands: BANDS }, {});
    await setTable(null);
    const aid = (await rtdb.ref(`orders/${b.order_id}/active_attempt_id`).get()).val();
    await rtdb.ref(`payment_attempts/${aid}/hosted_expires_at`).set(Date.now() - 1000);
    const t = await retap(b);
    assert.deepStrictEqual([t.r.status, t.r.json && t.r.json.error, t.charged.length, t.atts], [503, 'delivery_pricing_unavailable', 0, 1], `🔴 expired after the table was removed: never re-issued (${t.r.text.slice(0, 160)})`);
  }
  ok('B ON→OFF (app): a live checkout is reused at its issued economics after the table is removed (no tip, tip, zero fee); an expired one is refused 503 with no new checkout');

  // ── C. THE WRITER on the real SDK (HTTP handlers; the owner is a portal user, never a customer) ──
  await rtdb.ref().set(seedSnap);
  await rtdb.ref('platform_admins/admin_owner').set(true);
  const W = { Authorization: 'Bearer admin_owner' };
  const s1 = await post(app.setDeliveryPricing, { expected_policy_version: 0, bands: [{ max_km: 3, cents: 3000 }, { max_km: 9.5, cents: 6000 }] }, W);
  assert.deepStrictEqual([s1.status, s1.json], [200, { ok: true, policy_version: 1 }], `the first save through the null-first transaction (${s1.text.slice(0, 200)})`);
  const node = (await rtdb.ref(PATH).get()).val();
  assert.ok(typeof node.updated_at === 'number' && node.updated_at > 1.5e12 && node.history[0].at === node.updated_at, `VERIFY-FIRST: the server timestamp resolves inside the transaction (${JSON.stringify([node.updated_at, node.history[0].at])})`);
  assert.deepStrictEqual(Object.keys(node).sort(), ['bands', 'history', 'policy_version', 'updated_at', 'updated_by'], 'the stored node');
  const lp = await DW.loadPricing(rtdb, 'la_musa');
  assert.deepStrictEqual(lp.pricing, { policy_version: 1, bands: [{ max_km: 3, cents: 3000 }, { max_km: 9.5, cents: 6000 }], free_delivery: false }, 'the order path reads exactly the saved table, for any restaurant');
  const entry = node.history[0];
  await rtdb.ref(`${PATH}/history`).set({ 0: entry, 2: entry });   // a gap-keyed history, as the real SDK stores and returns it
  const s2 = await post(app.setDeliveryPricing, { expected_policy_version: 1, bands: [{ max_km: 3, cents: 3500 }] }, W);
  const h = (await rtdb.ref(`${PATH}/history`).get()).val();
  assert.deepStrictEqual([s2.status, Array.isArray(h), h.length, h[0].history_reset, h[0].new_version], [200, true, 1, true, 2], `C1: a gap-keyed stored history (keys 0 and 2) is reset, never trusted (${JSON.stringify(h).slice(0, 200)})`);
  const cust = await post(app.setDeliveryPricing, { expected_policy_version: 2, bands: BANDS }, { Authorization: 'Bearer u_customer' });
  assert.deepStrictEqual([cust.status, cust.json.error], [403, 'not_authorized'], 'a customer token is refused');
  const g = await post(app.getDeliveryPricing, {}, W);
  assert.deepStrictEqual([g.status, g.json.policy_version, g.json.branches.map((b) => b.rid)], [200, 2, ['la_musa', 'x_pizza']], `G2: every registry branch for the picker (${g.text.slice(0, 200)})`);
  assert.deepStrictEqual(Object.keys(g.json.branches[0]).sort(), ['brand_id', 'brand_name', 'hub', 'location_name', 'rid'], 'G2: no other field (no PII)');
  ok('C WRITER (real SDK): null-first first save; the server timestamp resolves inside the transaction; the order path reads the saved table for any restaurant; a gap-keyed history is reset; a customer is refused; G2 lists every branch');

  FINISHED = true;
  console.log(`\ndpao: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('dpao FAILED:', e && (e.stack || e)); process.exit(1); });
