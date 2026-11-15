'use strict';
// PLAN-5f-marketing-price r0 (APPROVED 2026-11-14) step 1 — a restaurant offer through the REAL handlers on the emulator:
//   the catalog published through the real path (x_pizza = the platform-factura restaurant; THIRD = the synthetic, non-factura brand),
//   offers by 3a's REAL cores (marketingOfferSaveCore → SetStateCore) on the emulator RTDB, carts by the REAL capp modules
//   (capp-cart → capp-serialize), quoteOrder → createOrder / chargeOnlineOrder (the hosted PixelPay call stubbed: its AMOUNT recorded).
//   E1 OFF: offers switched off ⇒ the quote response and the stored order are those of a world with no offer at all
//   E2 cash: quote total_cents = the GROSS cart (the capp's compare); net discounted; the stored total = the net; order.offer frozen;
//      the rebaja on the platform-factura restaurant, none on THIRD; the summary foots with a «Descuento» line
//   E3 card: the captured PixelPay amount × 100 = the quoted discounted net; the pending record carries the offer
//   E4 envío offer: the fee waived on the stored order, promo_discount_cents = the fee, delivery_discount_funder 'restaurant'
//   E5 the offer paused between quote and order ⇒ 409 offer_changed, NOTHING written
//   E6 a legacy-form order (no entry_mode 'app') ⇒ no offer
// Run: npm run test:marketing-price
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'mkt-price-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'mkt-price-quote-secret';
process.env.OTP_SALT = process.env.OTP_SALT || 'c'.repeat(40);
process.env.RECON_SECRET = process.env.RECON_SECRET || 'mkt-price-recon';   // E12: the dispatcher's abandon (resolveManualReconciliation)
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

