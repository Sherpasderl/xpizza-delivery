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

  // ── R. rewards on N per-instance lines (fee ON) ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const m = MENU[rid]; const auth = { 'x-firebase-id-token': UID };
    const d = configurable(m) || orderableDish(m); const ex = m.extrasFor(d.key);
    const cart = createCart(m); cart.add(d.key, ex.length ? [ex[0].key] : [], 2); cart.inc(d.key);
    const s = serialize(cart, m);
    await clean();
    const qr = await post(app.quoteRedemption, { restaurant_id: rid, items: s.items, redeem: REWARD[rid], mode: 'delivery', pin: { ...PIN, confirmed: true } }, auth);
    assert.ok(qr.json && qr.json.ok, `${rid}: quoteRedemption on N instance lines — ${qr.text.slice(0, 220)}`);
    // cash: the reward is applied; the free item is outside the paid total; the hold is consumed
    const before = (await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val();
    await clean();
    const cb = bodyOf(rid, 'cash', cart, { redeem: REWARD[rid], ...(qr.json.quote_token ? { quote_token: qr.json.quote_token, expected_net_cents: qr.json.net_total_cents } : {}) });
    const c = await post(app.createOrder, cb, auth);
    assert.strictEqual(c.status, 200, `${rid} reward cash: ${c.text.slice(0, 220)}`);
    const co = await order(cb.order_id);
    assert.ok(co.redemption, `${rid}: the cash order is bound to its reward`);
    assert.ok(/\(Recompensa\)$/.test(co.items_text) && co.items_text.startsWith(s.items_text), `${rid}: the free line is the server's suffix on the client text`);
    assert.ok(co.total_cents <= s.subtotal_cents + 3000, `${rid}: the free item is never charged (total ${co.total_cents} ≤ paid subtotal + envío)`);
    const after = (await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val();
    assert.ok((Number(after.reserved) || 0) > (Number(before.reserved) || 0) || (Number(after.balance) < Number(before.balance)), `${rid}: the reward is held or consumed by the cash order`);
    // card: bound; the ISSUED body resumes the SAME checkout (bound reuse); confirm consumes
    await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
    await clean(); CHARGED.length = 0;
    const kb = bodyOf(rid, 'online', cart, { redeem: REWARD[rid] });
    const issued = issuedSnapshot(kb);
    const k = await post(app.chargeOnlineOrder, kb, auth);
    assert.ok(k.status === 200 && k.json.checkout_url, `${rid} reward card: ${k.text.slice(0, 220)}`);
    const ko = await order(kb.order_id);
    assert.ok(ko.redemption && ko.payment_fingerprint, `${rid}: the card order is bound (redemption + payment fingerprint)`);
    const heldAfterIssue = (await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val().reserved;
    await clean();
    const again = await post(app.chargeOnlineOrder, resendBody(issued), auth);
    assert.deepStrictEqual([again.status, again.json && again.json.checkout_url], [200, k.json.checkout_url], `🔴 ${rid}: the ISSUED body resumes the SAME checkout (${again.text.slice(0, 160)})`);
    assert.strictEqual((await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val().reserved, heldAfterIssue, `${rid}: no second hold`);
    const conf = await confirmAndMaterialize(edgeDeps(rid), { orderId: kb.order_id, attemptId: ko.active_attempt_id, now: Date.now(), trackingToken: `TTR${rid}` });
    const kc = await order(kb.order_id);
    assert.strictEqual(kc.payment_status, 'confirmed', `${rid}: confirmed (${JSON.stringify(conf).slice(0, 160)})`);
    const consumed = (await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val();
    assert.ok(Number(consumed.balance) < BALANCE[rid], `${rid}: the confirm CONSUMES the reward (balance ${consumed.balance})`);
    // release: a second reward checkout, cancelled → the hold is released
    await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
    await clean();
    const rb = bodyOf(rid, 'online', cart, { redeem: REWARD[rid] });
    const r = await post(app.chargeOnlineOrder, rb, auth);
    assert.ok(r.status === 200, `${rid} release setup: ${r.text.slice(0, 160)}`);
    assert.ok((await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val().reserved > 0, 'premise: held');
    const cr = await cancelOrderCore(edgeDeps(rid), { orderId: rb.order_id, actor: 'test', reason: 'capp-s1', now: Date.now(), claimId: `cancel-${rb.order_id}` });
    assert.strictEqual((await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val().reserved || 0, 0, `${rid}: the cancel RELEASES the hold (${JSON.stringify(cr).slice(0, 160)})`);
    // earn parity with the OLD form's body for the same paid cart (a signed-in customer, no reward)
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
    assert.deepStrictEqual(no.earn_preview, oo.earn_preview, `🔴 ${rid}: earn == the old form's for the same cart`);
  }
  ok('R rewards (x_pizza punch, la_musa points; N per-instance paid lines; envío ON): quoteRedemption ok; cash bound, the free line the server suffix, never charged, held/consumed; card bound, the ISSUED body resumes the SAME checkout with no second hold, confirm consumes, cancel releases; total and earn == the old live form\'s for the same cart');

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
    await confirmAndMaterialize(edgeDeps(rid), { orderId: card.order_id, attemptId: co.active_attempt_id, now: Date.now(), trackingToken: `TTX${card.order_id}` });
    return { held: (await order(card.order_id)).payment_status === 'manual_reconciliation',
      alerted: !!(await rtdb.ref(`dispatcher_alerts/duplicate_order_${cash.order_id}`).get()).val(), sameText: ob.items_text === nb.items_text };
  }
  for (const rid of ['x_pizza', 'la_musa']) {
    // the F3-covered ordering (card issued → cash → card confirmed late), across grammars, BOTH directions
    for (const [cardText, cashText] of [['new', 'old'], ['old', 'new']]) {
      const pl = await scenario(rid, { plain: true, cardText, cashText, sequence: 'card-first' });
      assert.ok(pl.sameText, `premise: a plain cart has the same text in both grammars (${rid})`);
      assert.deepStrictEqual([pl.held, pl.alerted], [true, true], `🔴 ${rid} plain, ${cardText} card → ${cashText} cash → late confirm: HELD and alerted (identical text)`);
      const cf = await scenario(rid, { plain: false, cardText, cashText, sequence: 'card-first' });
      assert.strictEqual(cf.sameText, false, `premise: a configured cart differs across grammars (${rid})`);
      assert.deepStrictEqual([cf.held, cf.alerted], [false, false], `${rid} configured, ${cardText} card → ${cashText} cash: NOT held and NOT alerted — the stated cutover-window residual`);
    }
    const nn = await scenario(rid, { plain: false, cardText: 'new', cashText: 'new', sequence: 'card-first' });
    assert.deepStrictEqual([nn.held, nn.alerted], [true, true], `🔴 ${rid} new ↔ new configured: HELD and alerted`);
    // PRE-EXISTING F3 scope (not S1): cash FIRST → card issued → confirm is not held for ANY grammar (the card's stamp
    // overwrites the cash sibling's) — old↔old and new↔new alike
    for (const g of ['old', 'new']) {
      const cf = await scenario(rid, { plain: false, cardText: g, cashText: g, sequence: 'cash-first' });
      assert.strictEqual(cf.held, false, `${rid} ${g}↔${g}, cash first: not held — PRE-EXISTING F3 scope, the same for every grammar`);
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

  // ── F. factura: N-line x_pizza orders reconcile to the FOOD total, fee ON, with and without a reward ──
  await setPricing(true);
  {
    const rid = 'x_pizza'; const m = MENU[rid]; const d = configurable(m); const [e1, e2] = m.extrasFor(d.key);
    const cart = createCart(m); cart.add(d.key, [e1.key], 2); cart.add(d.key, [e1.key, e2.key], 1); cart.inc(d.key);
    for (const reward of [false, true]) {
      await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
      await clean();
      const b = bodyOf(rid, 'cash', cart, reward ? { redeem: REWARD[rid] } : {});
      const r = await post(app.createOrder, b, { 'x-firebase-id-token': UID });
      assert.strictEqual(r.status, 200, `F reward=${reward}: ${r.text.slice(0, 160)}`);
      const o = await order(b.order_id);
      const food = o.total_cents - ((Number(o.delivery_cents) || 0) - (Number(o.promo_discount_cents) || 0));
      const rec = buildFacturaRecord({ order: { ...o, orderId: b.order_id, razon_social: o.razon_social || '', rtn_cliente: o.rtn_cliente || '' }, config: FACTURA_CONFIG, reserved: 1, now: 1760000000000 });
      const lines = o.factura_items || o.items;
      assert.ok(Array.isArray(lines) && lines.length >= cart.count(), `premise: N structured lines (${lines && lines.length})`);
      // the REAL record's own reconciliation: the line bases (tax-exclusive, from the tax-inclusive line gross) foot to the FULL
      // net = subtotal + rebaja (the rebaja is a NET amount); subtotal + ISV == the record's total == the FOOD total
      assert.strictEqual(rec.items.length, lines.length, 'one record line per structured line');
      assert.strictEqual(rec.items.reduce((a, l) => a + l.base_cents, 0), rec.subtotal_cents + rec.desc_rebaja_cents, `🔴 F reward=${reward}: Σ line bases == subtotal + rebaja`);
      assert.strictEqual(rec.subtotal_cents + rec.isv_total_cents, rec.total_cents, `F reward=${reward}: base + ISV == the record total`);
      assert.strictEqual(rec.total_cents, food, `🔴 F reward=${reward}: the factura total == the FOOD total (net delivery excluded)`);
      if (reward) assert.ok(rec.desc_rebaja_cents > 0, 'premise: the reward produces a rebaja');
    }
  }
  await setPricing(false);
  ok('F factura (x_pizza, envío ON): N per-instance structured lines; the real record\'s line bases foot to subtotal + rebaja, base + ISV == its total == the FOOD total (net delivery excluded), with and without a reward');

  // ── C. the canonical branch on N-line bodies (the real canonicalCartNorm, a D4-a context from the served identities) ──
  {
    const CB = require('../catalog/canonical-binding');
    for (const rid of ['x_pizza', 'la_musa']) {
      const m = MENU[rid]; const src = buildSourceFromCode(rid);
      const ctx = { usableAsIdentity: true, objects: [
        ...src.items.map((i) => ({ kind: 'dish', legacyKey: i.key, canonicalId: String((m.dishes.find((d) => String(d.id) === String(i.display.id)) || {}).dish_id), label: i.display.name })),
        ...src.extras.map((e) => ({ kind: 'extra', legacyKey: e.key, canonicalId: String((m.extras.find((x) => String(x.id) === String(e.display.id)) || {}).extra_id), label: e.display.name }))] };
      for (const [label, cart] of carts(rid)) {
        const r = CB.canonicalCartNorm(serialize(cart, m).items, rid, ctx);
        assert.ok(r && r.ok !== false, `🔴 ${rid} ${label}: the canonical branch verifies every dish_id / extra_id claim on the N lines (${JSON.stringify(r).slice(0, 200)})`);
      }
    }
  }
  ok('C the canonical branch (the real canonicalCartNorm) verifies every dish_id / extra_id claim on the N-line bodies of every cart, both restaurants');

  FINISHED = true;
  console.log(`\ncapp-s1-money(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
