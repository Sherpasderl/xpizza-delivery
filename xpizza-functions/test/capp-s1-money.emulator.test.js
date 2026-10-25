'use strict';
// Customer app S1a2 (PLAN-capp-S1.FINAL §3–§5) — the new renderer's bodies (customer-app/ capp-menu → capp-cart →
// capp-serialize, the REAL S1a1 modules) through the REAL handlers on the emulator. The old forms' bodies come from the REAL live
// pages (the S0 harness boots them; their own chg / toggleDetailExtra / buildOrder). Restaurants: x_pizza, la_musa (both
// published through the real path) and r3_synth (the synthetic third brand; plain dishes — the real builder refuses priced
// extras for a synthetic restaurant, a documented limit).
//   M  money: merchandise subtotal == quoteOrder.total_cents (food); quoteOrder.net_total_cents == the STORED order's total_cents
//      == the captured PixelPay amount × 100 — fee OFF and ON (S3a envío active); a cart matrix per restaurant
//   P  price change after the quote: up → 409 price_increased (nothing written, no checkout) and a re-quote succeeds; down →
//      charged the lower net (the gate's stated asymmetry); a v1 display vs a v2 quote is detectable
//   R  rewards on N per-instance lines: quoteRedemption → cash and card; the free item outside the paid total; the bound
//      checkout resumed from the ISSUED body; consume on confirm, release on cancel; earn == the old form's for the same cart
//   D  dedup without clearing stamps: retap (the phone token not re-burned), reordered configurations, a changed configuration
//   X  the cross-grammar residual EXACTLY as stated, in the F3-covered ordering (card issued → cash → card confirmed late): plain
//      carts every guard across clients; configured carts no alert, no materialization hold — both directions, a confirm 180 s
//      after the stamp. Plus the PRE-EXISTING F3 scope: cash first → card → confirm is never held, for any grammar
//   L  1,500 characters: no reward → stored == client text; with a reward → client text + exactly one complete suffix
//   F  factura: N-line orders reconcile gross / base / tax / rebaja to the FOOD total (net delivery excluded)
// Run: npm run test:capp-s1-money
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'capp-s1-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'capp-s1-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.OTP_SALT = process.env.OTP_SALT || 'c'.repeat(40);
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
const { createCart, sigOf } = require(path.join(ROOT, 'customer-app/capp-cart.js'));
const { serialize, issuedSnapshot, resendBody, ITEMS_TEXT_LIMIT } = require(path.join(ROOT, 'customer-app/capp-serialize.js'));
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { buildPublicMenu } = require('../catalog/public-menu');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { candidateFromSource, publishThirdBrand, THIRD } = require('../contract/third-brand');
const { confirmAndMaterialize } = require('../pixelpay-confirm');
const { buildMaterializeUpdates } = require('../materialize');
const { buildFacturaRecord } = require('../factura/build-record');
const { cancelOrderCore } = require('../cancel-order-core');
const { rateLimitKey } = require('../order-dedup');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('capp-s1-money(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

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
const PIN = { lat: HUB.lat + 1 / 111.195, lng: HUB.lng };   // 1 km north → the first band
const BANDS = [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }, { max_km: 7, cents: 7000 }];
const setPricing = (on) => (on ? rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: BANDS,
  restaurants: { x_pizza: { active: true, free_delivery: false }, la_musa: { active: true, free_delivery: false }, [THIRD]: { active: true, free_delivery: false } } })
  : rtdb.ref('platform_config/delivery_pricing').remove());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
let PH = 0; const phone = () => `9955${String(PH += 1).padStart(4, '0')}`;
let OID = 0; const oid = (tag) => `cs1_${tag}_${OID += 1}`;
const UID = 'u_capp';
const REWARD = { x_pizza: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, la_musa: { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 2, name: 'Arroz Blanco' }] } };
const BALANCE = { x_pizza: 8, la_musa: 400 };
const FACTURA_CONFIG = { restaurant_name: 'R', legal_name: 'R SA', rtn: '08011999123456', address_1: 'A', address_2: 'B', email: 'f@x.hn', phone: '+504',
  cai_code: 'ABC-123-CAI', prefix: '000-001-01', range_start: 1, range_end: 100000, fecha_limite: '2027-12-31', is_temp: false };
const edgeDeps = (rid) => ({ db: rtdb, restaurant: { lat: HUB.lat, lng: HUB.lng, name: rid, phone: '+504' }, buildMaterializeUpdates, genToken: () => 'TOK', alert: async () => {},
  client: { voidTransaction: async () => ({ ok: true }) }, getIdentity: async () => ({ active: true, hours: HOURS }), sanitizeText: (x) => String(x || ''), serverTimestamp: 1,
  voidOrRefund: async () => ({ ok: true, outcome: 'voided' }) });

