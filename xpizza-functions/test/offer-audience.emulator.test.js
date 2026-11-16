'use strict';
// offer-audience BUILD (PLAN-5f-offer-audience r4.1, BRIEF) — the audience through the REAL handlers on the emulator (the
// marketing-price suite's world): the catalog published through the real path, offers by 3a's REAL cores with the program ON,
// the member's profile = the verifyOtp expression (index.js:7307), carts by the REAL capp modules, quoteOrder → createOrder /
// chargeOnlineOrder (the hosted PixelPay call stubbed: its AMOUNT recorded), the writer through its own trigger (.run), the sweeps (.run).
//   A1 program OFF: an active 'new' offer ⇒ the quote equals the world without it; no aud signed
//   A2 a NEW member, cash: the quote signs aud + the member; the order charges the nuevos discount, freezes audience + kind and the codes
//      + its day index; delivered ⇒ the writer decides restaurant/first, sets the marker, deletes the codes; the next quote is RETURNING
//   A3 card: the captured amount = the discounted net; the pending record carries the codes and the day index
//   A4 the token placed by ANOTHER member ⇒ 409 offer_changed, nothing written
//   A5 the sweeps run (bounded) and touch nothing in the window
// Run: npm run test:offer-audience
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'aud-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'aud-quote-secret';
process.env.OTP_SALT = process.env.OTP_SALT || 'c'.repeat(40);
process.env.RECON_SECRET = process.env.RECON_SECRET || 'aud-recon';
process.env.AUDIENCE_KEY_V1 = process.env.AUDIENCE_KEY_V1 || 'k'.repeat(48);   // defineSecret('AUDIENCE_KEY_V1').value() reads the env in-process
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const ROOT = path.join(__dirname, '..', '..');
const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(path.join(ROOT, 'customer-app/capp-cart.js'));
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const { buildPublicMenu } = require('../catalog/public-menu');
const R = require('../access/roster');
const CFG = require('../marketing/config');
const C = require('../marketing/offers-core');
const AC = require('../marketing/audience-core');
const OTP = require('../otp-lib');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('offer-audience(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
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
const PIN = { lat: HUB.lat + 1 / 111.195, lng: HUB.lng };
const FEE = 3000;
const RID = 'x_pizza', BRAND = 'bxp';
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
let PH = 0; const phone = () => `9966${String(PH += 1).padStart(4, '0')}`;
let OID = 0; const oid = (tag) => `aud_${tag}_${OID += 1}`;
const OWNER = 'ownerAud1';
let MENU = null;
const bodyOf = (method, s, extra = {}) => ({ restaurant_id: RID, order_id: oid(method), customer_name: 'Aud', customer_phone: phone(), customer_email: 'a@example.com',
  order_type: 'delivery', payment_method: method, lat: PIN.lat, lng: PIN.lng, pin_confirmed: true, address_detected: 'Calle', address_details: 'portón',
  items: s.items, items_text: s.items_text, entry_mode: 'app', ...extra });
const member = (uid) => ({ 'x-firebase-id-token': uid });
const quote = (items, headers = {}) => post(app.quoteOrder, { restaurant_id: RID, items, mode: 'delivery', pin: { ...PIN, confirmed: true }, entry_mode: 'app' }, headers);
const order = async (id) => (await rtdb.ref(`orders/${id}`).get()).val();
const payload = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
const profile = async (uid, ph) => rtdb.ref(`user_profiles/${uid}`).set({ phone: OTP.normalizePhone(ph), phone_hash: OTP.phoneHash(ph), created_at: 1, last_login: 1 });   // the verifyOtp expression
const offerDeps = () => ({ db: rtdb, verifyIdToken: async (t) => { if (t !== `t-${OWNER}`) throw new Error('bad token'); return { uid: OWNER }; }, now: () => Date.now(),
  readMirror: makeRtdbMirrorReader(rtdb), readCategoryMenu: async () => { throw new Error('no category offers here'); } });
const oreq = (body) => ({ method: 'POST', body: { rid: RID, ...body }, get: (h) => (h === 'authorization' ? `Bearer t-${OWNER}` : undefined) });
async function publish(o) {
  const offer = { name: 'Bienvenida', audience: 'all', branches: [RID], schedule: { start: Date.now(), end: Date.now() + 30 * 86400000, days: [0, 1, 2, 3, 4, 5, 6] }, ...o };
  const s = await C.marketingOfferSaveCore(offerDeps(), oreq({ expected_rev: 0, offer }));
  assert.strictEqual(s.status, 200, `premise: saved (${JSON.stringify(s.body)})`);
  const m = await C.marketingOfferSetStateCore(offerDeps(), oreq({ offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }));
  assert.strictEqual(m.status, 200, `premise: published (${JSON.stringify(m.body)})`);
  return s.body.offer.id;
}
async function setSwitches(audience) {
  const cur = (await rtdb.ref('platform_config/marketing').get()).val();
  await rtdb.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });
  const r = await CFG.writeMarketingConfig(rtdb, { expected: cur ? cur.policy_version : 0, config: { offers_enabled: true, anuncio_enabled: false, collections_enabled: false, audience_enabled: audience, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: Date.now() });
  assert.strictEqual(r.ok, true, 'premise: the switches');
}
const caches = () => { require('../marketing/offer-wire')._resetCaches(); require('../marketing/brand-of')._reset(); };
const cartOf = (qty = 2) => { const d = MENU.dishes.find((x) => !x.launcher && !(MENU.weekendOnlyCats.has(String(x.cat)) || MENU.pickupOnlyCats.has(String(x.cat)))); const c = createCart(MENU); c.add(d.key, [], qty); return { cart: c, s: require(path.join(ROOT, 'customer-app/capp-serialize.js')).serialize(c) }; };
const deliver = async (orderId) => { await rtdb.ref(`orders/${orderId}/status`).set('delivered'); const after = await rtdb.ref(`orders/${orderId}/status`).get();
  await app.markAudienceOnStatus.run({ data: { before: { val: () => 'new' }, after }, params: { orderId }, time: new Date().toISOString() }); };