// E13: the SDK placement's provider is the fake adapter (the SDK suites' recipe) — every call recorded, none expected here
const { makeAdapter } = require('../payments/sdk/psp-adapter');
const { makeFakePsp } = require('../payments/sdk/fake-adapter');
const FAKE = makeFakePsp({});
stub('../payments/sdk/deps', (r) => ({ ...r, productionDeps: (db) => ({ ...r.productionDeps(db), psp: makeAdapter(FAKE.impl), ppNamespace: 'sandbox' }) }));
const PC = require(path.join(__dirname, '..', '..', 'customer-app', 'capp-pay-card.js'));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const ROOT = path.join(__dirname, '..', '..');
const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(path.join(ROOT, 'customer-app/capp-cart.js'));
const { serialize } = require(path.join(ROOT, 'customer-app/capp-serialize.js'));
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const { buildPublicMenu } = require('../catalog/public-menu');
const { publishThirdBrand, THIRD } = require('../contract/third-brand');
const { orderBreakdownCents } = require('../order-money');
const R = require('../access/roster');
const CFG = require('../marketing/config');
const C = require('../marketing/offers-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('marketing-price(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body, bearer = process.env.MAKE_SECRET) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
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
const PIN = { lat: HUB.lat + 1 / 111.195, lng: HUB.lng };   // 1 km → the first band (L 30)
const FEE = 3000;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
let PH = 0; const phone = () => `9966${String(PH += 1).padStart(4, '0')}`;
let OID = 0; const oid = (tag) => `mkp_${tag}_${OID += 1}`;
const OWNER = 'ownerMkp1';
const MENU = {};

const bodyOf = (rid, method, s, extra = {}) => ({ restaurant_id: rid, order_id: oid(`${rid}_${method}`), customer_name: 'Mkt', customer_phone: phone(), customer_email: 'm@example.com',
  order_type: 'delivery', payment_method: method, lat: PIN.lat, lng: PIN.lng, pin_confirmed: true, address_detected: 'Calle', address_details: 'portón',
  items: s.items, items_text: s.items_text, entry_mode: 'app', ...extra });
const quote = (rid, items, extra = {}) => post(app.quoteOrder, { restaurant_id: rid, items, mode: 'delivery', pin: { ...PIN, confirmed: true }, entry_mode: 'app', ...extra });
const order = async (id) => (await rtdb.ref(`orders/${id}`).get()).val();
const strip = (j) => { const o = { ...j }; delete o.quote_token; return o; };

// offers by 3a's REAL cores on the emulator RTDB
const offerDeps = () => ({ db: rtdb, verifyIdToken: async (t) => { if (t !== `t-${OWNER}`) throw new Error('bad token'); return { uid: OWNER }; }, now: () => Date.now(),
  readMirror: makeRtdbMirrorReader(rtdb), readCategoryMenu: async () => { throw new Error('no category offers here'); } });
const oreq = (rid, body) => ({ method: 'POST', body: { rid, ...body }, get: (h) => (h === 'authorization' ? `Bearer t-${OWNER}` : undefined) });
async function publish(rid, o) {
  const offer = { name: 'Oferta', audience: 'all', branches: [rid], schedule: { start: Date.now(), end: Date.now() + 30 * 86400000, days: [0, 1, 2, 3, 4, 5, 6] }, caps: { redemptions: null, spend_cents: null, weekly: false }, ...o };
  const s = await C.marketingOfferSaveCore(offerDeps(), oreq(rid, { expected_rev: 0, offer }));
  assert.strictEqual(s.status, 200, `premise: saved (${JSON.stringify(s.body)})`);
  const m = await C.marketingOfferSetStateCore(offerDeps(), oreq(rid, { offer_id: s.body.offer.id, to: 'active', expected_rev: 1 }));
  assert.strictEqual(m.status, 200, `premise: published (${JSON.stringify(m.body)})`);
  return s.body.offer.id;
}
async function pauseOffer(rid, brand, id) {
  const rev = (await rtdb.ref(`marketing_offers/${brand}/${id}`).get()).val().rev;
  const m = await C.marketingOfferSetStateCore(offerDeps(), oreq(rid, { offer_id: id, to: 'paused_owner', expected_rev: rev }));
  assert.strictEqual(m.status, 200, `premise: paused (${JSON.stringify(m.body)})`);
}
async function setOffers(on) {
  const cur = (await rtdb.ref('platform_config/marketing').get()).val();
  await rtdb.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });   // the owner's go-live marker (PLAN-5f-pending-sweep r1 §4)
  const r = await CFG.writeMarketingConfig(rtdb, { expected: cur ? cur.policy_version : 0, config: { offers_enabled: on, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: Date.now() });
  assert.strictEqual(r.ok, true, 'premise: the marketing switch');
  await new Promise((r2) => setTimeout(r2, 0));
}
const cartOf = (rid, qty = 2) => { const m = MENU[rid]; const d = m.dishes.find((x) => !x.launcher && !(m.weekendOnlyCats.has(String(x.cat)) || m.pickupOnlyCats.has(String(x.cat)))); const c = createCart(m); c.add(d.key, [], qty); return { cart: c, s: serialize(c, m) }; };
const offerCaches = () => require('../marketing/offer-wire')._resetCaches();   // the 60 s per-instance caches, between phases