const MENU = {}; const ENV = {};
async function serve(rid) {
  const m = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true });
  ENV[rid] = { rid: m.rid, representation_version: m.representation_version, menu: m.body };
  MENU[rid] = adaptMenu(ENV[rid]);
}
// a new-renderer body: the cart serialized by the REAL S1a1 modules, delivery to the confirmed 1-km pin
function bodyOf(rid, method, cart, extra = {}) {
  const s = serialize(cart, MENU[rid]);
  return { restaurant_id: rid, order_id: oid(`${rid}_${method}`), customer_name: 'Capp S1', customer_phone: phone(), customer_email: 'capp@example.com',
    order_type: 'delivery', payment_method: method, lat: PIN.lat, lng: PIN.lng, pin_confirmed: true, address_detected: 'Calle Principal', address_details: 'portón',
    items: s.items, items_text: s.items_text, ...extra };
}
const quote = (rid, items, hdr = {}) => post(app.quoteOrder, { restaurant_id: rid, items, mode: 'delivery', pin: { ...PIN, confirmed: true } }, hdr);
const order = async (id) => (await rtdb.ref(`orders/${id}`).get()).val();
const configurable = (m) => m.dishes.find((d) => !d.launcher && m.extrasFor(d.key).length >= 2);
const plainDish = (m, not) => m.dishes.find((d) => !d.launcher && d.key !== not && !(m.weekendOnlyCats.has(String(d.cat)) || m.pickupOnlyCats.has(String(d.cat))));
const orderableDish = (m) => m.dishes.find((d) => !d.launcher && !(m.weekendOnlyCats.has(String(d.cat)) || m.pickupOnlyCats.has(String(d.cat))));

// the cart matrix (by restaurant: r3 has no extras)
function carts(rid) {
  const m = MENU[rid]; const out = [];
  const p = orderableDish(m); const plain = createCart(m); plain.inc(p.key); out.push(['plain', plain]);
  const x3 = createCart(m); x3.add(p.key, [], 3); out.push(['a dish ×3', x3]);
  const d = configurable(m);
  if (d && !(m.weekendOnlyCats.has(String(d.cat)) || m.pickupOnlyCats.has(String(d.cat)))) {
    const [e1, e2] = m.extrasFor(d.key);
    const t = createCart(m); t.add(d.key, [e1.key], 2); t.add(d.key, [e1.key, e2.key], 1); out.push(['toggles', t]);
    const mix = createCart(m); mix.add(d.key, [e2.key], 1); mix.inc(d.key); mix.inc(plainDish(m, d.key).key); out.push(['two configurations + another dish', mix]);
  }
  const g = Object.values(m.groups)[0];
  if (g) { const c = createCart(m); c.add(g.choices[0], [], 1); c.add(g.choices[1], [], 2); out.push(['launcher choices', c]); }
  return out;
}

