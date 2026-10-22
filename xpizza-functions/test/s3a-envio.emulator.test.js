'use strict';
// S3a — ENVÍO + free-delivery promo + pin refusal + activation, end to end on the emulator through the REAL index.js
// handlers (createOrder, chargeOnlineOrder, quoteOrder, quoteRedemption). PLACEHOLDER bands (tests only; the real values
// are an owner input before activation): ≤ 2 km L30, ≤ 5 km L50, ≤ 7 km L70; the restaurant radius is 8 km.
//   DARK  (platform_config/delivery_pricing absent, or the restaurant not active in it): byte-identical to before S3 —
//         same order record keys, same charged amount, same quote response keys, a pin-less delivery accepted
//   ACTIVE: envío by straight-line band, recorded + charged; pickup 0; no mode / unconfirmed pin / beyond the bands → refused
//         (nothing written, no checkout); promo ON → an authenticated customer's envío is free, a guest pays; a quote's
//         signed net includes envío and a costlier order than quoted is refused (re-quote); a live checkout issued while
//         dark is still resumed (§3.3 grandfathering)
// Run: npm run test:s3a-envio
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's3a-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 's3a-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s3a-envio: FAILED — exited without completing'); process.exitCode = 1; } });

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
let PH = 0; const phone = () => `9966${String(PH += 1).padStart(4, '0')}`;
const LINE = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'rice_02', name: 'rice_02', qty: 1, price: 0 } };
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const body = (rid, method, { type = 'delivery', km = 1, confirmed = true, extra = {} } = {}) => {
  const p = north(km);
  return { restaurant_id: rid, order_id: `s3a_${rid}_${method}_${PH}_${Date.now()}`, customer_name: 'S3a Envío', customer_phone: phone(), customer_email: 's3a@example.com',
    items_text: `1x ${LINE[rid].name}`, order_type: type, payment_method: method, items: [LINE[rid]],
    ...(type === 'delivery' ? { lat: p.lat, lng: p.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1', ...(confirmed ? { pin_confirmed: true } : {}) } : {}), ...extra };
};
async function cash(rid, opts = {}, hdr = {}) {
  await clean();
  const b = opts.body || body(rid, 'cash', opts);
  const r = await post(app.createOrder, b, hdr);
  return { ...r, b, rec: (await rtdb.ref(`orders/${b.order_id}`).get()).val() };
}
async function card(rid, opts = {}, hdr = {}) {
  await clean(); CHARGED.length = 0;
  const b = opts.body || body(rid, 'online', opts);
  const r = await post(app.chargeOnlineOrder, b, hdr);
  const all = (await rtdb.ref('payment_attempts').get()).val() || {};
  return { ...r, b, charged: [...CHARGED], attempts: Object.values(all).filter((a) => a && a.order_id === b.order_id).length };
}
async function quote(rid, extra = {}, hdr = {}) { await clean(); return post(app.quoteOrder, { restaurant_id: rid, items: [LINE[rid]], ...extra }, hdr); }
const setPricing = (restaurants) => (restaurants === undefined ? rtdb.ref('platform_config/delivery_pricing').remove() : rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: BANDS, restaurants }));
const DELIVERY_KEYS = ['delivery_cents', 'promo_discount_cents', 'delivery_snapshot'];

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 's3a-seed' });
    const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
  }

  // ── 1. DARK: absent config, then a config where the restaurant is NOT active — the same as before S3 ──
  const DARK = {};
  for (const [label, cfg] of [['absent', undefined], ['not active', { x_pizza: { active: false, free_delivery: true }, la_musa: { active: false } }]]) {
    await setPricing(cfg);
    for (const rid of ['x_pizza', 'la_musa']) {
      const c = await cash(rid, { confirmed: false });
      assert.strictEqual(c.status, 200, `${rid} ${label}: a pin-less delivery is accepted as before (${c.text.slice(0, 200)})`);
      assert.ok(!DELIVERY_KEYS.some((k) => k in c.rec), `${rid} ${label}: no envío field on the order (${Object.keys(c.rec)})`);
      const k = await card(rid, { confirmed: false });
      assert.ok(k.status === 200 && k.charged.length === 1, `${rid} ${label}: the checkout is issued (${k.text.slice(0, 200)})`);
      const q = await quote(rid);
      assert.deepStrictEqual(Object.keys(q.json).sort(), ['net_total_cents', 'ok', 'quote_token', 'subtotal_cents', 'tax_cents', 'total_cents'], `${rid} ${label}: the quote response keys are unchanged`);
      const shape = { total_cents: c.rec.total_cents, subtotal_cents: c.rec.subtotal_cents, tax_cents: c.rec.tax_cents, keys: Object.keys(c.rec).filter((x) => !/(_at|^order_id|phone|token|^ts$)/.test(x)).sort(), charged: k.charged[0], quote_net: q.json.net_total_cents };
      assert.strictEqual(shape.total_cents, q.json.net_total_cents, `${rid} ${label}: recorded = quoted`);
      assert.strictEqual(shape.charged * 100, shape.total_cents, `${rid} ${label}: charged = the food total`);
      if (DARK[rid]) assert.deepStrictEqual(shape, DARK[rid], `🔴 ${rid}: 'not active' must be byte-identical to 'absent'`);
      DARK[rid] = shape;
    }
  }
  ok('DARK (config absent, or the restaurant not active in it): pin-less delivery accepted, no envío field, charged = food = quoted, quote keys unchanged — identical in both forms, both brands');

  // ── 2. ACTIVE: envío by band, recorded and charged; food split untouched ──
  await setPricing({ x_pizza: { active: true, free_delivery: false }, la_musa: { active: true, free_delivery: false } });
  for (const rid of ['x_pizza', 'la_musa']) {
    const food = DARK[rid].total_cents;
    for (const [km, cents, band] of [[1, 3000, 0], [4, 5000, 1], [6.5, 7000, 2]]) {
      const c = await cash(rid, { km });
      assert.strictEqual(c.status, 200, `${rid} ${km} km: accepted (${c.text.slice(0, 200)})`);
      assert.deepStrictEqual([c.rec.total_cents, c.rec.subtotal_cents, c.rec.tax_cents, c.rec.delivery_cents, c.rec.promo_discount_cents],
        [food + cents, DARK[rid].subtotal_cents, DARK[rid].tax_cents, cents, 0], `${rid} ${km} km: total = food + envío; the FOOD split (factura base) unchanged`);
      assert.strictEqual(Math.round(c.rec.total * 100), c.rec.total_cents, `${rid} ${km} km: the lempira total (what the driver collects) = total_cents`);
      assert.deepStrictEqual([c.rec.delivery_snapshot.band, c.rec.delivery_snapshot.policy_version, c.rec.delivery_snapshot.mode, c.rec.delivery_snapshot.promo || null], [band, 1, 'delivery', null]);
    }
    const k = await card(rid, { km: 4 });
    assert.ok(k.status === 200 && k.charged.length === 1, `${rid}: card accepted (${k.text.slice(0, 200)})`);
    assert.strictEqual(k.charged[0] * 100, food + 5000, `${rid}: PixelPay is asked for food + envío`);
    const pk = await cash(rid, { type: 'pickup' });
    assert.deepStrictEqual([pk.status, pk.rec.total_cents, pk.rec.delivery_cents, pk.rec.delivery_snapshot.mode], [200, food, 0, 'pickup'], `${rid}: pickup → envío 0`);
  }
  ok('ACTIVE: envío by straight-line band (1 km L30, 4 km L50, 6.5 km L70) recorded and charged on cash AND card; subtotal/tax stay the food split; pickup 0');

  // ── 3. ACTIVE refusals: nothing written, no checkout ──
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [label, opts, err] of [['unconfirmed pin', { confirmed: false }, 'pin_required'], ['beyond the bands (7.5 km, inside the 8 km radius)', { km: 7.5 }, 'outside_delivery_bands']]) {
      const c = await cash(rid, opts);
      assert.deepStrictEqual([c.status, c.json && c.json.error, c.rec], [409, err, null], `🔴 ${rid} ${label}: cash refused, nothing written (${c.text.slice(0, 160)})`);
      const k = await card(rid, opts);
      assert.deepStrictEqual([k.status, k.json && k.json.error, k.charged.length], [409, err, 0], `🔴 ${rid} ${label}: card refused, no checkout (${k.text.slice(0, 160)})`);
    }
    const q0 = await quote(rid);
    assert.deepStrictEqual(q0.json, { ok: false, error: 'mode_required' }, `${rid}: a quote without mode is refused (no free legacy fallback)`);
    const q1 = await quote(rid, { mode: 'delivery', pin: { ...north(1) } });
    assert.deepStrictEqual(q1.json, { ok: false, error: 'pin_required' }, `${rid}: a quote with an unconfirmed pin is refused`);
  }
  ok('ACTIVE refusals: unconfirmed pin → 409 pin_required, beyond the bands → 409 outside_delivery_bands (cash: nothing written; card: no checkout); a quote without mode or a confirmed pin is refused');

  // ── 4. the quote binds envío; a costlier order than quoted is refused (re-quote) ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const food = DARK[rid].total_cents;
    const q = await quote(rid, { mode: 'delivery', pin: { ...north(1), confirmed: true } });
    assert.deepStrictEqual([q.json.ok, q.json.net_total_cents, q.json.total_cents, q.json.delivery], [true, food + 3000, food, { delivery_cents: 3000, promo_discount_cents: 0, policy_version: 1, mode: 'delivery' }]);
    const same = await cash(rid, { km: 1, extra: { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } });
    assert.deepStrictEqual([same.status, same.rec.quote && same.rec.quote.charged_net_cents], [200, food + 3000], `${rid}: the quoted order is charged the signed net (${same.text.slice(0, 160)})`);
    const q2 = await quote(rid, { mode: 'delivery', pin: { ...north(1), confirmed: true } });
    const moved = await cash(rid, { km: 4, extra: { quote_token: q2.json.quote_token, expected_net_cents: q2.json.net_total_cents } });
    assert.deepStrictEqual([moved.status, moved.json && moved.json.error, moved.rec], [409, 'price_increased', null], `🔴 ${rid}: an order farther than quoted is refused (re-quote) (${moved.text.slice(0, 160)})`);
  }
  ok('quote: the signed net includes envío (+ delivery facts); the quoted order is charged it; an order whose pin moved to a dearer band → 409 price_increased');

  // ── 5. the promo: account-only, envío-only ──
  await setPricing({ x_pizza: { active: true, free_delivery: true }, la_musa: { active: true, free_delivery: false } });
  {
    const food = DARK.x_pizza.total_cents;
    const member = await cash('x_pizza', { km: 4 }, { 'x-firebase-id-token': 'u_member1' });
    assert.deepStrictEqual([member.status, member.rec.total_cents, member.rec.delivery_cents, member.rec.promo_discount_cents, member.rec.delivery_snapshot.promo], [200, food, 5000, 5000, 'free_delivery'], `an authenticated customer's envío is free (${member.text.slice(0, 160)})`);
    const guest = await cash('x_pizza', { km: 4 });
    assert.deepStrictEqual([guest.rec.total_cents, guest.rec.promo_discount_cents], [food + 5000, 0], 'a guest pays envío');
    const lm = await cash('la_musa', { km: 4 }, { 'x-firebase-id-token': 'u_member2' });
    assert.strictEqual(lm.rec.promo_discount_cents, 0, 'the switch is per restaurant (la_musa OFF)');
    const qm = await quote('x_pizza', { mode: 'delivery', pin: { ...north(4), confirmed: true } }, { 'x-firebase-id-token': 'u_member3' });
    assert.deepStrictEqual([qm.json.net_total_cents, qm.json.delivery.promo_discount_cents], [food, 5000], 'the member quote shows envío free');
    // ruling C: a promo quote charged as a GUEST (auth lost) costs more → refused, re-quote
    const asGuest = await card('x_pizza', { km: 4, extra: { quote_token: qm.json.quote_token, expected_net_cents: qm.json.net_total_cents } });
    assert.deepStrictEqual([asGuest.status, asGuest.json && asGuest.json.error, asGuest.charged.length], [409, 'price_increased', 0], `a promo quote charged without the account → re-quote (${asGuest.text.slice(0, 160)})`);
  }
  ok('promo: free_delivery ON → an authenticated customer pays no envío (recorded as promo), a guest pays, per restaurant; a member quote charged as a guest → 409 price_increased (re-quote)');

  // ── 6. §3.3: a live checkout issued while DARK is resumed after activation, not refused ──
  await setPricing(undefined);
  const live = body('x_pizza', 'online', { confirmed: false });
  const made = await card('x_pizza', { body: live });
  assert.ok(made.status === 200 && made.charged.length === 1, `premise: a dark checkout exists (${made.text.slice(0, 160)})`);
  await setPricing({ x_pizza: { active: true, free_delivery: false } });
  const resumed = await card('x_pizza', { body: live });
  assert.ok(resumed.status === 200 && resumed.json && resumed.json.error !== 'pin_required', `🔴 the live checkout resumes after activation (${resumed.status} ${resumed.text.slice(0, 200)})`);
  assert.strictEqual(resumed.attempts, 1, 'no second attempt');
  ok('§3.3: a live PixelPay checkout issued while dark is resumed after activation (no pin refusal, no second attempt)');

  // ── 7. quoteRedemption refuses an unconfirmed pin when active (before any reward work) ──
  const qr = await post(app.quoteRedemption, { restaurant_id: 'x_pizza', items: [LINE.x_pizza], mode: 'delivery', pin: { ...north(1) } }, { 'x-firebase-id-token': 'u_red' });
  assert.deepStrictEqual(qr.json, { ok: false, error: 'pin_required' }, `quoteRedemption: ${qr.text.slice(0, 160)}`);
  ok('quoteRedemption: active + an unconfirmed pin → refused like quoteOrder');

  FINISHED = true;
  console.log(`\ns3a-envio: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s3a-envio FAILED:', e && (e.stack || e)); process.exit(1); });
