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
// APP-ONLY (owner 2026-11-10, PLAN-delivery-pricing-app-only r2 + addendum A): only an entry_mode:'app' request is priced; a
// form-shaped request is DARK even with an active table (§1 proves it byte-identical to an absent config). The app path reads ONE
// platform-wide table (no per-restaurant map, no free delivery); an absent table refuses an app DELIVERY (503) and leaves an app
// PICKUP dark; the band table, not the restaurant radius, is the app's distance limit (§8).
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
// codex r2 P1 (T / T+1 / T+2): an injected interleaving — the live checkout EXPIRES after the handler's probe and before the
// acquire (keyed on the call, never on a count); the REAL acquire then rotates to a fresh issuance
let EXPIRE_BEFORE_ACQUIRE = null;
stub('../pixelpay-hosted-charge', (r) => ({ ...r, acquireHostedAttempt: async (db, orderId, ...a) => { if (EXPIRE_BEFORE_ACQUIRE) { const f = EXPIRE_BEFORE_ACQUIRE; EXPIRE_BEFORE_ACQUIRE = null; await f(orderId); } return r.acquireHostedAttempt(db, orderId, ...a); } }));

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
let APP = false;   // §1 drives the FORM shape; every later section is an app request (entry_mode:'app')
let PH = 0; const phone = () => `9966${String(PH += 1).padStart(4, '0')}`;
const LINE = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'rice_02', name: 'rice_02', qty: 1, price: 0 } };
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const body = (rid, method, { type = 'delivery', km = 1, confirmed = true, extra = {} } = {}) => {
  const p = north(km);
  return { restaurant_id: rid, order_id: `s3a_${rid}_${method}_${PH}_${Date.now()}`, customer_name: 'S3a Envío', customer_phone: phone(), customer_email: 's3a@example.com',
    items_text: `1x ${LINE[rid].name}`, order_type: type, payment_method: method, items: [LINE[rid]], ...(APP ? { entry_mode: 'app' } : {}),
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
async function quote(rid, extra = {}, hdr = {}) { await clean(); return post(app.quoteOrder, { restaurant_id: rid, items: [LINE[rid]], ...(APP ? { entry_mode: 'app' } : {}), ...extra }, hdr); }
const setBands = (bands, policy_version) => rtdb.ref('platform_config/delivery_pricing').set({ policy_version, bands });
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

  // ── 1. FORMS ARE DARK: absent config, then an ACTIVE table — a form-shaped request is byte-identical in both ──
  const DARK = {};
  for (const [label, cfg] of [['absent', undefined], ['an active table', { x_pizza: { active: true, free_delivery: true }, la_musa: { active: true, free_delivery: false } }]]) {
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
      if (DARK[rid]) assert.deepStrictEqual(shape, DARK[rid], `🔴 ${rid}: a FORM request under an active table must be byte-identical to 'absent'`);
      DARK[rid] = shape;
    }
  }
  ok('FORMS (config absent, or an active table): pin-less delivery accepted, no envío field, charged = food = quoted, quote keys unchanged — byte-identical, both brands');
  APP = true;

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
    assert.deepStrictEqual([q.json.ok, q.json.net_total_cents, q.json.total_cents, q.json.delivery], [true, food + 3000, food, { delivery_cents: 3000, promo_discount_cents: 0, policy_version: 1, mode: 'delivery', from_cents: 3000, max_km: 7 }]);   // S2 §3.6: + the public { from_cents, max_km } (lowest band, last band)
    const same = await cash(rid, { km: 1, extra: { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } });
    assert.deepStrictEqual([same.status, same.rec.quote && same.rec.quote.charged_net_cents], [200, food + 3000], `${rid}: the quoted order is charged the signed net (${same.text.slice(0, 160)})`);
    const q2 = await quote(rid, { mode: 'delivery', pin: { ...north(1), confirmed: true } });
    const moved = await cash(rid, { km: 4, extra: { quote_token: q2.json.quote_token, expected_net_cents: q2.json.net_total_cents } });
    assert.deepStrictEqual([moved.status, moved.json && moved.json.error, moved.rec], [409, 'quote_invalid', null], `🔴 ${rid}: an order at another pin than quoted is refused by the PLACE binding (re-quote) (${moved.text.slice(0, 160)})`);
  }
  ok('quote: the signed net includes envío (+ delivery facts); the quoted order is charged it; an order whose pin moved → 409 quote_invalid (the place binding, codex P2-3)');

  // ── 5. free delivery is OFF (addendum A): a stored free_delivery flag is ignored — a member pays envío; the customer binding holds ──
  await setPricing({ x_pizza: { active: true, free_delivery: true }, la_musa: { active: true, free_delivery: true } });
  {
    const food = DARK.x_pizza.total_cents;
    const member = await cash('x_pizza', { km: 4 }, { 'x-firebase-id-token': 'u_member1' });
    assert.deepStrictEqual([member.status, member.rec.total_cents, member.rec.delivery_cents, member.rec.promo_discount_cents, 'promo' in member.rec.delivery_snapshot], [200, food + 5000, 5000, 0, false], `a member pays envío (${member.text.slice(0, 160)})`);
    const qm = await quote('x_pizza', { mode: 'delivery', pin: { ...north(4), confirmed: true } }, { 'x-firebase-id-token': 'u_member3' });
    assert.deepStrictEqual([qm.json.net_total_cents, qm.json.delivery.promo_discount_cents], [food + 5000, 0], 'the member quote shows no promo');
    const asGuest = await card('x_pizza', { km: 4, extra: { quote_token: qm.json.quote_token, expected_net_cents: qm.json.net_total_cents } });
    assert.deepStrictEqual([asGuest.status, asGuest.json && asGuest.json.error, asGuest.charged.length], [409, 'quote_invalid', 0], `a member-bound quote charged without the account → re-quote (the customer binding) (${asGuest.text.slice(0, 160)})`);
  }
  ok('free delivery OFF: a stored free_delivery flag is ignored — a member pays envío, the quote shows no promo; a member-bound quote is still refused for a guest');

  // ── 6. §3.3 (codex P1-2): a live checkout issued under one table is REUSED after the table changes, at its STORED amount:
  //       no conflict, no refusal, no second attempt ──
  await setBands(BANDS, 1);
  const live = body('x_pizza', 'online', { km: 4 });
  const made = await card('x_pizza', { body: live });
  assert.ok(made.status === 200 && made.charged.length === 1 && made.charged[0] * 100 === DARK.x_pizza.total_cents + 5000, `premise: a checkout at food + L50 (${made.text.slice(0, 160)})`);
  await setBands([{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 6000 }, { max_km: 7, cents: 7000 }], 2);
  const resumed = await card('x_pizza', { body: live });
  assert.ok(resumed.status === 200, `🔴 the live checkout resumes after the table changed (${resumed.status} ${resumed.text.slice(0, 200)})`);
  assert.strictEqual(resumed.attempts, 1, 'no second attempt');
  assert.deepStrictEqual([resumed.charged.length, (await rtdb.ref(`orders/${live.order_id}/total_cents`).get()).val()], [0, DARK.x_pizza.total_cents + 5000], 'no new checkout minted; the order keeps its STORED total');
  await setBands(BANDS, 3);
  ok('§3.3 / P1-2: a checkout issued under one table is REUSED after the table changes, at its stored amount (no conflict, no refusal, no second attempt)');

  // ── P1-1: a refused delivery leaves NO pending order; a stored delivery retried as pickup → order_context_changed ──
  {
    const far = await card('x_pizza', { km: 7.5 });
    assert.deepStrictEqual([far.status, far.json && far.json.error, (await rtdb.ref(`orders/${far.b.order_id}`).get()).exists(), far.attempts], [409, 'outside_delivery_bands', false, 0], `🔴 a refused delivery writes no pending order (${far.text.slice(0, 160)})`);
    const made4 = await card('x_pizza', { km: 4 });
    assert.ok(made4.status === 200 && made4.charged.length === 1, `premise: a live delivery checkout (${made4.text.slice(0, 160)})`);
    const aid = (await rtdb.ref(`orders/${made4.b.order_id}/active_attempt_id`).get()).val();
    await rtdb.ref(`payment_attempts/${aid}/hosted_expires_at`).set(Date.now() - 1000);          // expired → the next call would rotate
    const asPickup = await card('x_pizza', { body: { ...made4.b, order_type: 'pickup', lat: undefined, lng: undefined, pin_confirmed: undefined } });
    assert.deepStrictEqual([asPickup.status, asPickup.json && asPickup.json.error, asPickup.charged.length], [409, 'order_context_changed', 0], `🔴 a stored delivery retried as pickup is refused (${asPickup.text.slice(0, 160)})`);
    assert.strictEqual((await rtdb.ref(`orders/${made4.b.order_id}/order_type`).get()).val(), 'delivery', 'the stored order is untouched');
    const moved = await card('x_pizza', { body: { ...made4.b, ...north(1) } });
    assert.deepStrictEqual([moved.status, moved.json && moved.json.error], [409, 'order_context_changed'], 'another pin on the same order → refused');
  }
  // ── codex r2 P1: grandfathering is decided by the ACQUIRE — a checkout that expires between probe (T) and acquire (T+2)
  //    is never re-issued at its stored amount; the fresh issuance is refused → re-quote → priced now ──
  {
    await setBands(BANDS, 4);
    const b4 = body('x_pizza', 'online', { km: 4 });
    const made = await card('x_pizza', { body: b4 });                                                // T0: issued at food + L50
    assert.ok(made.status === 200 && made.charged.length === 1, `premise: a checkout (${made.text.slice(0, 160)})`);
    await setBands([{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 6000 }, { max_km: 7, cents: 7000 }], 5);
    const q = await quote('x_pizza', { mode: 'delivery', pin: { ...north(4), confirmed: true } });   // a fresh signed quote at food + L60
    assert.strictEqual(q.json.net_total_cents, DARK.x_pizza.total_cents + 6000);
    const aid = (await rtdb.ref(`orders/${b4.order_id}/active_attempt_id`).get()).val();
    EXPIRE_BEFORE_ACQUIRE = async () => { await rtdb.ref(`payment_attempts/${aid}/hosted_expires_at`).set(Date.now() - 1000); };   // T+1
    const withTok = { ...b4, quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents };
    const raced = await card('x_pizza', { body: withTok });                                          // T+2: acquire rotates
    assert.deepStrictEqual([raced.status, raced.json && raced.json.error, raced.json && raced.json.reason, raced.charged.length], [409, 'quote_invalid', 'checkout_expired', 0], `🔴 a fresh checkout is never issued at the grandfathered amount (${raced.text.slice(0, 200)})`);
    const again = await card('x_pizza', { body: withTok });                                          // the SAME order: still bound to its stored amount
    assert.deepStrictEqual([again.status, again.charged.length], [409, 0], `the same order is never re-issued at another amount (its payment binding) (${again.text.slice(0, 200)})`);
    const fresh = await card('x_pizza', { body: { ...withTok, order_id: `${b4.order_id}_n` } });     // the client's re-quoted NEW order
    assert.ok(fresh.status === 200 && fresh.charged.length === 1 && fresh.charged[0] * 100 === DARK.x_pizza.total_cents + 6000, `a new order is charged food + the new envío with the fresh quote (${fresh.text.slice(0, 200)})`);
    await setPricing({ x_pizza: { active: true, free_delivery: false }, la_musa: { active: true, free_delivery: false } });
  }
  ok('codex r2 P1: a checkout expiring between probe and acquire → the fresh issuance is refused (quote_invalid / checkout_expired), never at the stored amount; the same order stays bound (409), a new order is charged at the new table');

  // ── advisor ruling (codex S3a r3): order_context_changed touches NO reward hold — even a failed_create order's stays reserved ──
  {
    const { reserveRedemption } = require('../rewards-reserve');
    const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
    const hold = async (uid, oid) => { await rtdb.ref(`user_rewards/${uid}/x_pizza`).update({ balance: 10, reserved: 0 });
      const r = await reserveRedemption(rtdb, { uid, rid: 'x_pizza', orderId: oid, cost: 8, canonical: { k: 'p2' }, orderFingerprint: `fp_${oid}`, configVersion: REDEMPTION_CONFIG_VERSION, now: Date.now(), hostedExpiresAt: Date.now() + 60000 });
      assert.ok(r && r.ok !== false, `premise: the REAL writer reserved 8 (${JSON.stringify(r)})`); };
    const stateOf = async (uid, oid) => [(await rtdb.ref(`user_rewards/${uid}/x_pizza/reservations/${oid}/state`).get()).val(), (await rtdb.ref(`user_rewards/${uid}/x_pizza/reserved`).get()).val()];
    for (const [kind, attemptState, want] of [['failed_create', { hosted_state: 'failed_create' }, ['reserved', 8]]]) {
      const uid = `u_p2_${kind.length}`;
      const made = await card('x_pizza', { km: 4 }, { 'x-firebase-id-token': uid });
      assert.ok(made.status === 200, `premise: a live delivery checkout (${made.text.slice(0, 160)})`);
      await hold(uid, made.b.order_id);
      const aid = (await rtdb.ref(`orders/${made.b.order_id}/active_attempt_id`).get()).val();
      await rtdb.ref(`payment_attempts/${aid}`).update(attemptState);
      const r = await card('x_pizza', { body: { ...made.b, order_type: 'pickup', lat: undefined, lng: undefined, pin_confirmed: undefined } }, { 'x-firebase-id-token': uid });
      assert.deepStrictEqual([r.status, r.json && r.json.error], [409, 'order_context_changed']);
      assert.deepStrictEqual(await stateOf(uid, made.b.order_id), want, `🔴 ${kind}: the hold after order_context_changed`);
    }
  }
  ok('ruling (codex r3): order_context_changed leaves the reward hold UNTOUCHED — 8 punches reserved by the real writer stay reserved (accepted edge: recoverable manually, no money lost)');

  ok('P1-1: a refused delivery leaves no pending order; a stored delivery retried as pickup (or at another pin) → 409 order_context_changed, never charged food-only');

  // ── P2-3: a pickup quote never authorises a delivery (the place binding) ──
  await setPricing({ x_pizza: { active: true, free_delivery: true } });
  {
    const qp = await quote('x_pizza', { mode: 'pickup' });
    const k = await card('x_pizza', { km: 1, extra: { quote_token: qp.json.quote_token, expected_net_cents: qp.json.net_total_cents } }, { 'x-firebase-id-token': 'u_bind' });
    assert.deepStrictEqual([k.status, k.json && k.json.error, k.charged.length], [409, 'quote_invalid', 0], `🔴 a pickup quote → a member delivery is refused (re-quote) (${k.text.slice(0, 160)})`);
    const qd = await quote('x_pizza', { mode: 'delivery', pin: { ...north(1), confirmed: true } }, { 'x-firebase-id-token': 'u_bind' });
    const k2 = await card('x_pizza', { km: 1, extra: { quote_token: qd.json.quote_token, expected_net_cents: qd.json.net_total_cents } }, { 'x-firebase-id-token': 'u_bind' });
    assert.ok(k2.status === 200 && k2.charged.length === 1 && k2.charged[0] * 100 === DARK.x_pizza.total_cents + 3000, `the quoted delivery is charged food + envío (no promo) (${k2.text.slice(0, 160)})`);
  }
  ok('P2-3: the signed envío context binds — a pickup quote refused for a member delivery; the quoted context charged');

  // ── P2-4: member history carries the ORDER total (food + net envío); dark is today's value ──
  {
    await setPricing({ x_pizza: { active: true, free_delivery: false } });
    const m = await cash('x_pizza', { km: 4 }, { 'x-firebase-id-token': 'u_hist' });
    const h = (await rtdb.ref(`user_orders/u_hist/${m.b.order_id}/total`).get()).val();
    assert.deepStrictEqual([h, m.rec.total], [m.rec.total, (DARK.x_pizza.total_cents + 5000) / 100], 'active: history total == the order total (food + envío)');
    await setPricing(undefined);
    const d = await cash('x_pizza', { km: 4, extra: { entry_mode: undefined } }, { 'x-firebase-id-token': 'u_hist' });   // a FORM request (no table)
    assert.deepStrictEqual([(await rtdb.ref(`user_orders/u_hist/${d.b.order_id}/total`).get()).val(), d.rec.total], [DARK.x_pizza.total_cents / 100, DARK.x_pizza.total_cents / 100], 'a form order: history total == food, exactly as before');
  }
  ok('P2-4: member history total = the order total when active (food + envío); dark it is today\'s food total');
  await setPricing({ x_pizza: { active: true, free_delivery: false } });

  // ── 7. quoteRedemption refuses an unconfirmed pin when active (before any reward work) ──
  const qr = await post(app.quoteRedemption, { restaurant_id: 'x_pizza', items: [LINE.x_pizza], mode: 'delivery', pin: { ...north(1) }, entry_mode: 'app' }, { 'x-firebase-id-token': 'u_red' });
  assert.deepStrictEqual(qr.json, { ok: false, error: 'pin_required' }, `quoteRedemption: ${qr.text.slice(0, 160)}`);
  ok('quoteRedemption: active + an unconfirmed pin → refused like quoteOrder');

  // ── 8. addendum A: the band table is the app's ONLY distance limit; the forms keep the restaurant radius ──
  await rtdb.ref('restaurants/x_pizza/identity/delivery_radius_km').set(3);
  {
    const food = DARK.x_pizza.total_cents;
    const c = await cash('x_pizza', { km: 4 });
    assert.deepStrictEqual([c.status, c.rec && c.rec.total_cents], [200, food + 5000], `an app delivery beyond the 3 km radius but inside the bands is priced (${c.text.slice(0, 160)})`);
    const k = await card('x_pizza', { km: 4 });
    assert.ok(k.status === 200 && k.charged.length === 1 && k.charged[0] * 100 === food + 5000, `the card path too (${k.text.slice(0, 160)})`);
    APP = false;
    const fc = await cash('x_pizza', { km: 4 });
    assert.ok(fc.status === 400 && /Outside delivery zone/.test(fc.text) && fc.rec === null, `🔴 a FORM delivery beyond the radius is still refused, byte-identical (${fc.status} ${fc.text.slice(0, 160)})`);
    const fk = await card('x_pizza', { km: 4 });
    assert.ok(fk.status === 400 && /Outside delivery zone/.test(fk.text) && fk.charged.length === 0, `🔴 the form card path too (${fk.status} ${fk.text.slice(0, 160)})`);
    APP = true;
  }
  await rtdb.ref('restaurants/x_pizza/identity/delivery_radius_km').set(8);
  ok('addendum A: an app delivery beyond the restaurant radius but inside the bands is priced (cash + card); a form delivery there is still refused "Outside delivery zone"');

  // ── 9. addendum A + ruling: an ABSENT table refuses an app DELIVERY (503, nothing written, no checkout) and leaves an app PICKUP dark ──
  await setPricing(undefined);
  {
    const c = await cash('x_pizza', { km: 1 });
    assert.deepStrictEqual([c.status, c.json && c.json.error, c.json && c.json.retryable, c.rec], [503, 'delivery_pricing_unavailable', true, null], `an app cash delivery with no table (${c.text.slice(0, 160)})`);
    const k = await card('x_pizza', { km: 1 });
    assert.deepStrictEqual([k.status, k.json && k.json.error, k.charged.length], [503, 'delivery_pricing_unavailable', 0], `an app card delivery with no table (${k.text.slice(0, 160)})`);
    const q = await quote('x_pizza', { mode: 'delivery', pin: { ...north(1), confirmed: true } });
    assert.deepStrictEqual([q.status, q.json], [503, { ok: false, error: 'delivery_pricing_unavailable', retryable: true }], 'an app delivery quote with no table');
    const pk = await cash('x_pizza', { type: 'pickup' });
    assert.ok(pk.status === 200 && !DELIVERY_KEYS.some((x) => x in pk.rec) && pk.rec.total_cents === DARK.x_pizza.total_cents, `an app pickup with no table is today's dark order (${pk.text.slice(0, 160)})`);
    const qp = await quote('x_pizza', { mode: 'pickup' });
    assert.deepStrictEqual(Object.keys(qp.json).sort(), ['net_total_cents', 'ok', 'quote_token', 'subtotal_cents', 'tax_cents', 'total_cents'], 'an app pickup quote with no table is today\'s dark quote');
  }
  ok('addendum A: no table → an app delivery is refused 503 delivery_pricing_unavailable (cash: nothing written; card: no checkout; quote: 503); an app pickup is today\'s dark order');

  FINISHED = true;
  console.log(`\ns3a-envio: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s3a-envio FAILED:', e && (e.stack || e)); process.exit(1); });