// the OLD form's body for the same cart, from the REAL live page (S0 harness boot + the page's own writers)
let HARNESS = null;
async function oldBody(rid, build) {
  if (!HARNESS) HARNESS = { cap: await import(path.join(ROOT, 'xpizza-functions/contract/capp/capture.mjs')), fh: await import(path.join(ROOT, 'form-harness.mjs')) };
  const dir = rid === 'x_pizza' ? 'xpizza-orders' : 'la-musa-orders';
  const { w } = await HARNESS.cap.boot(dir, ENV[rid]);
  try {
    await build(w, HARNESS.fh.settle);
    assert.strictEqual(w.buildOrder(), true, `premise: the live ${dir} page's buildOrder accepted the cart`);
    const b = w.eval('currentOrder');   // the page's own send body (buildOrder fills currentOrder)
    assert.ok(b && Array.isArray(b.items), `premise: the live ${dir} page built a body`);
    return JSON.parse(JSON.stringify({ items: b.items, items_text: b.items_text }));
  } finally { HARNESS.fh.closeAll(); }
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'capp-s1-seed' });
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  }
  await publishThirdBrand(fs, { mirror: makeRtdbMirror(rtdb) });
  for (const rid of ['x_pizza', 'la_musa', THIRD]) {
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
    await serve(rid);
  }
  await rtdb.ref('config/redemption_enabled').set(true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });

  // ── M. money: subtotal == quote food; quote net == stored total == captured; fee OFF and ON ──
  for (const fee of [false, true]) {
    await setPricing(fee);
    for (const rid of ['x_pizza', 'la_musa', THIRD]) {
      for (const [label, cart] of carts(rid)) {
        const sub = cart.subtotalCents(); const s = serialize(cart, MENU[rid]);
        assert.strictEqual(s.subtotal_cents, sub);
        await clean();
        const q = await quote(rid, s.items);
        assert.ok(q.json && q.json.ok, `${rid} ${label} fee=${fee}: the quote — ${q.text.slice(0, 200)}`);
        assert.strictEqual(q.json.total_cents, sub, `🔴 ${rid} ${label}: merchandise subtotal == quoteOrder.total_cents`);
        assert.strictEqual(q.json.net_total_cents, sub + (fee ? 3000 : 0), `${rid} ${label} fee=${fee}: net = food + envío`);
        await clean();
        const cb = bodyOf(rid, 'cash', cart, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
        const c = await post(app.createOrder, cb);
        assert.strictEqual(c.status, 200, `${rid} ${label} cash: ${c.text.slice(0, 200)}`);
        const co = await order(cb.order_id);
        assert.strictEqual(co.total_cents, q.json.net_total_cents, `🔴 ${rid} ${label}: quote net == the STORED cash order's total_cents`);
        assert.strictEqual(co.items_text, cb.items_text, 'the stored text is the client text');
        await clean(); CHARGED.length = 0;
        const kb = bodyOf(rid, 'online', cart, { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents });
        const k = await post(app.chargeOnlineOrder, kb);
        if (rid === THIRD) {
          // S3b: the hosted-checkout return base comes from the restaurant's OWN orders deployment in platform/sites.json — the
          // synthetic brand has none, so card is refused FAIL-CLOSED by design (pixelpay-return-url.js); nothing is charged
          assert.ok(k.status >= 400 && /return URL not configured/.test(k.text) && CHARGED.length === 0, `${rid} ${label} card: fail-closed without a deployment (${k.text.slice(0, 160)})`);
          continue;
        }
        assert.ok(k.status === 200 && k.json.checkout_url && CHARGED.length === 1, `${rid} ${label} card: ${k.text.slice(0, 200)}`);
        assert.strictEqual(Math.round(CHARGED[0] * 100), q.json.net_total_cents, `🔴 ${rid} ${label}: the captured PixelPay amount == the quote net`);
        assert.strictEqual((await order(kb.order_id)).total_cents, q.json.net_total_cents, `${rid} ${label}: the pending card order's total_cents == the net`);
      }
    }
  }
  ok('M money (x_pizza, la_musa, r3_synth; plain, ×3, toggles, two configurations, launcher choices): merchandise subtotal == quote total_cents; quote net == stored cash total_cents == captured PixelPay × 100; fee OFF and ON (envío L30); r3_synth card fail-closed (no orders deployment, S3b)');

  // ── R. rewards on N per-instance lines (fee ON) — exact money parity and exact reservation transitions ──
  const { REDEMPTION_CONFIG, REDEEM_POINTS_PER_LEMPIRA } = require('../rewards-redeem-config');
  const { REWARDS_CONFIG } = require('../rewards-core');
  // the reward's cost, independently from the redemption CONFIG + the served catalog price (never from the order under test)
  const expectedCost = (rid) => (REDEMPTION_CONFIG[rid].kind === 'punch' ? REDEMPTION_CONFIG[rid].cost
    : REWARD[rid].items.reduce((s, it) => s + Math.round(Number((ENV[rid].menu.extras.find((e) => String(e.id) === it.id) || ENV[rid].menu.dishes.find((d) => String(d.id) === it.id)).price) * REDEEM_POINTS_PER_LEMPIRA) * it.qty, 0));
  // the earn, independently from the earn CONFIG + the cart (punch: instances; points: floor(food / perCents) × pointsPer)
  const expectedEarn = (rid, cart) => { const c = REWARDS_CONFIG[rid]; return c.kind === 'punch' ? cart.count() : Math.floor(cart.subtotalCents() / c.perCents) * c.pointsPer; };
  const wallet = async (rid) => (await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val() || {};
  const resv = async (rid, id) => ((await wallet(rid)).reservations || {})[id] || null;
  for (const rid of ['x_pizza', 'la_musa']) {
    const m = MENU[rid]; const auth = { 'x-firebase-id-token': UID }; const cost = expectedCost(rid);
    const d = configurable(m) || orderableDish(m); const ex = m.extrasFor(d.key);
    const cart = createCart(m); cart.add(d.key, ex.length ? [ex[0].key] : [], 2); cart.inc(d.key);
    const s = serialize(cart, m); const paid = cart.subtotalCents(); const net = paid + 3000;
    assert.ok(cost > 0 && BALANCE[rid] >= cost, `premise: the balance covers the reward (${cost})`);
    await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
    await clean();
    const qr = await post(app.quoteRedemption, { restaurant_id: rid, items: s.items, redeem: REWARD[rid], mode: 'delivery', pin: { ...PIN, confirmed: true } }, auth);
    assert.ok(qr.json && qr.json.ok && typeof qr.json.quote_token === 'string' && qr.json.quote_token, `${rid}: quoteRedemption issues a SIGNED quote — ${qr.text.slice(0, 220)}`);
    assert.deepStrictEqual([qr.json.total_cents, qr.json.net_total_cents, qr.json.total_cost], [paid, net, cost], `🔴 ${rid}: the reward quote: food == the PAID subtotal (free item excluded), net == food + envío, cost == the config`);
    // cash: exact total; the reservation RESERVED for exactly the cost; balance untouched
    await clean();
    const cb = bodyOf(rid, 'cash', cart, { redeem: REWARD[rid], quote_token: qr.json.quote_token, expected_net_cents: qr.json.net_total_cents });
    const c = await post(app.createOrder, cb, auth);
    assert.strictEqual(c.status, 200, `${rid} reward cash: ${c.text.slice(0, 220)}`);
    const co = await order(cb.order_id);
    assert.ok(co.redemption && co.items_text.startsWith(s.items_text) && /^ \| \d+x .+ \(Recompensa\)$/.test(co.items_text.slice(s.items_text.length)), `${rid}: bound, the free line is exactly one server suffix on the client text`);
    assert.strictEqual(co.total_cents, net, `🔴 ${rid}: the stored cash total == the quoted net EXACTLY (free item uncharged, no undercharge)`);
    let r = await resv(rid, cb.order_id); let wl = await wallet(rid);
    assert.deepStrictEqual([r && r.state, r && r.cost, wl.balance, wl.reserved], ['reserved', cost, BALANCE[rid], cost], `🔴 ${rid} cash: reservation reserved for exactly the cost; balance untouched`);
    // card: bound; exact captured amount; the ISSUED body resumes the SAME checkout (same reservation, no second hold); confirm
    // consumes exactly the cost; then a second reward checkout, cancelled → released exactly
    await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
    await clean(); CHARGED.length = 0;
    const qk = await post(app.quoteRedemption, { restaurant_id: rid, items: s.items, redeem: REWARD[rid], mode: 'delivery', pin: { ...PIN, confirmed: true } }, auth);
    const kb = bodyOf(rid, 'online', cart, { redeem: REWARD[rid], quote_token: qk.json.quote_token, expected_net_cents: qk.json.net_total_cents });
    const issued = issuedSnapshot(kb);
    const k = await post(app.chargeOnlineOrder, kb, auth);
    assert.ok(k.status === 200 && k.json.checkout_url && CHARGED.length === 1, `${rid} reward card: ${k.text.slice(0, 220)}`);
    assert.strictEqual(Math.round(CHARGED[0] * 100), net, `🔴 ${rid} reward card: the captured amount == the quoted net EXACTLY`);
    const ko = await order(kb.order_id);
    assert.ok(ko.redemption && ko.payment_fingerprint && ko.charge_inputs_fp, `${rid}: the card order is bound (redemption + payment and charge-input fingerprints)`);
    assert.strictEqual(ko.total_cents, net);
    r = await resv(rid, kb.order_id); wl = await wallet(rid);
    assert.deepStrictEqual([r && r.state, r && r.cost, r && r.order_fingerprint, wl.balance, wl.reserved], ['reserved', cost, ko.payment_fingerprint, BALANCE[rid], cost], `🔴 ${rid} card: reserved for exactly the cost, bound to the order's payment fingerprint`);
    await clean(); CHARGED.length = 0;
    const again = await post(app.chargeOnlineOrder, resendBody(issued), auth);
    assert.deepStrictEqual([again.status, again.json && again.json.checkout_url], [200, k.json.checkout_url], `🔴 ${rid}: the ISSUED body resumes the SAME checkout (${again.text.slice(0, 160)})`);
    wl = await wallet(rid);
    assert.deepStrictEqual([wl.balance, wl.reserved, (await resv(rid, kb.order_id)).state], [BALANCE[rid], cost, 'reserved'], `${rid}: no second hold on resume`);
    const conf = await confirmAndMaterialize(edgeDeps(rid), { orderId: kb.order_id, attemptId: ko.active_attempt_id, now: Date.now(), trackingToken: `TTR${rid}` });
    assert.strictEqual((await order(kb.order_id)).payment_status, 'confirmed', `${rid}: confirmed (${JSON.stringify(conf).slice(0, 160)})`);
    r = await resv(rid, kb.order_id); wl = await wallet(rid);
    assert.deepStrictEqual([r.state, r.debit_applied, wl.balance, wl.reserved], ['consumed', cost, BALANCE[rid] - cost, 0], `🔴 ${rid}: the confirm CONSUMES exactly the cost and leaves nothing reserved`);
    await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
    await clean();
    const qc = await post(app.quoteRedemption, { restaurant_id: rid, items: s.items, redeem: REWARD[rid], mode: 'delivery', pin: { ...PIN, confirmed: true } }, auth);
    const rb = bodyOf(rid, 'online', cart, { redeem: REWARD[rid], quote_token: qc.json.quote_token, expected_net_cents: qc.json.net_total_cents });
    assert.strictEqual((await post(app.chargeOnlineOrder, rb, auth)).status, 200);
    assert.deepStrictEqual([(await resv(rid, rb.order_id)).state, (await wallet(rid)).reserved], ['reserved', cost], 'premise: held');
    const cr = await cancelOrderCore(edgeDeps(rid), { orderId: rb.order_id, actor: 'test', reason: 'capp-s1', now: Date.now(), claimId: `cancel-${rb.order_id}` });
    r = await resv(rid, rb.order_id); wl = await wallet(rid);
    assert.deepStrictEqual([r.state, wl.balance, wl.reserved || 0], ['released', BALANCE[rid], 0], `🔴 ${rid}: the cancel RELEASES exactly — balance untouched, nothing reserved (${JSON.stringify(cr).slice(0, 120)})`);
    // earn parity: populated, == the config-derived expectation, == the old live form's for the same paid cart
    const ob = await oldBody(rid, async (w, settle) => {
      w.chg(d.id, 3); await settle();
      if (ex.length) {
        w.openDetailModal(d.id); await settle();
        if (rid === 'x_pizza') { w.toggleDetailExtra(String(ex[0].id), d.id, 0); w.toggleDetailExtra(String(ex[0].id), d.id, 1); } else w.chgDetailExtra(String(ex[0].id), d.id, 2);
        await settle(); w.closeDetailModal(); await settle();
      }
    });
    await clean();
    const newE = bodyOf(rid, 'cash', cart); const oldE = { ...bodyOf(rid, 'cash', cart), items: ob.items, items_text: ob.items_text };
    const [ne, oe] = [await post(app.createOrder, newE, auth), await post(app.createOrder, oldE, auth)];
    assert.ok(ne.status === 200 && oe.status === 200, `earn setup: ${ne.text.slice(0, 120)} / ${oe.text.slice(0, 120)}`);
    const [no, oo] = [await order(newE.order_id), await order(oldE.order_id)];
    assert.strictEqual(no.total_cents, oo.total_cents, `🔴 ${rid}: the old form and the new renderer charge the same cart the same`);
    assert.ok(no.earn_preview && Number.isInteger(no.earn_preview.delta), `premise: the new order's earn_preview is populated (${JSON.stringify(no.earn_preview)})`);
    assert.strictEqual(no.earn_preview.delta, expectedEarn(rid, cart), `🔴 ${rid}: the earn == the config-derived expectation`);
    assert.ok(no.earn_preview.delta > 0, 'premise: a non-zero earn');
    assert.deepStrictEqual(no.earn_preview, oo.earn_preview, `🔴 ${rid}: the earn == the old form's for the same cart`);
  }
  ok('R rewards (x_pizza punch, la_musa points; N per-instance paid lines; envío ON): a SIGNED reward quote with food == the paid subtotal, net == food + envío, cost == the config; cash and card charged the net EXACTLY; the reservation reserved for exactly the cost (bound to the payment fingerprint), the ISSUED body resumes the SAME checkout with no second hold, confirm consumes exactly the cost, cancel releases exactly; earn populated == the config-derived value == the old live form\'s');

  // ── D + X. dedup and the cross-grammar residual (stamps NOT cleared within a scenario) ──
  await setPricing(false);
  const phoneTokens = async (ph) => { const v = (await rtdb.ref('rate_limits').get()).val() || {}; return JSON.stringify(v).split(rateLimitKey(ph)).length - 1 ? JSON.stringify(Object.values(v).map((b) => b && b[rateLimitKey(ph)]).filter(Boolean)) : '[]'; };
  for (const rid of ['x_pizza', 'la_musa']) {
    const m = MENU[rid]; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key); const p = plainDish(m, d.key);
    // D: the same new cart twice → retap (phone token not re-burned); reordered → the same key; a changed configuration → new key
    await clean();
    const ph = phone();
    const c1 = createCart(m); c1.add(d.key, [e1.key], 1); c1.inc(p.key);
    const b1 = { ...bodyOf(rid, 'cash', c1), customer_phone: ph };
    assert.strictEqual((await post(app.createOrder, b1)).status, 200);
    const t1 = await phoneTokens(ph);
    const c2 = createCart(m); c2.inc(p.key); c2.add(d.key, [e1.key], 1);   // the same cart, configurations added in another order
    const b2 = { ...bodyOf(rid, 'cash', c2), customer_phone: ph };
    assert.strictEqual((await post(app.createOrder, b2)).status, 200);
    assert.strictEqual(await phoneTokens(ph), t1, `🔴 ${rid}: a retap of the same cart (reordered) does not re-burn the phone token`);
    const c3 = createCart(m); c3.add(d.key, [e2.key], 1); c3.inc(p.key);   // a genuinely changed configuration
    const b3 = { ...bodyOf(rid, 'cash', c3), customer_phone: ph };
    assert.strictEqual((await post(app.createOrder, b3)).status, 200);
    assert.notStrictEqual(await phoneTokens(ph), t1, `${rid}: a changed configuration is a new order (its token is burned)`);
  }
  ok('D dedup (stamps kept): the same cart again — configurations in another order — is a retap (the phone token not re-burned); a changed configuration is a new order');

  // X: the residual, exactly as stated. The F3 hold covers the ordering it was built for — the CARD checkout issued first, the
  // CASH order placed after it (the cash stamp is the last write), the card confirmed late. When the cash order comes FIRST,
  // the card's issuance stamps the same key over it (index.js:1813), so no grammar is held: PRE-EXISTING F3 scope (not S1;
  // logged in the payments/dedup backlog by the advisor) — documented by its own cell below.
  async function scenario(rid, { plain, cardText, cashText, sequence }) {
    const m = MENU[rid]; const d = configurable(m); const [e1] = m.extrasFor(d.key); const p = plainDish(m, d.key);
    const cart = createCart(m);
    if (plain) cart.add(p.key, [], 2); else { cart.add(d.key, [e1.key], 1); cart.inc(d.key); }
    const ob = await oldBody(rid, async (w, settle) => {
      if (plain) { w.chg(p.id, 2); await settle(); return; }
      w.chg(d.id, 2); await settle(); w.openDetailModal(d.id); await settle();
      if (rid === 'x_pizza') w.toggleDetailExtra(String(e1.id), d.id, 0); else w.chgDetailExtra(String(e1.id), d.id, 1);
      await settle(); w.closeDetailModal(); await settle();
    });
    const nb = serialize(cart, m);
    const texts = { old: { items: ob.items, items_text: ob.items_text }, new: { items: nb.items, items_text: nb.items_text } };
    await clean(); await rtdb.ref('dispatcher_alerts').remove();
    const ph = phone();
    const card = { ...bodyOf(rid, 'online', cart), customer_phone: ph, ...texts[cardText] };
    const cash = { ...bodyOf(rid, 'cash', cart), customer_phone: ph, ...texts[cashText] };
    const steps = sequence === 'card-first' ? [[app.chargeOnlineOrder, card], [app.createOrder, cash]] : [[app.createOrder, cash], [app.chargeOnlineOrder, card]];
    for (const [h, b] of steps) { const r = await post(h, b); assert.strictEqual(r.status, 200, `setup ${b.order_id}: ${r.text.slice(0, 140)}`); }
    // the card confirms 180 s after the stamps (beyond the 2-minute window), the cash sibling still live
    const stamps = (await rtdb.ref(`recent_order_content/${rateLimitKey(ph)}`).get()).val() || {};
    for (const [k, v] of Object.entries(stamps)) if (v && v.at) await rtdb.ref(`recent_order_content/${rateLimitKey(ph)}/${k}/at`).set(v.at - 180000);
    const co = await order(card.order_id);
    const tok = `TTX${card.order_id}`;
    const conf = await confirmAndMaterialize(edgeDeps(rid), { orderId: card.order_id, attemptId: co.active_attempt_id, now: Date.now(), trackingToken: tok });
    const after = await order(card.order_id);
    const cardAlert = (await rtdb.ref(`dispatcher_alerts/duplicate_order_${card.order_id}`).get()).val();     // the materialization guard's
    const createAlert = (await rtdb.ref(`dispatcher_alerts/duplicate_order_${cash.order_id}`).get()).val();   // the cash intake's
    const delivered = (await rtdb.ref(`tasks/${card.order_id}_delivery`).get()).exists();
    const tracked = (await rtdb.ref(`order_tracking/${tok}`).get()).exists();
    return { conf, after, cardAlert, createAlert, delivered, tracked, cashId: cash.order_id, sameText: ob.items_text === nb.items_text };
  }
  // the TWO observable outcomes, asserted whole: HELD (no materialization, the hold reason + sibling, the guard's card alert) or
  // MATERIALIZED (confirmed, its delivery task + tracking written, no guard alert) — a failed / pending confirm matches neither
  function assertHeld(r, label) {
    assert.strictEqual(r.conf && r.conf.outcome, 'held_duplicate_sibling', `🔴 ${label}: the confirm outcome (${JSON.stringify(r.conf)})`);
    assert.deepStrictEqual([r.after.payment_status, r.after.blocked_reason, r.after.sibling_order_id, !!r.after.materialized_at], ['manual_reconciliation', 'duplicate_of_sibling', r.cashId, false], `🔴 ${label}: held for the dispatcher against the cash sibling`);
    assert.deepStrictEqual([r.delivered, r.tracked], [false, false], `🔴 ${label}: nothing materialized (no delivery task, no tracking)`);
    assert.deepStrictEqual(r.cardAlert && [r.cardAlert.kind, r.cardAlert.sibling_order_id], ['duplicate_of_sibling', r.cashId], `🔴 ${label}: the guard's card-order alert`);
  }
  function assertMaterialized(r, label) {
    assert.strictEqual(r.conf && r.conf.outcome, 'confirmed', `${label}: the confirm outcome (${JSON.stringify(r.conf)})`);
    assert.deepStrictEqual([r.after.payment_status, r.after.blocked_reason || null, r.delivered, r.tracked], ['confirmed', null, true, true], `${label}: confirmed AND materialized (delivery task + tracking)`);
    assert.strictEqual(r.cardAlert, null, `${label}: no guard alert`);
  }
  const createAlerted = (r) => !!(r.createAlert && r.createAlert.kind === 'duplicate_of_sibling_create' && r.createAlert.order_id === r.cashId);
  for (const rid of ['x_pizza', 'la_musa']) {
    // the F3-covered ordering (card issued → cash → card confirmed late), across grammars, BOTH directions
    for (const [cardText, cashText] of [['new', 'old'], ['old', 'new']]) {
      const pl = await scenario(rid, { plain: true, cardText, cashText, sequence: 'card-first' });
      assert.ok(pl.sameText, `premise: a plain cart has the same text in both grammars (${rid})`);
      assertHeld(pl, `${rid} plain, ${cardText} card → ${cashText} cash → late confirm`);
      assert.ok(createAlerted(pl), `🔴 ${rid} plain: the cash intake's create-side alert`);
      const cf = await scenario(rid, { plain: false, cardText, cashText, sequence: 'card-first' });
      assert.strictEqual(cf.sameText, false, `premise: a configured cart differs across grammars (${rid})`);
      assertMaterialized(cf, `${rid} configured, ${cardText} card → ${cashText} cash (the stated cutover-window residual)`);
      assert.strictEqual(createAlerted(cf), false, `${rid} configured: no create-side alert (the residual)`);
    }
    const nn = await scenario(rid, { plain: false, cardText: 'new', cashText: 'new', sequence: 'card-first' });
    assertHeld(nn, `${rid} new ↔ new configured`);
    assert.ok(createAlerted(nn), `🔴 ${rid} new ↔ new: the create-side alert`);
    // PRE-EXISTING F3 scope (not S1): cash FIRST → card issued → confirm is not held for ANY grammar (the card's stamp
    // overwrites the cash sibling's) — old↔old and new↔new alike
    for (const g of ['old', 'new']) {
      const cf = await scenario(rid, { plain: false, cardText: g, cashText: g, sequence: 'cash-first' });
      assertMaterialized(cf, `${rid} ${g}↔${g}, cash first (PRE-EXISTING F3 scope, the same for every grammar)`);
    }
  }
  ok('X the cross-grammar residual exactly as stated (both restaurants; card issued → cash → card confirmed 180 s after the stamp): plain carts → identical text → HELD and alerted across grammars, both directions; configured carts → NOT held and NOT alerted, both directions; new↔new configured → HELD and alerted. PRE-EXISTING F3 scope documented: cash first → card → confirm is not held for any grammar (old↔old, new↔new)');

  // ── L + P. one republish: a long dish name for the 1,500 boundary, one dish re-priced UP, one DOWN ──
  {
    const rid = 'la_musa';   // id-keyed: a display name is not a pricing key, so it can be lengthened
    const m0 = MENU[rid];
    const [up, down, long] = m0.dishes.filter((x) => !x.launcher && !x.variantOf).slice(0, 3);
    const cartUp = createCart(m0); cartUp.inc(up.key);
    const cartDown = createCart(m0); cartDown.inc(down.key);
    const sUp = serialize(cartUp, m0); const sDown = serialize(cartDown, m0);
    await setPricing(true);
    await clean();
    const [qUp, qDown] = [await quote(rid, sUp.items), await quote(rid, sDown.items)];
    const src = buildSourceFromCode(rid);
    const it = (k) => src.items.find((i) => String(i.key) === String(m0.dish(k).id));
    it(up.key).price += 10; it(up.key).display = { ...it(up.key).display, price: it(up.key).price };
    it(down.key).price -= 10; it(down.key).display = { ...it(down.key).display, price: it(down.key).price };
    const base = `1x ${long.name} (L${long.price})`;
    it(long.key).display = { ...it(long.key).display, name: 'N'.repeat(ITEMS_TEXT_LIMIT - base.length + long.name.length) };
    const active = await getActivePointer(fs, rid);
    await publishVersion(fs, rid, { ...candidateFromSource(rid, src), source_sha: 'capp-s1-v2' }, { expected: { activeVersionId: active.version }, mirror: makeRtdbMirror(rtdb) });
    await wait(46000);   // the per-instance catalog pointer cache (45 s)
    // P: v1 display vs a v2 quote is detectable; up → refused before any write; down → the lower net is charged
    await clean();
    const q2 = await quote(rid, sUp.items);
    assert.notStrictEqual(q2.json.total_cents, cartUp.subtotalCents(), 'a v1 display against a v2 quote differs (the renderer re-renders from v2 before submit)');
    await clean();
    const ub = bodyOf(rid, 'cash', cartUp, { quote_token: qUp.json.quote_token, expected_net_cents: qUp.json.net_total_cents });
    const ur = await post(app.createOrder, ub);
    assert.deepStrictEqual([ur.status, ur.json && ur.json.error, await order(ub.order_id)], [409, 'price_increased', null], `🔴 a price increase after the quote is refused, nothing written (${ur.text.slice(0, 160)})`);
    await clean(); CHARGED.length = 0;
    const ukb = bodyOf(rid, 'online', cartUp, { quote_token: qUp.json.quote_token, expected_net_cents: qUp.json.net_total_cents });
    const uk = await post(app.chargeOnlineOrder, ukb);
    assert.deepStrictEqual([uk.status, uk.json && uk.json.error, CHARGED.length], [409, 'price_increased', 0], `🔴 card: refused before any checkout (${uk.text.slice(0, 160)})`);
    await clean();
    const q3 = await quote(rid, sUp.items);
    const rb = bodyOf(rid, 'cash', cartUp, { quote_token: q3.json.quote_token, expected_net_cents: q3.json.net_total_cents });
    assert.strictEqual((await post(app.createOrder, rb)).status, 200, 'a re-quote succeeds');
    await clean();
    const db2 = bodyOf(rid, 'cash', cartDown, { quote_token: qDown.json.quote_token, expected_net_cents: qDown.json.net_total_cents });
    assert.strictEqual((await post(app.createOrder, db2)).status, 200);
    assert.strictEqual((await order(db2.order_id)).total_cents, qDown.json.net_total_cents - 1000, 'a price DROP is charged the lower net (the gate\'s stated asymmetry)');
    // L: the 1,500 boundary on the v2 catalog
    await serve(rid);
    const m = MENU[rid]; const lc = createCart(m); lc.inc(long.key);
    const ls = serialize(lc, m);
    assert.strictEqual(ls.items_text.length, ITEMS_TEXT_LIMIT, 'premise: exactly 1,500');
    for (const method of ['cash', 'online']) {
      await clean();
      const b = bodyOf(rid, method, lc);
      const r = await post(method === 'cash' ? app.createOrder : app.chargeOnlineOrder, b);
      assert.strictEqual(r.status, 200, `L ${method}: ${r.text.slice(0, 160)}`);
      assert.strictEqual((await order(b.order_id)).items_text, ls.items_text, `🔴 L ${method}, no reward: the stored text == the client text (no truncation)`);
      await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
      await clean();
      const rb2 = bodyOf(rid, method, lc, { redeem: REWARD[rid] });
      const rr = await post(method === 'cash' ? app.createOrder : app.chargeOnlineOrder, rb2, { 'x-firebase-id-token': UID });
      assert.strictEqual(rr.status, 200, `L ${method} reward: ${rr.text.slice(0, 160)}`);
      const st = (await order(rb2.order_id)).items_text;
      const suffix = st.slice(ls.items_text.length);
      assert.ok(st.startsWith(ls.items_text) && /^ \| \d+x .+ \(Recompensa\)$/.test(suffix) && suffix.split(' | ').length === 2, `🔴 L ${method}, reward: client text + EXACTLY one complete suffix (${JSON.stringify(suffix)})`);
      assert.ok(st.length > ITEMS_TEXT_LIMIT, 'with the suffix the stored text exceeds 1,500 — expected (appended after the cap)');
    }
    await setPricing(false);
  }
  ok('P price change after the quote (la_musa, real republish): up → 409 price_increased on cash (nothing written) and card (no checkout), a re-quote succeeds; down → charged the lower net; L the 1,500 boundary: no reward → stored == client text (cash, card); reward → client text + exactly one complete suffix (cash, card)');

  // ── F. factura: N-line x_pizza orders — every line amount checked against the CART, the comped line against the reward, the
  // tax split and the rebaja against values derived independently from the food totals (zeroed line amounts cannot pass)
  await setPricing(true);
  {
    const { orderBreakdownCents } = require('../order-money');
    const rid = 'x_pizza'; const m = MENU[rid]; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key);
    const cart = createCart(m); cart.add(d.key, [e1.key], 2); cart.add(d.key, [e1.key, e2.key], 1); cart.inc(d.key);
    const s = serialize(cart, m);
    const expectLines = s.items.map((it) => ({ qty: 1, line_gross_cents: it.subtotal * 100 }));   // per instance: price + its extras
    const paidL = cart.subtotalCents() / 100;
    const freeDish = ENV[rid].menu.dishes.find((x) => x.name === REWARD[rid].item_id);
    for (const reward of [false, true]) {
      await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
      await clean();
      const b = bodyOf(rid, 'cash', cart, reward ? { redeem: REWARD[rid] } : {});
      const r = await post(app.createOrder, b, { 'x-firebase-id-token': UID });
      assert.strictEqual(r.status, 200, `F reward=${reward}: ${r.text.slice(0, 160)}`);
      const o = await order(b.order_id);
      // paid lines (order.items): one per instance, each exactly price + its extras, in the cart's order
      assert.deepStrictEqual(o.items.map((l) => ({ qty: l.qty, line_gross_cents: l.line_gross_cents })), expectLines, `🔴 F reward=${reward}: every paid line's gross == the cart instance`);
      const lines = o.factura_items || o.items;
      if (reward) {
        assert.strictEqual(lines.length, expectLines.length + 1, 'factura_items = the paid lines + the comped line');
        const comp = lines[lines.length - 1];
        assert.deepStrictEqual([comp.redeemed, comp.qty, comp.line_gross_cents], [true, 1, freeDish.price * 100], `🔴 F: the comped line == the reward dish at its catalog value`);
      } else assert.strictEqual(o.factura_items, undefined, 'no reward → no factura_items');
      // the expected split, derived independently from the food totals (tax-inclusive ISV): paid, and paid + comped
      const paidB = orderBreakdownCents(paidL, rid);
      const fullB = orderBreakdownCents(paidL + (reward ? freeDish.price : 0), rid);
      const rec = buildFacturaRecord({ order: { ...o, orderId: b.order_id, razon_social: o.razon_social || '', rtn_cliente: o.rtn_cliente || '' }, config: FACTURA_CONFIG, reserved: 1, now: 1760000000000 });
      assert.deepStrictEqual([rec.subtotal_cents, rec.isv_total_cents, rec.total_cents], [paidB.subtotal_cents, paidB.tax_cents, paidB.total_cents], `🔴 F reward=${reward}: base / ISV / total == the independently derived split of the FOOD total`);
      assert.strictEqual(rec.total_cents, cart.subtotalCents(), 'the factura total == the food (envío excluded)');
      assert.strictEqual(rec.desc_rebaja_cents, reward ? fullB.subtotal_cents - paidB.subtotal_cents : 0, `🔴 F reward=${reward}: the rebaja == the independently derived comped NET value`);
      assert.strictEqual(rec.items.length, lines.length);
      assert.strictEqual(rec.items.reduce((a, l) => a + l.base_cents, 0), rec.subtotal_cents + rec.desc_rebaja_cents, 'line bases foot to the full net');
      rec.items.forEach((l, i) => assert.ok(Math.abs(l.base_cents - Math.round(lines[i].line_gross_cents / 1.15)) <= (i === rec.items.length - 1 ? lines.length : 0), `F line ${i}: base ≈ gross / 1.15 (the residual only on the last line)`));
    }
  }
  await setPricing(false);
  ok('F factura (x_pizza, envío ON): every paid line == its cart instance, the comped line == the reward dish at catalog value; base / ISV / total == the independently derived split of the FOOD total; rebaja == the derived comped net; line bases ≈ gross / 1.15 with the residual on the last line — with and without a reward');

  // ── C. identity claims: every serialized dish_id / extra_id is PRESENT and equals the AUTHORITATIVE identity registry's id for
  // the line's pricing key (catalog/identity-registry lookupByLegacyKeys — never the adapter under test); the canonical branch
  // (the real canonicalCartNorm) verifies the N-line bodies against a context built from that registry
  {
    const CB = require('../catalog/canonical-binding');
    const { lookupByLegacyKeys } = require('../catalog/identity-registry');
    for (const rid of ['x_pizza', 'la_musa']) {
      const mode = (await fs.collection('restaurants').doc(rid).get()).data().pricing_key_mode;   // DATA: which legacy field prices
      assert.ok(mode === 'name' || mode === 'id', `premise: ${rid} pricing_key_mode is data (${mode})`);
      const keyOf = (rec) => String(mode === 'id' ? rec.id : rec.name);
      const src = buildSourceFromCode(rid);
      const dishIds = await lookupByLegacyKeys(fs, { rid, kind: 'dish', legacyKeys: src.items.map((i) => String(i.key)) });
      const extraIds = await lookupByLegacyKeys(fs, { rid, kind: 'extra', legacyKeys: src.extras.map((e) => String(e.key)) });
      assert.ok(dishIds.size === src.items.length && extraIds.size === src.extras.length, `premise: the registry identifies every catalog dish and extra (${dishIds.size}/${src.items.length}, ${extraIds.size}/${src.extras.length})`);
      const ctx = { usableAsIdentity: true, objects: [
        ...src.items.map((i) => ({ kind: 'dish', legacyKey: i.key, canonicalId: dishIds.get(String(i.key)), label: i.display.name })),
        ...src.extras.map((e) => ({ kind: 'extra', legacyKey: e.key, canonicalId: extraIds.get(String(e.key)), label: e.display.name }))] };
      for (const [label, cart] of carts(rid)) {
        const items = serialize(cart, MENU[rid]).items;
        for (const it of items) {
          assert.strictEqual(it.dish_id, dishIds.get(keyOf(it)), `🔴 ${rid} ${label}: the dish_id claim of «${it.name}» is PRESENT and == the registry's`);
          for (const ex of it.extras) assert.strictEqual(ex.extra_id, extraIds.get(keyOf(ex)), `🔴 ${rid} ${label}: the extra_id claim of «${ex.name}» is PRESENT and == the registry's`);
        }
        const r = CB.canonicalCartNorm(items, rid, ctx);
        assert.ok(r && r.ok !== false, `🔴 ${rid} ${label}: the canonical branch verifies the N-line bodies (${JSON.stringify(r).slice(0, 200)})`);
      }
    }
  }
  ok('C identity: every serialized dish_id / extra_id claim is PRESENT and == the AUTHORITATIVE registry id for the line\'s pricing key (by pricing_key_mode data); the real canonicalCartNorm verifies every cart\'s N lines against a registry-built context, both restaurants');

  FINISHED = true;
  console.log(`\ncapp-s1-money(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
