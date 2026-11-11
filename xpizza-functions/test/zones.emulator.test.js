'use strict';
// ENVÍO STEP 2 — drawn no-delivery zones, end to end on the emulator through the REAL index.js handlers, the REAL owner-only writer
// (setDeliveryPricing over HTTP, its hours lock satisfied by closing every branch with grammar-valid hours) and the real Admin SDK
// (PLAN-envio-zones-step2-r2 §4, §9; Codex r1 F1/F4/F5/F9/F10). Zones are drawn ONLY through the writer; the malformed case is the
// one direct corruption. Run: npm run test:zones
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
// tokens: 'admin*' → a portal (non-customer) user; anything else → a customer
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => (String(t).startsWith('admin') ? { uid: String(t) } : { uid: String(t), customer: true }) }) }));

const CAPS = { render: false, authoring: false };   // the render switch, mutable (the groups-intake pattern)
stub('../catalog/platform-groups', (r) => ({ ...r, groupCapabilities: () => ({ ...CAPS }) }));
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const DW = require('../delivery/delivery-wire');
const { signQuoteToken } = require('../quote-token');
const { buildMaterializeUpdates } = require('../materialize');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { confirmOnlinePayment } = require('../pixelpay-confirm');
const { paymentHash } = require('../pixelpay');
const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';   // sandbox (resolvePixelPayConfig default), as capp-s4
// a REAL issued token, aged: the same signed payload with expires_at in the past (the signer the issuer uses)
const expire = (token) => { const p = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')); return signQuoteToken({ ...p, expires_at: Date.now() - 1000 }, process.env.QUOTE_TOKEN_SECRET); };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('zones: FAILED — exited without completing'); process.exitCode = 1; } });

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
  if (k === 'pixelpay_order_id' && typeof v === 'string') return v.replace(/-[0-9a-f]{16}$/, '-·');   // `${order_id}-${attempt_id}`: the order id compared, the attempt id masked
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
  await call('cash-token-for-another-cart', app.createOrder, formBody('t2', { extra: { quote_token: q2.json.quote_token, expected_net_cents: q2.json.net_total_cents } }));
  out['cash-token-for-another-cart'].rec = await rec('t2');
  await call('cash-expired-token', app.createOrder, formBody('t5', { extra: { quote_token: expire(q.json.quote_token), expected_net_cents: q.json.net_total_cents } }));
  out['cash-expired-token'].rec = await rec('t5');
  await call('cash-lower-ceiling', app.createOrder, formBody('t3', { extra: { expected_net_cents: q.json.net_total_cents - 1000 } }));
  out['cash-lower-ceiling'].rec = await rec('t3');
  await call('cash-price-drop', app.createOrder, formBody('t6', { extra: { expected_net_cents: q.json.net_total_cents + 5000 } }));
  out['cash-price-drop'].rec = await rec('t6');
  await call('card-signed-form-token', app.chargeOnlineOrder, formBody('t4', { method: 'online', extra: { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } }));
  out['card-signed-form-token'].rec = await rec('t4');
  await call('card-price-drop', app.chargeOnlineOrder, formBody('t7', { method: 'online', extra: { expected_net_cents: q.json.net_total_cents + 5000 } }));
  out['card-price-drop'].rec = await rec('t7');
  return out;
}


// grammar-valid hours (F10): every day closed while the zones are saved (the owner's lock), open 00:00–23:59 while ordering
const DAYS7 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOSED7 = Object.fromEntries(DAYS7.map((d) => [d, { open: false }]));
const OPEN7 = Object.fromEntries(DAYS7.map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
const setHours = async (h) => { for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`restaurants/${rid}/identity/hours`).set(h); require('../restaurant-config')._cache.clear(); };
// the square zone around north(4) — the pin every app delivery below uses unless it says otherwise
const ZONE = { id: 'z_aaaaaaaa', name: 'Sector A', points: [{ lat: +(HUB.lat + 3.5 / 111.195).toFixed(6), lng: -87.21 }, { lat: +(HUB.lat + 3.5 / 111.195).toFixed(6), lng: -87.19 },
  { lat: +(HUB.lat + 4.5 / 111.195).toFixed(6), lng: -87.19 }, { lat: +(HUB.lat + 4.5 / 111.195).toFixed(6), lng: -87.21 }] };