(async () => {
  await wipe();
  await fs.collection('restaurants').doc('x_pizza').set({ name: 'x_pizza', pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate('x_pizza', { activeVersionId: null }, { source_sha: 'mkt-price-seed' });
  await publishVersion(fs, 'x_pizza', seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await publishThirdBrand(fs, { mirror: makeRtdbMirror(rtdb) });
  const BRAND = { x_pizza: 'bxp', [THIRD]: 'bth' };
  for (const rid of ['x_pizza', THIRD]) {
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS, brand_id: BRAND[rid] });
    await rtdb.ref(`brands/${BRAND[rid]}`).set({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'on', since: 1 } });
    assert.strictEqual((await R.mutateRoster({ db: rtdb, now: () => 1 }, BRAND[rid], { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'd@m.hn' } })).ok, true, 'premise: owner');
    const m = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true });
    MENU[rid] = adaptMenu({ rid: m.rid, representation_version: m.representation_version, menu: m.body });
  }
  await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: [{ max_km: 2, cents: FEE }, { max_km: 5, cents: 5000 }],
    restaurants: { x_pizza: { active: true, free_delivery: false }, [THIRD]: { active: true, free_delivery: false } } });
  await setOffers(true);

  // ── E1. OFF ⇒ the world with no offer at all ──
  {
    const { s } = cartOf('x_pizza');
    await clean(); offerCaches();
    const qNone = await quote('x_pizza', s.items);
    const cbNone = bodyOf('x_pizza', 'cash', s, { quote_token: qNone.json.quote_token, expected_net_cents: qNone.json.net_total_cents });
    await clean(); assert.strictEqual((await post(app.createOrder, cbNone)).status, 200, 'E1 premise: the no-offer order');
    const id = await publish('x_pizza', { type: 'pct', params: { pct: 20, max_cents: 100000 } });
    await setOffers(false); offerCaches();
    await clean();
    const qOff = await quote('x_pizza', s.items);
    assert.deepStrictEqual(strip(qOff.json), strip(qNone.json), '🔴 E1: OFF — the quote response equals the no-offer world');
    const cbOff = bodyOf('x_pizza', 'cash', s, { quote_token: qOff.json.quote_token, expected_net_cents: qOff.json.net_total_cents });
    await clean(); assert.strictEqual((await post(app.createOrder, cbOff)).status, 200, 'E1: the OFF order');
    const a = await order(cbNone.order_id), b = await order(cbOff.order_id);
    for (const k of ['total', 'total_cents', 'subtotal_cents', 'tax_cents', 'delivery_cents', 'promo_discount_cents', 'desc_rebaja_cents', 'offer', 'delivery_discount_funder', 'summary_lines'])
      assert.deepStrictEqual(b[k], a[k], `🔴 E1: OFF — order.${k} equals the no-offer world`);
    await setOffers(true); offerCaches();
    ok(`E1 OFF: an ACTIVE offer (${id}) with the switch off ⇒ the quote response and the stored cash order equal the no-offer world`);
  }

  // ── E2. cash, platform-factura + non-factura ──
  for (const rid of ['x_pizza', THIRD]) {
    if (rid === THIRD) await publish(THIRD, { type: 'pct', params: { pct: 20, max_cents: 100000 } });
    const { cart, s } = cartOf(rid);
    const gross = cart.subtotalCents(); const d = Math.floor((gross * 20) / 10000) * 100;
    await clean(); offerCaches();
    const q = await quote(rid, s.items);
    assert.ok(q.json && q.json.ok, `E2 ${rid}: quote — ${q.text.slice(0, 200)}`);
    assert.strictEqual(q.json.total_cents, gross, `🔴 E2 ${rid}: quote total_cents = the GROSS cart (the capp's compare)`);
    assert.deepStrictEqual([q.json.offer && q.json.offer.discount_cents, q.json.net_total_cents], [d, gross - d + FEE], `E2 ${rid}: the offer block + the discounted net`);
    assert.ok(!('offer_id' in q.json.offer), `E2 ${rid}: no offer id to the customer (Q9)`);
    assert.deepStrictEqual([q.json.offer, 'offer_next' in q.json], [{ type: 'pct', pct: 20, discount_cents: d, waived_envio_cents: 0 }, false], `🔴 E2 ${rid}: the quote's offer = the label facts (pct), no name; an applied offer ⇒ no offer_next (advisor 11-14)`);
    const cb = bodyOf(rid, 'cash', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); const c = await post(app.createOrder, cb);
    assert.strictEqual(c.status, 200, `E2 ${rid} cash: ${c.text.slice(0, 200)}`);
    const o = await order(cb.order_id);
    assert.strictEqual(o.total_cents, q.json.net_total_cents, `🔴 E2 ${rid}: the STORED total = the quoted net`);
    assert.deepStrictEqual([o.offer.type, o.offer.discount_cents, o.offer.funded_by, o.offer.waived_envio_cents], ['pct', d, 'restaurant', 0], `E2 ${rid}: order.offer frozen`);
    const paid = orderBreakdownCents((gross - d) / 100, rid), full = orderBreakdownCents(gross / 100, rid);
    assert.deepStrictEqual([o.subtotal_cents, o.tax_cents], [paid.subtotal_cents, paid.tax_cents], `E2 ${rid}: the ISV split of the PAID food`);
    if (rid === 'x_pizza') assert.strictEqual(o.desc_rebaja_cents, full.subtotal_cents - paid.subtotal_cents, 'E2 x_pizza: the rebaja (platform factura)');
    else assert.ok(!o.desc_rebaja_cents, `E2 ${rid}: no fiscal rebaja off the platform factura`);
    const sl = o.summary_lines || [];
    assert.strictEqual(sl.reduce((a, l) => a + l.cents, 0), gross - d, `E2 ${rid}: the summary foots to the charged food`);
    assert.deepStrictEqual(sl[sl.length - 1], { name: 'Descuento', qty: 1, cents: -d }, `E2 ${rid}: the «Descuento» line`);
  }
  ok('E2 cash: gross total_cents kept, net discounted, stored = quoted, order.offer frozen, ISV of the paid food, rebaja only on the platform factura, summary foots');

  // ── E3. card ──
  {
    const { cart, s } = cartOf('x_pizza', 3);
    const gross = cart.subtotalCents(); const d = Math.floor((gross * 20) / 10000) * 100;
    await clean(); offerCaches(); CHARGED.length = 0;
    const q = await quote('x_pizza', s.items);
    const kb = bodyOf('x_pizza', 'online', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); const k = await post(app.chargeOnlineOrder, kb);
    assert.ok(k.status === 200 && k.json.checkout_url && CHARGED.length === 1, `E3 card: ${k.text.slice(0, 200)}`);
    assert.strictEqual(Math.round(CHARGED[0] * 100), gross - d + FEE, '🔴 E3: the captured PixelPay amount = the discounted net');
    const po = await order(kb.order_id);
    assert.deepStrictEqual([po.total_cents, po.offer && po.offer.discount_cents], [gross - d + FEE, d], 'E3: the pending record carries the total and the offer');
    // E3b (Q5): the REAL customer poll (paymentStatus) — pending: no offer; paid: the frozen offer's summary (the order screen's
    // «Descuento»), never its id; an order without an offer answers exactly the pre-offer keys
    const ptok = (await rtdb.ref(`payment_attempts/${po.active_attempt_id}/poll_token`).get()).val();
    const poll = async () => (await post(app.paymentStatus, { order_id: kb.order_id, token: ptok })).json;
    const pend = await poll();
    assert.ok(pend && pend.ok && !('offer' in pend), `E3b: a pending checkout shows no offer (${JSON.stringify(pend)})`);
    await rtdb.ref(`orders/${kb.order_id}`).update({ status: 'new', payment_status: 'confirmed' });   // the confirmed shape (d4b-readers F precedent)
    await rtdb.ref(`payment_attempts/${po.active_attempt_id}/hosted_state`).set('paid');
    const paid = await poll();
    assert.deepStrictEqual([paid.state, paid.offer], ['paid', { type: 'pct', discount_cents: d, waived_envio_cents: 0 }], `🔴 E3b: the paid poll shows the offer summary (${JSON.stringify(paid)})`);
    assert.ok(!JSON.stringify(paid).includes(po.offer.offer_id), 'E3b: no offer id reaches the customer (Q9)');
    assert.ok(po.offer.name && !('name' in paid.offer), 'E3b: no merchant offer name reaches the customer (advisor 11-14)');
    await rtdb.ref(`orders/${kb.order_id}/offer`).remove();
    assert.deepStrictEqual(Object.keys(await poll()).sort(), ['ok', 'redemption', 'state', 'total_cents', 'tracking_token'], 'E3b: no offer ⇒ the poll is the pre-offer shape');
  }
  ok('E3 card: the PixelPay amount × 100 = the quoted discounted net; the pending record carries the offer; E3b the paid poll shows the offer summary, never its id');

  // ── E4. envío offer ──
  {
    const pauseAll = async () => { for (const [id, e] of Object.entries((await rtdb.ref(`marketing_live_b/${BRAND[THIRD]}/${THIRD}`).get()).val() || {})) if (e) await pauseOffer(THIRD, BRAND[THIRD], id); };
    await pauseAll();
    await publish(THIRD, { type: 'envio', params: {} });   // no minimum = absent (3a b62765981)
    const { cart, s } = cartOf(THIRD);
    await clean(); offerCaches();
    const q = await quote(THIRD, s.items);
    assert.strictEqual(q.json.net_total_cents, cart.subtotalCents(), 'E4: the quote waives the fee');
    const cb = bodyOf(THIRD, 'cash', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); assert.strictEqual((await post(app.createOrder, cb)).status, 200, 'E4: placed');
    const o = await order(cb.order_id);
    assert.deepStrictEqual([o.total_cents, o.delivery_cents, o.promo_discount_cents, o.delivery_discount_funder, o.offer.waived_envio_cents], [cart.subtotalCents(), FEE, FEE, 'restaurant', FEE], '🔴 E4: the waived fee, funder «restaurant»');
  }
  ok('E4 envío offer: the stored order waives the fee — promo_discount_cents = the fee, delivery_discount_funder «restaurant»');

  // ── E5. paused between quote and order ──
  {
    const live = (await rtdb.ref(`marketing_live_b/${BRAND.x_pizza}/x_pizza`).get()).val() || {};
    const id = Object.keys(live)[0];
    const { s } = cartOf('x_pizza');
    await clean(); offerCaches();
    const q = await quote('x_pizza', s.items);
    assert.ok(q.json.offer, 'E5 premise: quoted with the offer');
    await pauseOffer('x_pizza', BRAND.x_pizza, id);
    const cb = bodyOf('x_pizza', 'cash', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); const c = await post(app.createOrder, cb);
    assert.deepStrictEqual([c.status, c.json && c.json.error], [409, 'offer_changed'], `🔴 E5: offer_changed (${c.text.slice(0, 160)})`);
    assert.strictEqual(await order(cb.order_id), null, 'E5: nothing written');
  }
  ok('E5: the offer paused between quote and order ⇒ 409 offer_changed, nothing written');

  // ── E7 / E8. the payment fingerprints with an offer (advisor 11-14: a cell for EACH) ──
  {
    const { orderFingerprint } = require('../pixelpay-charge');
    const live = (await rtdb.ref(`marketing_live_b/${BRAND.x_pizza}/x_pizza`).get()).val() || {};
    if (!Object.keys(live).length) await publish('x_pizza', { type: 'pct', params: { pct: 20, max_cents: 100000 } });
    const { cart, s } = cartOf('x_pizza');
    const gross = cart.subtotalCents(); const d = Math.floor((gross * 20) / 10000) * 100;
    // E7 cash: the fingerprint stays on the GROSS food (computed before the offer, stable across retries) — a retry of the SAME order
    // with the offer applied is still recognised as the same order (idempotent, nothing re-written, one order)
    await clean(); offerCaches();
    const q = await quote('x_pizza', s.items);
    const cb = bodyOf('x_pizza', 'cash', s, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
    await clean(); assert.strictEqual((await post(app.createOrder, cb)).status, 200, 'E7 premise: placed with the offer');
    const first = await order(cb.order_id);
    assert.strictEqual(first.offer.discount_cents, d, 'E7 premise: the offer applied');
    await clean(); const again = await post(app.createOrder, cb);
    assert.deepStrictEqual([again.status, again.json && again.json.idempotent], [200, true], `🔴 E7: the cash retry is the SAME order (${again.text.slice(0, 160)})`);
    assert.deepStrictEqual(await order(cb.order_id), first, 'E7: nothing re-written');
    // E8 card: the fingerprint binds the DISCOUNTED net (what is charged), never the gross
    await clean(); offerCaches(); CHARGED.length = 0;
    const qk = await quote('x_pizza', s.items);
    const kb = bodyOf('x_pizza', 'online', s, { quote_token: qk.json.quote_token, expected_net_cents: qk.json.net_total_cents });
    await clean(); const k = await post(app.chargeOnlineOrder, kb);
    assert.ok(k.status === 200 && CHARGED.length === 1, `E8 premise: card issued (${k.text.slice(0, 160)})`);
    const po = await order(kb.order_id);
    assert.strictEqual(po.payment_fingerprint, orderFingerprint(kb.order_id, gross - d + FEE, po.items_text, ''), '🔴 E8: the card fingerprint binds the discounted net');
    assert.notStrictEqual(po.payment_fingerprint, orderFingerprint(kb.order_id, gross + FEE, po.items_text, ''), 'E8: never the gross');
  }
  ok('E7 cash retry with an offer = the same order (gross fingerprint); E8 the card fingerprint binds the discounted net');

  // ── E9–E11. step 2: usage held at placement, a cap skips the offer, a cancel gives it back, a card counts once ──
  {
    const usageOf = async (id) => (await rtdb.ref(`marketing_usage/${id}`).get()).val();
    for (const [id, e] of Object.entries((await rtdb.ref(`marketing_live_b/${BRAND[THIRD]}/${THIRD}`).get()).val() || {})) if (e) await pauseOffer(THIRD, BRAND[THIRD], id);
    const capId = await publish(THIRD, { type: 'pct', params: { pct: 10, max_cents: 100000 }, caps: { redemptions: 1, spend_cents: null, weekly: false } });
    const { cart, s } = cartOf(THIRD);
    const d = Math.floor((cart.subtotalCents() * 10) / 10000) * 100;
    await clean(); offerCaches();
    const q1 = await quote(THIRD, s.items);
    assert.strictEqual(q1.json.offer && q1.json.offer.discount_cents, d, 'E9 premise: offered');
    const qLate = await quote(THIRD, s.items);   // a second customer quoted while the one use is still open
    assert.strictEqual(qLate.json.offer && qLate.json.offer.discount_cents, d, 'E9 premise: the second quote is offered too');
    const b1 = bodyOf(THIRD, 'cash', s, { quote_token: q1.json.quote_token, expected_net_cents: q1.json.net_total_cents });
    await clean(); assert.strictEqual((await post(app.createOrder, b1)).status, 200, 'E9: the first order');
    const o1 = await order(b1.order_id);
    assert.deepStrictEqual([o1.offer.usage, (await usageOf(capId)).redemptions, (await usageOf(capId)).spend_cents], ['held', 1, d], '🔴 E9: the usage held WITH the order');
    // E9b: that second customer places AFTER the cap is reached ⇒ the placement skips the capped offer (fresh usage read) and the cash
    // gate refuses against the signed one — the EXACT body, nothing written, nothing counted
    const b2 = bodyOf(THIRD, 'cash', s, { quote_token: qLate.json.quote_token, expected_net_cents: qLate.json.net_total_cents });
    await clean(); offerCaches(); const late = await post(app.createOrder, b2);
    assert.deepStrictEqual([late.status, late.json], [409, { error: 'offer_changed', net_total_cents: qLate.json.net_total_cents + d, order_id: b2.order_id }], `🔴 E9b: the cash cap answers exactly (${late.text.slice(0, 200)})`);
    assert.deepStrictEqual([await order(b2.order_id), (await usageOf(capId)).redemptions], [null, 1], 'E9b: nothing written, nothing counted');
    await clean(); offerCaches();
    const q2 = await quote(THIRD, s.items);
    assert.ok(!q2.json.offer, 'E9: the capped offer is no longer quoted (no offer_changed loop)');
    // E10: the cancel trigger gives the use back, once
    await rtdb.ref(`orders/${b1.order_id}/status`).set('cancelled');
    const ev = { data: { before: { val: () => 'new' }, after: { val: () => 'cancelled' } }, params: { orderId: b1.order_id } };
    await app.onOrderCancelled.run(ev); await app.onOrderCancelled.run(ev);
    assert.deepStrictEqual([(await order(b1.order_id)).offer.usage, (await usageOf(capId)).redemptions], ['released', 0], '🔴 E10: released exactly once (the trigger ran twice)');
    await clean(); offerCaches();
    assert.ok((await quote(THIRD, s.items)).json.offer, 'E10: offered again after the release');
    // E11: a card order holds at the gate, counted once across a retried request
    await pauseOffer(THIRD, BRAND[THIRD], capId);
    const xId = Object.keys((await rtdb.ref(`marketing_live_b/${BRAND.x_pizza}/x_pizza`).get()).val() || {})[0] || await publish('x_pizza', { type: 'pct', params: { pct: 20, max_cents: 100000 } });
    const before = ((await usageOf(xId)) || {}).redemptions || 0;
    const k = cartOf('x_pizza', 4);
    await clean(); offerCaches(); CHARGED.length = 0;
    const qk = await quote('x_pizza', k.s.items);
    const kb = bodyOf('x_pizza', 'online', k.s, { quote_token: qk.json.quote_token, expected_net_cents: qk.json.net_total_cents });
    await clean(); const r1 = await post(app.chargeOnlineOrder, kb);
    assert.ok(r1.status === 200 && CHARGED.length === 1, `E11 premise: issued (${r1.text.slice(0, 160)})`);
    assert.deepStrictEqual([(await order(kb.order_id)).offer.usage, (await usageOf(xId)).redemptions], ['held', before + 1], '🔴 E11: the card held at the gate');
    await clean(); const r2 = await post(app.chargeOnlineOrder, kb);
    assert.ok(r2.status === 200 || r2.status === 202, `E11: the retry answered (${r2.text.slice(0, 160)})`);
    assert.strictEqual((await usageOf(xId)).redemptions, before + 1, '🔴 E11: the retry counts nothing more');
    // E12 (ruling (a)): the LIVE hosted path has no decline writer — the declined checkout simply expires; the REAL sweep flags it for a
    // person with the usage STILL held (an unknown outcome is never a release, rule 17); the person's REAL abandon cancels it; the
    // cancel hook gives the use back.
    const aid = (await order(kb.order_id)).active_attempt_id;
    assert.strictEqual((await rtdb.ref(`payment_attempts/${aid}/hosted_state`).get()).val(), 'created', 'E12 premise: a live, unpaid hosted checkout');
    await rtdb.ref(`payment_attempts/${aid}/hosted_expires_at`).set(Date.now() - 16 * 60000);   // time passes: past expiry + the 15-min callback grace
    await app.sweepStalePending.run({});
    const flagged = await order(kb.order_id);
    assert.deepStrictEqual([flagged.status, flagged.payment_status], ['pending_payment', 'manual_reconciliation'], 'E12 premise: the REAL sweep flagged it for a person');
    assert.deepStrictEqual([flagged.offer.usage, (await usageOf(xId)).redemptions], ['held', before + 1], '🔴 E12: at manual_reconciliation the usage is STILL held');
    const ab = await post(app.resolveManualReconciliation, { order_id: kb.order_id, action: 'abandon' }, process.env.RECON_SECRET);
    assert.strictEqual((await order(kb.order_id)).status, 'cancelled', `E12 premise: the REAL abandon cancels (${ab.status} ${ab.text.slice(0, 160)})`);
    const evk = { data: { before: { val: () => 'pending_payment' }, after: { val: () => 'cancelled' } }, params: { orderId: kb.order_id } };
    await app.onOrderCancelled.run(evk);
    assert.deepStrictEqual([(await order(kb.order_id)).offer.usage, (await usageOf(xId)).redemptions], ['released', before], '🔴 E12: the abandon\'s cancel releases the use');
  }
  ok('E9 a cap: held with the order, then no longer quoted; E10 the cancel trigger releases once; E11 a card holds at the gate, once across a retry; E12 a declined hosted checkout: still held at manual_reconciliation, released by the abandon');

  // ── E13. the SDK placement (placeSdkOrder = the same card handler in SDK mode) refuses a changed offer with the SAME body ──
  {
    const xid = Object.keys((await rtdb.ref(`marketing_live_b/${BRAND.x_pizza}/x_pizza`).get()).val() || {})[0] || await publish('x_pizza', { type: 'pct', params: { pct: 20, max_cents: 100000 } });
    const k = cartOf('x_pizza', 2);
    await clean(); offerCaches();
    const qk = await quote('x_pizza', k.s.items);
    assert.ok(qk.json.offer && qk.json.offer.discount_cents > 0, `E13 premise: quoted with the offer (${qk.text.slice(0, 160)})`);
    const before = ((await rtdb.ref(`marketing_usage/${xid}`).get()).val() || {}).redemptions || 0;
    await pauseOffer('x_pizza', BRAND.x_pizza, xid);
    const base = bodyOf('x_pizza', 'online', k.s, { quote_token: qk.json.quote_token, expected_net_cents: qk.json.net_total_cents, order_id: `sdk_261114-${String(Date.now() % 1e6).padStart(6, '0')}-MKTPRCEX` });   // the SDK id grammar (no I L O U)
    const sb = PC.placeBody(base, { kind: 'new', sdk_token: 'tok_emu', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } }, 'att_emu_mktprice000001', { guest: false });
    assert.ok(sb, 'E13 premise: the client builds the SDK body');
    await clean(); offerCaches(); const r = await post(app.placeSdkOrder, sb, 'idt_member');
    assert.deepStrictEqual([r.status, r.json], [409, { error: 'offer_changed', net_total_cents: qk.json.net_total_cents + qk.json.offer.discount_cents, order_id: sb.order_id }], `🔴 E13: the SDK placement answers the SAME offer_changed body (${r.text.slice(0, 200)})`);
    assert.strictEqual(FAKE.calls.length, 0, 'E13: no provider call (nothing charged)');
    assert.strictEqual(((await rtdb.ref(`marketing_usage/${xid}`).get()).val() || {}).redemptions || 0, before, 'E13: nothing counted');
  }
  ok('E13 the SDK placement refuses a changed offer with the same 409 offer_changed body; no provider call, nothing counted');

  // ── E14. offer_next (capp Slice A): a quote under an offer's minimum names it and what is missing; at the minimum it applies ──
  {
    for (const [id, e] of Object.entries((await rtdb.ref(`marketing_live_b/${BRAND[THIRD]}/${THIRD}`).get()).val() || {})) if (e) await pauseOffer(THIRD, BRAND[THIRD], id);
    const one = cartOf(THIRD, 1); const unit = one.cart.subtotalCents();
    await publish(THIRD, { type: 'lps', params: { off_cents: 5000, min_cents: 2 * unit } });
    await clean(); offerCaches();
    const under = await quote(THIRD, one.s.items);
    assert.ok(under.json && under.json.ok && !under.json.offer, `E14 premise: under the minimum, no offer (${under.text.slice(0, 160)})`);
    assert.deepStrictEqual(under.json.offer_next, { type: 'lps', remaining_cents: unit, off_cents: 5000 }, `🔴 E14: offer_next names the offer and what is missing (${JSON.stringify(under.json.offer_next)})`);
    await clean(); offerCaches();
    const at = await quote(THIRD, cartOf(THIRD, 2).s.items);
    assert.deepStrictEqual([at.json.offer, 'offer_next' in at.json], [{ type: 'lps', min_cents: 2 * unit, discount_cents: 5000, waived_envio_cents: 0 }, false], `🔴 E14: at the minimum the offer applies (min_cents shown), no offer_next (${at.text.slice(0, 200)})`);
  }
  ok('E14 offer_next under the minimum (type, remaining, off); at the minimum the lps offer applies with its min_cents and no offer_next');

  // ── E6. a legacy-form order ⇒ no offer ──
  {
    const { s } = cartOf(THIRD);
    await clean(); offerCaches();
    const cb = bodyOf(THIRD, 'cash', s, { entry_mode: undefined });
    delete cb.entry_mode;
    await clean(); const c = await post(app.createOrder, cb);
    assert.strictEqual(c.status, 200, `E6: ${c.text.slice(0, 200)}`);
    const o = await order(cb.order_id);
    assert.ok(!o.offer && !o.delivery_discount_funder, 'E6: a legacy-form order carries no offer');
  }
  ok('E6: a legacy-form order (no entry_mode app) gets no offer');

  FINISHED = true;
  console.log(`marketing-price(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