(async () => {
  await wipe();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'aud-seed' });
  await publishVersion(fs, RID, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await rtdb.ref(`restaurants/${RID}/identity`).set({ name: RID, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS, brand_id: BRAND });
  await rtdb.ref(`brands/${BRAND}`).set({ name: RID, active: true, locations: { [RID]: 'member' }, activation: { state: 'on', since: 1 } });
  assert.strictEqual((await R.mutateRoster({ db: rtdb, now: () => 1 }, BRAND, { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'd@m.hn' } })).ok, true, 'premise: owner');
  const m = await buildPublicMenu(fs, RID, { known: new Set([RID]), isActive: async () => true });
  MENU = adaptMenu({ rid: m.rid, representation_version: m.representation_version, menu: m.body });
  await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: [{ max_km: 2, cents: FEE }], restaurants: { [RID]: { active: true, free_delivery: false } } });
  await setSwitches(true);
  await publish({ type: 'nuevos', params: { off_cents: 5000 }, audience: 'new' });
  await profile('u_aud1', '+504 8888-4444'); await profile('u_aud2', '+504 9999-1111');

  // ── A1. program OFF ⇒ the world without the audience offer ──
  {
    const { s } = cartOf();
    await setSwitches(false); caches(); await clean();
    const q = await quote(s.items, member('u_aud1'));
    assert.ok(q.json && q.json.ok && !q.json.offer, `🔴 A1: no audience offer while OFF (${q.text.slice(0, 160)})`);
    assert.ok(!('aud' in payload(q.json.quote_token)), '🔴 A1: no aud signed while OFF');
    await setSwitches(true); caches();
    ok('A1 program OFF: an active new-customer offer is neither priced nor signed');
  }
  // ── A2. a NEW member, cash, through delivery ──
  let firstCash;
  {
    const { cart, s } = cartOf(); const gross = cart.subtotalCents();
    await clean(); caches();
    const q = await quote(s.items, member('u_aud1'));
    assert.deepStrictEqual([q.json.offer && q.json.offer.type, q.json.offer && q.json.offer.discount_cents, q.json.net_total_cents], ['nuevos', 5000, gross - 5000 + FEE], `🔴 A2: the quote (${q.text.slice(0, 200)})`);
    const p = payload(q.json.quote_token);
    const ids = AC.idsOf({ key: process.env.AUDIENCE_KEY_V1, brandId: BRAND, phoneHash: OTP.phoneHash('+504 8888-4444') });
    assert.deepStrictEqual([p.customer_id, p.aud.kind, p.aud.ids], ['u_aud1', 'new', ids], '🔴 A2: aud + the member signed');
    const cb = bodyOf('cash', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); const c = await post(app.createOrder, cb, member('u_aud1'));
    assert.strictEqual(c.status, 200, `A2 cash: ${c.text.slice(0, 200)}`);
    const o = await order(cb.order_id); firstCash = cb.order_id;
    assert.deepStrictEqual([o.total_cents, o.offer.type, o.offer.audience, o.offer.audience_kind, o.audience_ids], [gross - 5000 + FEE, 'nuevos', 'new', 'new', ids], '🔴 A2: the stored order');
    assert.strictEqual((await rtdb.ref(`audience_ids_by_day/${AC.dayKey(o.created_at, cb.order_id)}`).get()).val(), true, '🔴 A2: the day index');
    await deliver(cb.order_id);
    const d = await order(cb.order_id);
    assert.deepStrictEqual([d.offer_reconcile && d.offer_reconcile.funded_by, d.audience_ids || null], ['restaurant', null], '🔴 A2: decided restaurant/first; codes deleted');
    assert.ok((await rtdb.ref(`customer_seen/${BRAND}/${ids.p}`).get()).exists(), '🔴 A2: the marker');
    caches(); await clean();
    const q2 = await quote(s.items, member('u_aud1'));
    assert.deepStrictEqual([q2.json.offer || null, payload(q2.json.quote_token).aud.kind], [null, 'returning'], '🔴 A2: the next quote is RETURNING — no new-customer discount');
    ok('A2 a NEW member (cash): signed aud → charged the nuevos discount → frozen audience + codes + day index → delivered ⇒ restaurant/first, marker, codes deleted → RETURNING');
  }
  // ── A3. card ──
  {
    const { cart, s } = cartOf(3); const gross = cart.subtotalCents();
    await clean(); caches(); CHARGED.length = 0;
    const q = await quote(s.items, member('u_aud2'));
    const kb = bodyOf('online', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); const k = await post(app.chargeOnlineOrder, kb, member('u_aud2'));
    assert.ok(k.status === 200 && k.json.checkout_url && CHARGED.length === 1, `A3 card: ${k.text.slice(0, 200)}`);
    assert.strictEqual(Math.round(CHARGED[0] * 100), gross - 5000 + FEE, '🔴 A3: the captured amount = the discounted net');
    const po = await order(kb.order_id);
    assert.ok(AC.idsShapeOk(po.audience_ids) && po.offer.audience === 'new', '🔴 A3: the pending record carries the codes + the audience offer');
    assert.strictEqual((await rtdb.ref(`audience_ids_by_day/${AC.dayKey(po.created_at, kb.order_id)}`).get()).val(), true, '🔴 A3: the day index');
    ok('A3 card: the captured amount = the discounted net; the pending record carries the codes and the day index');
  }
  // ── A4. the token placed by ANOTHER member ──
  {
    const { s } = cartOf();
    await rtdb.ref('customer_seen').remove(); await profile('u_aud3', '+504 7777-2222');
    await clean(); caches();
    const q = await quote(s.items, member('u_aud3'));
    assert.strictEqual(payload(q.json.quote_token).aud.kind, 'new', 'premise: u_aud3 is NEW');
    const cb = bodyOf('cash', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); const c = await post(app.createOrder, cb, member('u_aud2'));
    assert.deepStrictEqual([c.status, c.json && c.json.error], [409, 'offer_changed'], `🔴 A4: refused (${c.text.slice(0, 160)})`);
    assert.strictEqual(await order(cb.order_id), null, '🔴 A4: nothing written');
    ok('A4 a token issued to one member, placed by another ⇒ 409 offer_changed, nothing written');
  }
  // ── A5. the sweeps ──
  {
    const before = JSON.stringify((await rtdb.ref('audience_ids_by_day').get()).val());
    await app.sweepAudienceIds.run({}); await app.sweepAudienceMarkers.run({});
    assert.strictEqual(JSON.stringify((await rtdb.ref('audience_ids_by_day').get()).val()), before, 'A5: nothing in the window swept');
    void firstCash;
    ok('A5 the two scheduled sweeps run and touch nothing inside the window');
  }
  FINISHED = true;
  console.log(`\noffer-audience(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('offer-audience(emulator): FAILED —', e && e.stack || e); process.exit(1); });
