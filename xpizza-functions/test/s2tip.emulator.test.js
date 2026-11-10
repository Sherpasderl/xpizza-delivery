'use strict';
// S2-srv-tip — the TIP + P-C end to end on the emulator through the REAL index.js handlers (quoteOrder, quoteRedemption,
// createOrder, chargeOnlineOrder), PLAN-capp-S2-r4 §3.7 / §4.1. Bands as test placeholders (≤ 2 km L30, ≤ 5 km L50, ≤ 7 km L70);
// the restaurant radius is 8 km unless a cell narrows it.
//   DARK + tip       → 409 tip_not_enabled on quote / cash / card, nothing written, no checkout
//   ACTIVE           → quote(tip) → createOrder(token, tip) records total_cents = food + envío − promo + tip, total = /100,
//                      tip_cents; the card asks PixelPay for the same amount and the pending order (what capture charges)
//                      carries it; tip_invalid / tip_pickup / tip_reward_unsupported refuse before any write
//   IDEMPOTENCY      → same id + same tip = idempotent 200 / reuse; a changed tip = 409 order_exists reason 'tip' (cash + card)
//   RECOVERY         → a live checkout issued WITH a tip still resumes after the restaurant goes dark (fresh dark refusals
//                      never touch already-issued economics)
//   P-C              → no payer email (env unset, none from the customer) → 503 before any gateway call / attempt / order;
//                      a live checkout still resumes
//   APP COVERAGE     → entry_mode:'app' quotes are refused beyond min(last band, radius); legacy quotes unchanged; the
//                      public { from_cents, max_km }
// Run: npm run test:s2tip
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's2tip-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 's2tip-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.PIXELPAY_MERCHANT_EMAIL = 'merchant@example.com';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push({ amount: Number(q.amountLempiras), email: q.customerEmail || q.email || null }); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
// the P-C race (as test/s3a-envio.emulator.test.js): the live checkout EXPIRES after the handler's classify and before the acquire
let EXPIRE_BEFORE_ACQUIRE = null;
let INJECT_AT_CAS = null;   // tip-pref §8: the conflicting patch applied to orders/{id} between the pre-read and the CAS
let LAST_CAS = null;        // tip-pref §8: { committed, unchanged } of that CAS
// codex r1 P2: the read-only classifier fails the next N calls (the handler's classify, then P-C's re-check)
let CLASSIFY_FAIL = 0; let CLASSIFY_CALLS = 0;
stub('../pixelpay-hosted-charge', (r) => ({ ...r,
  acquireHostedAttempt: async (db, orderId, ...a) => {
    if (EXPIRE_BEFORE_ACQUIRE) { const f = EXPIRE_BEFORE_ACQUIRE; EXPIRE_BEFORE_ACQUIRE = null; await f(orderId); }
    // tip-pref §8 (Codex slice-C r1 #2 / r2 #1): a REAL unchanged-COMMIT refusal — the pre-read saw a COMPATIBLE existing order (install
    // path); the conflicting change is applied just before the CAS, so the transaction COMMITS the record unchanged and the
    // post-transaction acceptance checks refuse. The CAS result is recorded (LAST_CAS) so the cell can prove that path was taken.
    if (INJECT_AT_CAS) {
      const patch = INJECT_AT_CAS; INJECT_AT_CAS = null;
      const wrapped = Object.create(db);
      wrapped.ref = (p) => { const ref = db.ref(p); if (p !== `orders/${orderId}`) return ref; const w = Object.create(ref);
        w.transaction = async (fn, ...x) => { await ref.update(patch); const before = (await ref.once('value')).val(); const res = await ref.transaction(fn, ...x);
          LAST_CAS = { committed: res.committed, unchanged: JSON.stringify(res.snapshot.val()) === JSON.stringify(before) }; return res; };
        return w; };
      return r.acquireHostedAttempt(wrapped, orderId, ...a);
    }
    return r.acquireHostedAttempt(db, orderId, ...a);
  },
  classifyHostedAttempt: async (...a) => { CLASSIFY_CALLS++; if (CLASSIFY_FAIL > 0) { CLASSIFY_FAIL--; throw new Error('injected classify read failure'); } return r.classifyHostedAttempt(...a); } }));