const W = { Authorization: 'Bearer adminowner' };
let PV = 0;
async function drawZones(zones) {   // through the REAL writer, every branch closed (the lock), then reopened for ordering
  await setHours(CLOSED7);
  const r = await post(app.setDeliveryPricing, { expected_policy_version: PV, bands: BANDS, no_delivery_zones: zones }, W);
  assert.deepStrictEqual([r.status, r.json && r.json.ok], [200, true], `premise: the writer saves the zones (${r.text.slice(0, 200)})`);
  PV = r.json.policy_version;
  await setHours(OPEN7);
}
const appBody = (id, { method = 'cash', km = 4, type = 'delivery', extra = {} } = {}) => formBody(id, { method, km, type, extra: { pin_confirmed: true, entry_mode: 'app', ...extra } });
const recOf = async (id) => (await rtdb.ref(`orders/dpao_${id}`).get()).val();
const attemptsOf = async (id) => Object.values((await rtdb.ref('payment_attempts').get()).val() || {}).filter((a) => a && a.order_id === `dpao_${id}`);
const reserved = async () => ((await rtdb.ref(`user_rewards/${MEMBER}/${RID}/reserved`).get()).val() || 0);

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'zones-seed' });
    const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, location_name: `Sucursal ${rid}`, hours: OPEN7 });
  }
  await rtdb.ref('config/redemption_enabled').set(true);
  await rtdb.ref(`user_rewards/${MEMBER}/${RID}`).set({ balance: 20, reserved: 0 });
  await rtdb.ref('platform_admins/adminowner').set(true);

  // ── Z0. the lock (owner D1): a branch open → the zones save is refused 409, nothing written ──
  {
    const r = await post(app.setDeliveryPricing, { expected_policy_version: 0, bands: BANDS, no_delivery_zones: [ZONE] }, W);
    assert.deepStrictEqual([r.status, r.json && r.json.error], [409, 'zones_locked_while_open'], `Z0: open branches → locked (${r.text.slice(0, 200)})`);
    assert.strictEqual((await rtdb.ref(PATH).get()).val(), null, 'Z0: nothing written');
  }
  ok('Z0 the hours lock: with a branch open the writer refuses the zones (409 zones_locked_while_open), nothing written');

  // a pre-zone quote token (Z8) — issued before any zone exists
  await drawZones([]);   // the table, no zones yet
  const preQ = await post(app.quoteOrder, { restaurant_id: RID, items: [LINE], mode: 'delivery', pin: { ...north(4), confirmed: true }, entry_mode: 'app' });
  assert.ok(preQ.status === 200 && preQ.json.quote_token, `premise: a quote before the zone (${preQ.text.slice(0, 160)})`);
  // a LIVE app card checkout issued before the zone (Z9, the chargeContext resume)
  CAPS.render = false;
  CHARGED.length = 0;
  const live = await post(app.chargeOnlineOrder, appBody('cz1', { method: 'online' }));
  assert.ok(live.status === 200 && CHARGED.length === 1, `premise: a live app card checkout before the zone (${live.text.slice(0, 160)})`);
  const liveRec0 = await recOf('cz1');
  // a reward-BOUND live checkout issued before the zone (Z10, the bound resume — render ON, a member's reward)
  CAPS.render = true;
  CHARGED.length = 0;
  const bound = await post(app.chargeOnlineOrder, appBody('rb1', { method: 'online', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
  assert.ok(bound.status === 200 && bound.json.checkout_url, `premise: a reward checkout issued under render ON (${bound.text.slice(0, 200)})`);
  assert.match(String((await recOf('rb1')).charge_inputs_fp), /^[0-9a-f]{64}$/, 'premise: render ON binds the charge-input fingerprint (the bound path)');
  const boundAgain = await post(app.chargeOnlineOrder, appBody('rb1', { method: 'online', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
  assert.deepStrictEqual([boundAgain.status, boundAgain.json && boundAgain.json.checkout_url], [200, bound.json.checkout_url], 'premise: before the zone the bound checkout resumes (same URL)');
  const boundRec0 = await recOf('rb1'), boundAtts0 = (await attemptsOf('rb1')).length, held0 = await reserved();
  CAPS.render = false;

  // ── the zone is drawn ──
  await drawZones([ZONE]);
  const node = (await rtdb.ref(PATH).get()).val();
  assert.deepStrictEqual([node.no_delivery_zones.length, node.history[0].new.zones.count], [1, 1], 'the zone is stored compact, history by count + sha');

  // ── Z1. quotes inside the zone → 409, nothing signed (F4) ──
  {
    const q = await post(app.quoteOrder, { restaurant_id: RID, items: [LINE], mode: 'delivery', pin: { ...north(4), confirmed: true }, entry_mode: 'app' });
    assert.deepStrictEqual([q.status, q.json && q.json.error, q.json && 'quote_token' in q.json], [409, 'no_delivery_zone', false], `Z1 quoteOrder (${q.text.slice(0, 160)})`);
    const qr = await post(app.quoteRedemption, { restaurant_id: RID, items: [LINE], redeem: REDEEM, mode: 'delivery', pin: { ...north(4), confirmed: true }, entry_mode: 'app' }, { 'x-firebase-id-token': MEMBER });
    assert.deepStrictEqual([qr.status, qr.json && qr.json.error], [409, 'no_delivery_zone'], `Z1 quoteRedemption (${qr.text.slice(0, 160)})`);
  }
  ok('Z1 quotes: an app delivery pin inside a zone → 409 no_delivery_zone on quoteOrder and quoteRedemption, no token');

  // ── Z2. cash inside the zone (F9): no order / fulfillment record, no payment op, an owned hold released ──
  {
    const c = await post(app.createOrder, appBody('zc1'));
    assert.deepStrictEqual([c.status, c.json && c.json.error], [409, 'no_delivery_zone'], `Z2 cash (${c.text.slice(0, 160)})`);
    assert.deepStrictEqual([await recOf('zc1'), (await rtdb.ref('tasks/dpao_zc1_delivery').get()).val(), Object.values((await rtdb.ref('order_tracking').get()).val() || {}).filter((t) => t && t.order_id === 'dpao_zc1').length || null, (await attemptsOf('zc1')).length],
      [null, null, null, 0], 'Z2: no order, no task, no tracking projection, no payment attempt');
    const before = await reserved();
    const cr = await post(app.createOrder, appBody('zc2', { extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
    assert.deepStrictEqual([cr.status, cr.json && cr.json.error, await recOf('zc2')], [409, 'no_delivery_zone', null], `Z2 a member's reward cash (${cr.text.slice(0, 160)})`);
    assert.strictEqual(await reserved(), before, 'Z2: the hold the request took is released by the gate (owned-hold cleanup)');
  }
  ok('Z2 cash (F9): refused 409 — no order, task, tracking or payment attempt; a reward order\'s owned hold is released');

  // ── Z3. card inside the zone → no checkout ──
  {
    CHARGED.length = 0;
    const k = await post(app.chargeOnlineOrder, appBody('zk1', { method: 'online' }));
    assert.deepStrictEqual([k.status, k.json && k.json.error, CHARGED.length, (await attemptsOf('zk1')).length], [409, 'no_delivery_zone', 0, 0], `Z3 card (${k.text.slice(0, 160)})`);
  }
  ok('Z3 card: refused 409, no gateway call, no attempt');

  // ── Z4. outside the zone and in the limit → priced; beyond the limit → outside_delivery_bands (bands first) ──
  {
    const c = await post(app.createOrder, appBody('zo1', { km: 1 }));
    assert.deepStrictEqual([c.status, (await recOf('zo1')).delivery_cents], [200, 3000], `Z4 outside the zone (${c.text.slice(0, 160)})`);
    const far = await post(app.createOrder, appBody('zo2', { km: 7.5 }));
    assert.deepStrictEqual([far.status, far.json && far.json.error], [409, 'outside_delivery_bands'], `Z4 beyond the limit (${far.text.slice(0, 160)})`);
  }
  ok('Z4 outside the zone in the limit → priced (L30); beyond the bands → outside_delivery_bands');

  // ── Z5/Z6. pickup with the pin inside → accepted; a FORM delivery inside → today's answer ──
  {
    const pk = await post(app.createOrder, appBody('zp1', { type: 'pickup' }));
    assert.deepStrictEqual([pk.status, (await recOf('zp1')).order_type], [200, 'pickup'], `Z5 pickup (${pk.text.slice(0, 160)})`);
    const fm = await post(app.createOrder, formBody('zf1'));
    const fr = await recOf('zf1');
    assert.ok(fm.status === 200 && fr && !('delivery_cents' in fr) && !('delivery_snapshot' in fr), `Z6 a FORM delivery inside the zone is today's (${fm.text.slice(0, 160)})`);
  }
  ok('Z5/Z6 a pickup is never checked; a FORM delivery inside the zone is placed exactly as today (D2)');

  // ── Z8. a token signed BEFORE the zone does not bypass it ──
  {
    const t = await post(app.createOrder, appBody('zt1', { extra: { quote_token: preQ.json.quote_token, expected_net_cents: preQ.json.net_total_cents } }));
    assert.deepStrictEqual([t.status, t.json && t.json.error, await recOf('zt1')], [409, 'no_delivery_zone', null], `Z8 (${t.text.slice(0, 160)})`);
  }
  ok('Z8 a quote signed before the zone was drawn is refused at the order');

  // ── Z9. the chargeContext resume of a LIVE checkout (F1): refused, nothing touched ──
  {
    CAPS.render = false;
    CHARGED.length = 0;
    const r = await post(app.chargeOnlineOrder, appBody('cz1', { method: 'online' }));
    const atts = await attemptsOf('cz1');
    assert.deepStrictEqual([r.status, r.json && r.json.error, r.json && 'checkout_url' in r.json, CHARGED.length, atts.length, atts[0].hosted_state], [409, 'no_delivery_zone', false, 0, 1, 'created'], `Z9 (${r.text.slice(0, 200)})`);
    assert.deepStrictEqual(await recOf('cz1'), liveRec0, 'Z9: the stored order (economics, attempt) unchanged');
  }
  ok('Z9 a LIVE app checkout whose stored pin is now in a zone is NOT resumed: 409, no URL, no gateway call, the attempt and the order untouched');

  // ── Z10. the reward-BOUND resume (F1, index.js before chargeContext): refused, the hold and the attempt untouched ──
  {
    CAPS.render = true;
    CHARGED.length = 0;
    const r = await post(app.chargeOnlineOrder, appBody('rb1', { method: 'online', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
    assert.deepStrictEqual([r.status, r.json && r.json.error, r.json && 'checkout_url' in r.json, CHARGED.length], [409, 'no_delivery_zone', false, 0], `Z10 (${r.text.slice(0, 200)})`);
    assert.deepStrictEqual([(await attemptsOf('rb1')).length, await reserved()], [boundAtts0, held0], 'Z10: no attempt retired or added, the reward hold kept');
    assert.deepStrictEqual(await recOf('rb1'), boundRec0, 'Z10: the stored order unchanged');
    CAPS.render = false;
  }
  ok('Z10 a reward-BOUND live checkout whose stored pin is now in a zone is NOT resumed: 409, no URL, the hold and the attempt kept');

  // ── Z7. malformed zones + valid bands (F5): app pickup priced, app delivery 503, a FORM untouched (the one direct corruption) ──
  {
    await rtdb.ref(`${PATH}/no_delivery_zones`).set([{ id: 'z_bbbbbbbb', name: 'Rota', points: [[14.1, -87.2], [14.2, -87.2]] }]);
    const pk = await post(app.createOrder, appBody('zm1', { type: 'pickup' }));
    assert.strictEqual(pk.status, 200, `Z7 app pickup (${pk.text.slice(0, 160)})`);
    const dl = await post(app.createOrder, appBody('zm2', { km: 1 }));
    assert.deepStrictEqual([dl.status, dl.json && dl.json.error, await recOf('zm2')], [503, 'delivery_zones_invalid', null], `Z7 app delivery fails closed (${dl.text.slice(0, 160)})`);
    const fm = await post(app.createOrder, formBody('zm3'));
    assert.strictEqual(fm.status, 200, `Z7 a FORM order (${fm.text.slice(0, 160)})`);
  }
  ok('Z7 malformed zones with valid bands: an app pickup is priced, an app delivery fails closed (503 delivery_zones_invalid), a FORM order is untouched');

  FINISHED = true;
  console.log(`\nzones: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('zones FAILED:', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); process.exit(1); });
