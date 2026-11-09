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
// codex r1 P2: the read-only classifier fails the next N calls (the handler's classify, then P-C's re-check)
let CLASSIFY_FAIL = 0; let CLASSIFY_CALLS = 0;
stub('../pixelpay-hosted-charge', (r) => ({ ...r,
  acquireHostedAttempt: async (db, orderId, ...a) => { if (EXPIRE_BEFORE_ACQUIRE) { const f = EXPIRE_BEFORE_ACQUIRE; EXPIRE_BEFORE_ACQUIRE = null; await f(orderId); } return r.acquireHostedAttempt(db, orderId, ...a); },
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
async function cash(opts = {}, hdr = {}) { await clean(); const b = opts.body || body('cash', opts); const r = await post(app.createOrder, b, hdr); return { ...r, b, rec: (await rtdb.ref(`orders/${b.order_id}`).get()).val() }; }
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
    const c = await cash({ extra: { tip_cents: 2000 } });
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
    const c = await cash({ extra: { tip_cents: 2000, quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } });
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    assert.deepStrictEqual([c.rec.total_cents, c.rec.tip_cents, c.rec.delivery_cents, Math.round(c.rec.total * 100), c.rec.subtotal_cents + c.rec.tax_cents], [food + 7000, 2000, 5000, food + 7000, food], 'recorded = quoted = food + envío + tip; total (lempiras) agrees; the FOOD split untouched');
    assert.strictEqual(c.rec.payment_fingerprint, orderFingerprint(c.b.order_id, food, c.b.items_text, 'tp:2000'), 'the cash order\'s stored fingerprint binds the tip (tp:2000)');
    const task = (await rtdb.ref(`tasks/${c.b.order_id}_delivery`).get()).val();
    assert.strictEqual(Math.round(task.total * 100), food + 7000, 'the delivery task carries the full total (what the driver collects)');
    const promo = await cash({ extra: { tip_cents: 2000 } }, { 'x-firebase-id-token': 'member1' });
    assert.deepStrictEqual([promo.status, promo.rec.total_cents, promo.rec.tip_cents], [200, food + 2000, 2000], 'member promo: envío free, the tip still charged (food + 0 + tip)');
    const qk = await quote({ tip_cents: 2000 });
    const k = await card({ extra: { tip_cents: 2000, quote_token: qk.json.quote_token, expected_net_cents: qk.json.net_total_cents } });
    assert.ok(k.status === 200 && k.charged.length === 1, `card accepted (${k.text.slice(0, 200)})`);
    assert.deepStrictEqual([k.charged[0].amount * 100, k.rec.total_cents, k.rec.tip_cents], [food + 7000, food + 7000, 2000], 'PixelPay is asked for food + envío + tip; the pending order (what capture charges: total_cents / 100) carries the same');
    assert.strictEqual(k.rec.payment_fingerprint, orderFingerprint(k.b.order_id, food + 7000, k.b.items_text, 'tp:2000'), 'the card order\'s stored fingerprint binds the tip (tp:2000)');
    tipped = k;
    const low = await cash({ extra: { tip_cents: 3000, quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } });
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
    const p = await cash({ type: 'pickup', extra: { tip_cents: 500 } });
    assert.deepStrictEqual([p.status, p.json && p.json.error, p.rec], [400, 'tip_pickup', null], 'pickup + tip → 400 tip_pickup, no order');
    const ok200 = await cash({ extra: { tip_cents: 200000 } });
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
  ok('D0: a tip with an omitted / empty / unknown payment_method ⇒ 400 tip_payment_method_invalid on cash and card, nothing written, no checkout; without a tip ⇒ today\'s path; known methods pass');

  // ── 4. idempotency: same id + same tip → the same order; a changed tip → order_exists reason 'tip' ──
  {
    const first = await cash({ extra: { tip_cents: 2000 } });
    const again = await cash({ body: first.b });
    assert.deepStrictEqual([again.status, again.json.idempotent || again.json.ok], [200, true], `same id + same tip → idempotent 200 (${again.text.slice(0, 160)})`);
    const changed = await cash({ body: { ...first.b, tip_cents: 3000 } });
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

  FINISHED = true;
  console.log(`\ns2tip (emulator): ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error('s2tip FAILED:', e); process.exit(1); });