const { orderFingerprint } = require('../pixelpay-charge');

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2tip: FAILED — exited without completing'); process.exitCode = 1; } });

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
const RID = 'x_pizza';
const LINE = { name: 'Margherita', qty: 1, price: 0 };
let PH = 0; const phone = () => `9977${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const body = (method, { type = 'delivery', km = 4, extra = {}, id = null } = {}) => {
  const p = north(km);
  return { restaurant_id: RID, order_id: id || `s2t_${method}_${PH}_${Date.now()}`, customer_name: 'S2 Tip', customer_phone: phone(), customer_email: 's2tip@example.com',
    items_text: `1x ${LINE.name}`, order_type: type, payment_method: method, items: [LINE],
    ...(type === 'delivery' ? { lat: p.lat, lng: p.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1', pin_confirmed: true } : {}), ...extra };
};
const attemptsOf = async (oid) => Object.values((await rtdb.ref('payment_attempts').get()).val() || {}).filter((a) => a && a.order_id === oid);
async function cash(opts = {}, hdr = {}) { await clean(); const b = opts.body || body(opts.method || 'cash', opts);   /* r7: tipped orders on the createOrder path use card_delivery (cash + tip is refused) */ const r = await post(app.createOrder, b, hdr); return { ...r, b, rec: (await rtdb.ref(`orders/${b.order_id}`).get()).val() }; }
async function card(opts = {}, hdr = {}) {
  await clean(); CHARGED.length = 0;
  const b = opts.body || body('online', opts);
  const r = await post(app.chargeOnlineOrder, b, hdr);
  return { ...r, b, charged: [...CHARGED], attempts: (await attemptsOf(b.order_id)).length, rec: (await rtdb.ref(`orders/${b.order_id}`).get()).val() };
}
async function quote(extra = {}, km = 4) { await clean(); const p = north(km); return post(app.quoteOrder, { restaurant_id: RID, items: [LINE], mode: 'delivery', pin: { lat: p.lat, lng: p.lng, confirmed: true }, ...extra }); }
const setPricing = (restaurants) => (restaurants === undefined ? rtdb.ref('platform_config/delivery_pricing').remove() : rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: BANDS, restaurants }));
const setRadius = (km) => rtdb.ref(`restaurants/${RID}/identity/delivery_radius_km`).set(km);

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 's2tip-seed' });
    const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
  }

  // ── 1. DARK + tip → 409 tip_not_enabled everywhere, nothing written; DARK without a tip → accepted as before ──
  await setPricing(undefined);
  const food = (await cash({ type: 'pickup' })).rec.total_cents;   // the food total (dark, no envío)
  {
    const q = await quote({ tip_cents: 2000 });
    assert.deepStrictEqual([q.status, q.json], [409, { ok: false, error: 'tip_not_enabled' }], `dark quote + tip (${q.text.slice(0, 160)})`);
    const c = await cash({ method: 'card_delivery', extra: { tip_cents: 2000 } });
    assert.deepStrictEqual([c.status, c.json && c.json.error, c.rec], [409, 'tip_not_enabled', null], `dark cash + tip: refused, no order (${c.text.slice(0, 160)})`);
    const k = await card({ extra: { tip_cents: 2000 } });
    assert.deepStrictEqual([k.status, k.json && k.json.error, k.charged.length, k.attempts, k.rec], [409, 'tip_not_enabled', 0, 0, null], `dark card + tip: refused, no checkout, nothing written (${k.text.slice(0, 160)})`);
    const plain = await cash({ extra: { tip_cents: 0 } });
    assert.deepStrictEqual([plain.status, plain.rec.total_cents, 'tip_cents' in plain.rec], [200, food, false], 'dark + tip_cents:0 → the no-tip order, no tip field');
  }
  ok('DARK: a tip is refused 409 tip_not_enabled on quote / cash / card with nothing written and no checkout; tip_cents:0 is the ordinary no-tip order');

  // ── 2. ACTIVE: quote(tip) → createOrder(token, tip) — recorded = quoted = food + envío + tip; card charged = recorded ──
  await setPricing({ x_pizza: { active: true, free_delivery: true }, la_musa: { active: false } });
  let tipped;
  {
    const q = await quote({ tip_cents: 2000 });
    assert.strictEqual(q.status, 200, q.text.slice(0, 200));
    assert.strictEqual(q.json.net_total_cents, food + 5000 + 2000, 'the quote net = food + envío (4 km band) + tip, once');
    assert.strictEqual(q.json.total_cents, food, 'the quote total_cents stays the FOOD total (the client\'s Subtotal)');
    assert.deepStrictEqual([q.json.delivery.from_cents, q.json.delivery.max_km], [3000, 7], 'public facts: from_cents = lowest band, max_km = last band');
    const c = await cash({ method: 'card_delivery', extra: { tip_cents: 2000, quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } });
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    assert.deepStrictEqual([c.rec.total_cents, c.rec.tip_cents, c.rec.delivery_cents, Math.round(c.rec.total * 100), c.rec.subtotal_cents + c.rec.tax_cents], [food + 7000, 2000, 5000, food + 7000, food], 'recorded = quoted = food + envío + tip; total (lempiras) agrees; the FOOD split untouched');
    assert.strictEqual(c.rec.payment_fingerprint, orderFingerprint(c.b.order_id, food, c.b.items_text, 'tp:2000'), 'the cash order\'s stored fingerprint binds the tip (tp:2000)');
    const task = (await rtdb.ref(`tasks/${c.b.order_id}_delivery`).get()).val();
    assert.strictEqual(Math.round(task.total * 100), food + 7000, 'the delivery task carries the full total (what the driver collects)');
    const promo = await cash({ method: 'card_delivery', extra: { tip_cents: 2000 } }, { 'x-firebase-id-token': 'member1' });
    assert.deepStrictEqual([promo.status, promo.rec.total_cents, promo.rec.tip_cents], [200, food + 2000, 2000], 'member promo: envío free, the tip still charged (food + 0 + tip)');
    const qk = await quote({ tip_cents: 2000 });
    const k = await card({ extra: { tip_cents: 2000, quote_token: qk.json.quote_token, expected_net_cents: qk.json.net_total_cents } });
    assert.ok(k.status === 200 && k.charged.length === 1, `card accepted (${k.text.slice(0, 200)})`);
    assert.deepStrictEqual([k.charged[0].amount * 100, k.rec.total_cents, k.rec.tip_cents], [food + 7000, food + 7000, 2000], 'PixelPay is asked for food + envío + tip; the pending order (what capture charges: total_cents / 100) carries the same');
    assert.strictEqual(k.rec.payment_fingerprint, orderFingerprint(k.b.order_id, food + 7000, k.b.items_text, 'tp:2000'), 'the card order\'s stored fingerprint binds the tip (tp:2000)');
    tipped = k;
    const low = await cash({ method: 'card_delivery', extra: { tip_cents: 3000, quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } });
    assert.deepStrictEqual([low.status, low.json && low.json.error, low.rec], [409, 'quote_invalid', null], 'a token signed for L20 never authorises a L30 tip (re-quote)');
  }
  ok('ACTIVE: quote(tip) net = food + envío + tip once (Subtotal = food total_cents; public {from_cents, max_km}); createOrder records it (total, task, tip_cents, food split intact); promo keeps the tip; PixelPay + the pending order carry the same amount; a token never carries a different tip');

  // ── 3. the early refusals: nothing written ──
  {
    for (const [extra, status, error] of [[{ tip_cents: '500' }, 400, 'tip_invalid'], [{ tip_cents: 200001 }, 400, 'tip_invalid'], [{ tip_cents: -1 }, 400, 'tip_invalid'], [{ tip_cents: 500, redeem: { type: 'free_pizza_choice', item_id: 'Carnivora' } }, 409, 'tip_reward_unsupported']]) {
      const c = await cash({ extra });
      assert.deepStrictEqual([c.status, c.json && c.json.error, c.rec], [status, error, null], `cash ${JSON.stringify(extra)}`);
      const k = await card({ extra });
      assert.deepStrictEqual([k.status, k.json && k.json.error, k.charged.length, k.attempts, k.rec], [status, error, 0, 0, null], `card ${JSON.stringify(extra)}`);
    }
    const p = await cash({ method: 'card_delivery', type: 'pickup', extra: { tip_cents: 500 } });
    assert.deepStrictEqual([p.status, p.json && p.json.error, p.rec], [400, 'tip_pickup', null], 'pickup + tip → 400 tip_pickup, no order');
    const ok200 = await cash({ method: 'card_delivery', extra: { tip_cents: 200000 } });
    assert.deepStrictEqual([ok200.status, ok200.rec.tip_cents], [200, 200000], 'TIP_MAX (L 2,000) itself is accepted');
    const qr = await post(app.quoteRedemption, { restaurant_id: RID, items: [LINE], redeem: { type: 'free_pizza_choice', item_id: 'Carnivora' }, tip_cents: 500, mode: 'delivery', pin: { ...north(4), confirmed: true } }, { 'x-firebase-id-token': 'member1' });
    assert.deepStrictEqual([qr.status, qr.json && qr.json.error], [409, 'tip_reward_unsupported'], `quoteRedemption + tip (${qr.text.slice(0, 160)})`);
  }
  ok('refusals: tip_invalid 400 (string / over L 2,000 / negative), tip_reward_unsupported 409 (orders + quoteRedemption), tip_pickup 400 — each before any write or checkout; L 2,000 itself accepted');

  // ── 3b. PLAN-capp-tip-step r6 D0: a positive tip needs a known payment method (intake sanitizes an omitted / empty / unknown
  //        method to ''); refused 400 tip_payment_method_invalid before any write or checkout; a no-tip order is unchanged ──
  {
    const withMethod = (method, extra) => { const b = body(method === undefined ? 'cash' : method, { extra }); if (method === undefined) delete b.payment_method; return b; };
    for (const m of [undefined, '', 'bitcoin']) {
      const c = await cash({ body: withMethod(m, { tip_cents: 2000 }) });
      assert.deepStrictEqual([c.status, c.json && c.json.error, c.rec], [400, 'tip_payment_method_invalid', null], `🔴 D0 cash: method ${JSON.stringify(m)} + tip ⇒ 400, nothing written`);
      const k = await card({ body: withMethod(m, { tip_cents: 2000 }) });
      assert.deepStrictEqual([k.status, k.json && k.json.error, k.charged.length, k.attempts, k.rec], [400, 'tip_payment_method_invalid', 0, 0, null], `🔴 D0 card: method ${JSON.stringify(m)} + tip ⇒ 400, no checkout`);
      const c0 = await cash({ body: withMethod(m, {}) });
      assert.notStrictEqual(c0.json && c0.json.error, 'tip_payment_method_invalid', `D0: method ${JSON.stringify(m)} without a tip keeps today's path`);
      const k0 = await card({ body: withMethod(m, {}) });
      assert.notStrictEqual(k0.json && k0.json.error, 'tip_payment_method_invalid', `D0: card, method ${JSON.stringify(m)} without a tip keeps today's path`);
    }
    for (const [fn, m] of [[cash, 'cash'], [card, 'online']]) {
      const r = await fn({ body: body(m, { extra: { tip_cents: 2000 } }) });
      assert.notStrictEqual(r.json && r.json.error, 'tip_payment_method_invalid', `D0: ${m} + tip is not refused by D0`);
    }
  }
  {   // Codex slice-C r1 #1: ZERO writes on a D0 refusal (every order / attempt / member node byte-identical before and after)
    const snapOf = async () => JSON.stringify(await Promise.all(['orders', 'payment_attempts', 'user_orders', 'user_private', 'order_tracking', 'tasks', 'checkout_claims'].map(async (p) => (await rtdb.ref(p).get()).val())));
    const before = await snapOf();
    const c = await cash({ body: (() => { const b = body('cash', { extra: { tip_cents: 2000 } }); delete b.payment_method; return b; })() }, { 'x-firebase-id-token': 'm_d0' });
    const k = await card({ body: body('bitcoin', { extra: { tip_cents: 2000, tip_choice: true } }) }, { 'x-firebase-id-token': 'm_d0' });
    assert.deepStrictEqual([c.status, k.status], [400, 400], 'premise: both refused by D0');
    assert.strictEqual(await snapOf(), before, '🔴 D0: ZERO writes on the refusal (orders, attempts, history, preference, tracking, tasks, claims)');
  }
  {   // OWNER 11-09 (r7): the in-app tip is CARD-ONLY — cash + a positive tip ⇒ 400 tip_cash_unsupported on createOrder AND charge, zero writes;
      // card_delivery + a tip is accepted; cash WITHOUT a tip is unchanged
    const snapOf = async () => JSON.stringify(await Promise.all(['orders', 'payment_attempts', 'user_orders', 'user_private'].map(async (p) => (await rtdb.ref(p).get()).val())));
    const before = await snapOf();
    const c = await cash({ extra: { tip_cents: 2000, tip_choice: true } }, { 'x-firebase-id-token': 'm_cashtip' });
    const k = await card({ body: body('cash', { extra: { tip_cents: 2000 } }) });
    assert.deepStrictEqual([c.status, c.json && c.json.error, k.status, k.json && k.json.error, k.charged.length], [400, 'tip_cash_unsupported', 400, 'tip_cash_unsupported', 0], '🔴 D0-cash: cash + tip ⇒ 400 tip_cash_unsupported (createOrder and charge)');
    assert.strictEqual(await snapOf(), before, '🔴 D0-cash: ZERO writes (no order, attempt, history or preference)');
    const cd = await cash({ method: 'card_delivery', extra: { tip_cents: 2000 } });
    assert.deepStrictEqual([cd.status, cd.rec && cd.rec.tip_cents, cd.rec && cd.rec.payment_method], [200, 2000, 'card_delivery'], '🔴 D0-cash: card_delivery + tip is accepted');
    const plain = await cash({});
    assert.strictEqual(plain.status, 200, 'D0-cash: cash without a tip is unchanged');
  }
  ok('D0: a tip with an omitted / empty / unknown payment_method ⇒ 400 tip_payment_method_invalid on cash and card, ZERO writes, no checkout; cash + tip ⇒ 400 tip_cash_unsupported (owner 11-09, card-only tip), zero writes; card_delivery + tip accepted; without a tip ⇒ today\'s path');

  // ── 4. idempotency: same id + same tip → the same order; a changed tip → order_exists reason 'tip' ──
  {
    const first = await cash({ method: 'card_delivery', extra: { tip_cents: 2000 } });
    const again = await cash({ body: first.b });
    assert.deepStrictEqual([again.status, again.json.idempotent || again.json.ok], [200, true], `same id + same tip → idempotent 200 (${again.text.slice(0, 160)})`);
    const changed = await cash({ body: { ...first.b, tip_cents: 3000 } });   /* first.b is card_delivery (r7) */
    assert.deepStrictEqual([changed.status, changed.json.error, changed.json.reason], [409, 'order_exists', 'tip'], `changed tip → order_exists/tip (${changed.text.slice(0, 160)})`);
    const dropped = await cash({ body: { ...first.b, tip_cents: undefined } });
    assert.strictEqual(dropped.json.reason, 'tip', 'dropping the tip is a change too');
    const live = await card({ body: tipped.b });
    assert.deepStrictEqual([live.status, live.charged.length, live.attempts], [200, 0, 1], 'card: same tip → the live checkout is REUSED (no new charge, one attempt)');
    const cardChanged = await card({ body: { ...tipped.b, tip_cents: 3000 } });
    assert.deepStrictEqual([cardChanged.status, cardChanged.json.error, cardChanged.json.reason, cardChanged.charged.length], [409, 'order_exists', 'tip', 0], `card: changed tip → order_exists/tip, never reuse (${cardChanged.text.slice(0, 160)})`);
  }
  ok('idempotency: same id + same tip = idempotent 200 (cash) / reuse (card); a changed or dropped tip = 409 order_exists reason tip on both paths');

  // ── 5. recovery: a live checkout issued WITH a tip still resumes after the restaurant goes dark ──
  {
    await setPricing({ x_pizza: { active: false } });
    const resumed = await card({ body: tipped.b });
    assert.deepStrictEqual([resumed.status, resumed.charged.length, resumed.json && resumed.json.checkout_url ? 'url' : resumed.text.slice(0, 160)], [200, 0, 'url'], 'dark now, the tipped live checkout resumes (grandfathered economics, not tip_not_enabled)');
    const fresh = await card({ extra: { tip_cents: 2000 } });
    assert.strictEqual(fresh.json.error, 'tip_not_enabled', 'while a FRESH tipped checkout is refused');
    await setPricing({ x_pizza: { active: true, free_delivery: true } });
  }
  ok('recovery: an already-issued tipped checkout resumes after the restaurant goes dark; only fresh tipped issuance is refused');

  // ── 6. P-C: no payer email → 503 before any gateway call / attempt / order; recovery unaffected ──
  {
    delete process.env.PIXELPAY_MERCHANT_EMAIL;
    for (const v of [undefined, '', 'not-an-email']) {
      if (v === undefined) delete process.env.PIXELPAY_MERCHANT_EMAIL; else process.env.PIXELPAY_MERCHANT_EMAIL = v;
      const k = await card({ extra: { customer_email: '' } });
      assert.deepStrictEqual([k.status, k.json && k.json.error, k.charged.length, k.attempts, k.rec], [503, 'payer_email_unconfigured', 0, 0, null], `env ${JSON.stringify(v)} + no customer email → 503, nothing issued (${k.text.slice(0, 160)})`);
    }
    delete process.env.PIXELPAY_MERCHANT_EMAIL;
    const withEmail = await card({ extra: { customer_email: 'buyer@example.com' } });
    assert.ok(withEmail.status === 200 && withEmail.charged.length === 1, `a valid customer email needs no fallback (${withEmail.text.slice(0, 160)})`);
    const resumed = await card({ body: tipped.b });
    assert.deepStrictEqual([resumed.status, resumed.charged.length], [200, 0], 'an existing live checkout still resumes with the env unset');
    // the RACE: classify sees a live checkout (reuse → the pre-check does not run), then it expires before the acquire, which
    // would ROTATE to a fresh checkout → refused there: no new attempt, the existing attempt untouched, 503
    process.env.PIXELPAY_MERCHANT_EMAIL = 'merchant@example.com';
    const live = await card({ extra: { customer_email: '' } });
    assert.ok(live.status === 200 && live.charged.length === 1, `premise: a live checkout (${live.text.slice(0, 160)})`);
    const aid = live.rec.active_attempt_id;
    delete process.env.PIXELPAY_MERCHANT_EMAIL;
    let before = null;
    EXPIRE_BEFORE_ACQUIRE = async (oid) => { await rtdb.ref(`payment_attempts/${aid}/hosted_expires_at`).set(1); before = (await rtdb.ref(`payment_attempts/${aid}`).get()).val(); };
    const raced = await card({ body: live.b });
    assert.strictEqual(EXPIRE_BEFORE_ACQUIRE, null, 'premise: the interleaving ran');
    const after = await attemptsOf(live.b.order_id);
    assert.deepStrictEqual([raced.status, raced.json && raced.json.error, raced.charged.length, after.length, (await rtdb.ref(`orders/${live.b.order_id}/active_attempt_id`).get()).val()],
      [503, 'payer_email_unconfigured', 0, 1, aid], `P-C race: 503, no gateway call, no new attempt, the order still points at its attempt (${raced.text.slice(0, 160)})`);
    assert.deepStrictEqual((await rtdb.ref(`payment_attempts/${aid}`).get()).val(), before, 'the existing attempt is byte-untouched (never retired or rotated)');
    // codex r1 P2: a REWARD-bearing fresh checkout whose classification FAILS (and whose re-check fails too) with no payer email
    // → refused BEFORE the reserve: zero reserve, zero hold, zero gateway calls, no attempt, no order
    const UID = 'u_s2tip';
    await rtdb.ref('config/redemption_enabled').set(true);
    await rtdb.ref(`user_rewards/${UID}/${RID}`).set({ balance: 8, reserved: 0 });
    CLASSIFY_FAIL = 2; CLASSIFY_CALLS = 0;
    const rw = await card({ extra: { customer_email: '', redeem: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } } }, { 'x-firebase-id-token': UID });
    const wallet = (await rtdb.ref(`user_rewards/${UID}/${RID}`).get()).val();
    assert.deepStrictEqual([rw.status, rw.json && rw.json.error, CLASSIFY_CALLS, CLASSIFY_FAIL, rw.charged.length, rw.attempts, rw.rec, wallet.reserved, wallet.reservations || null],
      [503, 'payer_email_unconfigured', 2, 0, 0, 0, null, 0, null], `reward + classify failure + no email → refused before the reserve: zero hold, zero gateway calls (${rw.text.slice(0, 200)})`);
    // the same failure ONCE (the re-check works) on a real live checkout → recovery untouched (reuse, no new charge)
    process.env.PIXELPAY_MERCHANT_EMAIL = 'merchant@example.com';
    const live2 = await card({ extra: { customer_email: '' } });
    assert.ok(live2.status === 200 && live2.charged.length === 1, `premise: a live checkout (${live2.text.slice(0, 160)})`);
    delete process.env.PIXELPAY_MERCHANT_EMAIL;
    CLASSIFY_FAIL = 1; CLASSIFY_CALLS = 0;
    const rec = await card({ body: live2.b });
    assert.deepStrictEqual([rec.status, rec.charged.length, rec.attempts, CLASSIFY_CALLS], [200, 0, 1, 2], `classify failed once, the re-check proves the live checkout → reuse, no charge (${rec.text.slice(0, 160)})`);
    process.env.PIXELPAY_MERCHANT_EMAIL = 'merchant@example.com';
  }
  ok('P-C: no payer email (env missing / blank / malformed, none from the customer) → 503 payer_email_unconfigured with zero gateway calls, no attempt, no order; a customer email works; a live checkout still resumes; the classify→acquire race is refused at the acquire with the existing attempt untouched; a FAILED classify is re-established before the reserve (reward + no email → zero hold), and a proven live checkout still reuses');

  // ── 6b. codex r1 P2: an ACTIVE but INVALID config → both quote handlers answer 200 {ok:false, error:'delivery_pricing_invalid'}
  //        exactly as before S2, for an absent and a zero tip (never a 500) ──
  {
    await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: [{ max_km: 'x', cents: 1 }], restaurants: { [RID]: { active: true } } });
    for (const extra of [{}, { tip_cents: 0 }, { entry_mode: 'app' }]) {
      const q = await quote(extra);
      assert.deepStrictEqual([q.status, q.text], [200, JSON.stringify({ ok: false, error: 'delivery_pricing_invalid' })], `quoteOrder, invalid config ${JSON.stringify(extra)} → the base 200 body (${q.status} ${q.text.slice(0, 160)})`);
      await clean();
      const qr = await post(app.quoteRedemption, { restaurant_id: RID, items: [LINE], redeem: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, mode: 'delivery', pin: { ...north(4), confirmed: true }, ...extra }, { 'x-firebase-id-token': 'member1' });
      assert.deepStrictEqual([qr.status, qr.text], [200, JSON.stringify({ ok: false, error: 'delivery_pricing_invalid' })], `quoteRedemption, invalid config ${JSON.stringify(extra)} → the base 200 body (${qr.status} ${qr.text.slice(0, 160)})`);
    }
    await setPricing({ x_pizza: { active: true, free_delivery: true }, la_musa: { active: false } });
  }
  ok('invalid active delivery config: quoteOrder AND quoteRedemption answer the base 200 {ok:false, error:"delivery_pricing_invalid"} for an absent / zero tip (legacy + app), never a 500');

  // ── 7. the APP quote: coverage = min(last band, radius); legacy unchanged ──
  {
    await setRadius(3.5);
    const legacy = await quote({}, 4);
    assert.deepStrictEqual([legacy.status, legacy.json.delivery.delivery_cents, legacy.json.delivery.max_km], [200, 5000, 7], 'legacy (no entry_mode): priced at the band, max_km = the last band');
    const appQ = await quote({ entry_mode: 'app' }, 4);
    assert.deepStrictEqual([appQ.status, appQ.json], [200, { ok: false, error: 'outside_delivery_bands' }], 'APP: a pin between the radius (3.5) and the last band (7) is outside');
    const appNear = await quote({ entry_mode: 'app' }, 1);
    assert.deepStrictEqual([appNear.json.ok, appNear.json.delivery.max_km], [true, 3.5], 'APP: max_km reports min(last band, radius)');
    const order = await cash({ km: 4 });
    assert.ok(order.status === 400 && /Outside delivery zone/.test(order.text), 'and the order\'s own radius check refuses that pin, so the app quote now agrees with it');
    await setRadius(8);
  }
  ok('APP coverage: entry_mode:app quotes refuse beyond min(bands, radius) and report it, matching the order radius check; legacy quotes are unchanged');

  // ── 8. PLAN-capp-tip-step r6 §1: the member's last tip — user_private/{uid}/last_tip = {cents, at}, best-effort AFTER acceptance, from
  //        the VERIFIED token uid only, delivery + tip_choice:true only, `at` = the accepted order's resolved created_at, newer-only ──
  await setPricing({ x_pizza: { active: true, free_delivery: true }, la_musa: { active: false } });
  {
    const lastTip = async (uid) => (await rtdb.ref(`user_private/${uid}/last_tip`).get()).val();
    const M = (uid) => ({ 'x-firebase-id-token': uid });
    await rtdb.ref('user_private').remove();
    // cash, immediate: written with the resolved created_at
    const a = await cash({ method: 'card_delivery', extra: { tip_cents: 2000, tip_choice: true } }, M('m_pref'));
    assert.strictEqual(a.status, 200, a.text.slice(0, 200));
    const la = await lastTip('m_pref');
    assert.deepStrictEqual(la, { cents: 2000, at: a.rec.created_at }, '🔴 PREF-E cash: {cents, at = the order\'s resolved created_at}');
    assert.ok(Number.isFinite(la.at), 'PREF-E: `at` is numeric');
    // explicit «Sin propina» (no tip_cents) ⇒ 0
    const z = await cash({ extra: { tip_choice: true } }, M('m_pref'));
    assert.deepStrictEqual(await lastTip('m_pref'), { cents: 0, at: z.rec.created_at }, '🔴 PREF-E: «Sin propina» ⇒ cents 0 (a newer order)');
    // an older order's idempotent retry (same id, same body) never replaces the newer choice
    const retry = await cash({ body: a.b }, M('m_pref'));
    assert.deepStrictEqual([retry.status, (await lastTip('m_pref')).cents], [200, 0], '🔴 PREF-E: retrying the OLDER order is a no-op for the preference');
    // a forged body uid is ignored
    const f = await cash({ method: 'card_delivery', extra: { tip_cents: 4000, tip_choice: true, uid: 'm_evil', customer_uid: 'm_evil' } }, M('m_real'));
    assert.deepStrictEqual([f.status, (await lastTip('m_real')).cents, await lastTip('m_evil')], [200, 4000, null], '🔴 PREF-E: written under the VERIFIED uid only; a body uid never');
    // not eligible: guest / absent tip_choice / pickup ⇒ nothing
    await cash({ method: 'card_delivery', extra: { tip_cents: 2000, tip_choice: true } });
    await cash({ method: 'card_delivery', extra: { tip_cents: 6000 } }, M('m_nochoice'));
    await cash({ type: 'pickup', extra: { tip_choice: true } }, M('m_pickup'));
    assert.deepStrictEqual([await lastTip('m_nochoice'), await lastTip('m_pickup')], [null, null], '🔴 PREF-E: no tip_choice / pickup ⇒ nothing; a guest has no uid');
    // a refused order writes nothing
    const bad = await cash({ method: 'card_delivery', extra: { tip_cents: 2000, tip_choice: true, payment_method: '' } }, M('m_refused'));
    assert.deepStrictEqual([bad.status, await lastTip('m_refused')], [400, null], 'PREF-E: a refused order (D0) ⇒ nothing');
    // hosted card: written only once the charge ISSUED; an unchanged-commit refusal (the same order with a different tip ⇒ tip conflict) writes nothing
    const k = await card({ extra: { tip_cents: 6000, tip_choice: true } }, M('m_card'));
    assert.strictEqual(k.status, 200, k.text.slice(0, 200));
    assert.deepStrictEqual(await lastTip('m_card'), { cents: 6000, at: k.rec.created_at }, '🔴 PREF-E card: written after the charge issued, at = the pending order\'s created_at');
    // hosted UNCHANGED-COMMIT refusals (Codex slice-C r1 #2, r2 #1-#2): seed a COMPATIBLE existing order (a real first card attempt,
    // then its attempt pointer cleared ⇒ the pre-read decides INSTALL), patch the conflict in just before the CAS, and prove the
    // transaction COMMITTED unchanged and the request was refused. The preference is seeded ABSENT or strictly OLDER than the order's
    // created_at, and every preference transaction is COUNTED (a spy on the admin Reference) — the count must stay 0.
    const RefProto = Object.getPrototypeOf(rtdb.ref('x'));
    const realTx = RefProto.transaction; let prefTx = 0;
    RefProto.transaction = function (...x) { if (/\/user_private\//.test(String(this.toString()))) prefTx++; return realTx.apply(this, x); };
    try {
      for (const [what, patch, outcome] of [
        ['already paid', { payment_status: 'confirmed' }, 'already_paid'],
        ['tip conflict', { tip_cents: 9900 }, 'conflict'],
        ['fingerprint conflict', { payment_fingerprint: 'zz-foreign-fingerprint' }, 'conflict'],
      ]) {
        for (const seed of ['absent', 'older']) {
          const uid = `m_cas_${what.replace(/\W+/g, '_')}_${seed}`;
          const first = await card({ extra: { tip_cents: 2000, tip_choice: true } }, M(uid));
          assert.strictEqual(first.status, 200, `premise (${what}): the compatible order exists (${first.text.slice(0, 120)})`);
          const createdAt = first.rec.created_at;
          await rtdb.ref(`orders/${first.b.order_id}/active_attempt_id`).remove();   // ⇒ the next pre-read decides INSTALL (compatible order, no lock)
          if (seed === 'absent') await rtdb.ref(`user_private/${uid}`).remove(); else await rtdb.ref(`user_private/${uid}/last_tip`).set({ cents: 100, at: createdAt - 1000 });
          const seeded = await lastTip(uid);
          prefTx = 0; LAST_CAS = null; INJECT_AT_CAS = patch;
          const r = await card({ body: first.b }, M(uid));
          assert.strictEqual(INJECT_AT_CAS, null, `premise (${what}/${seed}): the patch was applied at the CAS`);
          assert.deepStrictEqual(LAST_CAS, { committed: true, unchanged: true }, `🔴 premise (${what}/${seed}): the CAS COMMITTED the record UNCHANGED (the unchanged-commit path)`);
          assert.strictEqual(r.charged.length, 0, `premise (${what}/${seed}): refused — no checkout issued (${r.status} ${r.text.slice(0, 120)})`);
          assert.ok(outcome === 'already_paid' ? r.status === 200 || r.status === 409 : r.status === 409, `premise (${what}/${seed}): the post-transaction refusal answered (${r.status})`);
          assert.strictEqual(prefTx, 0, `🔴 PREF-E card (${what}/${seed}): ZERO preference transactions on an unchanged-commit refusal`);
          assert.deepStrictEqual(await lastTip(uid), seeded, `🔴 PREF-E card (${what}/${seed}): the preference is exactly as seeded (${seed}; the order's created_at ${createdAt} is NEWER)`);
        }
      }
    } finally { RefProto.transaction = realTx; }
    // foreign identity (guestForeign) applies only to capp GUESTS (pending.guest_verified, pixelpay-hosted-charge.js:67-68): a guest has
    // no verified uid, so prefOf is null by construction (tip-pref.test.js PREF-1 «a guest») — no preference path exists to refuse
  }
  ok('last tip: cash and card write {cents, at = the accepted order\'s created_at} for the verified member only; «Sin propina» = 0; an older retry, a forged body uid, a guest, no tip_choice, pickup, a refused order and a REAL hosted unchanged-COMMIT refusal (already paid / tip / fingerprint conflict patched in at the CAS of a compatible order) performs ZERO preference transactions');

  // ── 9. Codex slice-C r1 #1: D0 keeps today's precedence — a below-floor client gets its 426 FIRST (the floor read precedes the tip seam) ──
  {
    await rtdb.ref('platform_config/client_floor/orders').set(5);
    await new Promise((r) => setTimeout(r, 31000));   // the floor reader's 30 s cache (client-floor.js FLOOR_TTL_MS)
    const OLD = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-app', 'x-client-build': 'old', 'x-client-compat': '1' };
    const c = await cash({ body: body('bitcoin', { extra: { tip_cents: 2000 } }) }, OLD);
    assert.deepStrictEqual([c.status, c.json && c.json.error], [426, 'client_update_required'], `🔴 D0: below the floor ⇒ 426 first, never D0's 400 (${c.text.slice(0, 120)})`);
    await rtdb.ref('platform_config/client_floor/orders').remove();
  }
  ok('D0 precedence: a below-floor client with a D0-refusable body still gets 426 client_update_required first');

  FINISHED = true;
  console.log(`\ns2tip (emulator): ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error('s2tip FAILED:', e); process.exit(1); });
