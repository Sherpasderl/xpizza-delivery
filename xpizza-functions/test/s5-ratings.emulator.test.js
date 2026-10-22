'use strict';
// S5 — rateOrder end to end on the RTDB emulator through the REAL handler (one thumb per order from the «Entregado» screen,
// proven by the tracker token). The orders + tracker nodes are written by the REAL createOrder record builder
// (buildCreateOrderUpdates); then the order is fulfilled as the driver / pickup flow would stamp it.
//   · a fulfilled order rated via its token → ONE order_ratings record { thumb, rated_at, restaurant_id } — no identity
//   · the same thumb again → idempotent; another thumb → 409 already_rated (first tap final)
//   · not fulfilled / older than 7 days → 409 (what the tracker already shows); malformed / unknown token / a token
//     without an order → the SAME generic 400; nothing written for any refusal
//   · rate limits per IP and per token → 429
//   · RULES (the real database.rules.json in a rules-enabled namespace): no client — customer, dispatcher, merchant /
//     kitchen, handheld, anonymous — can read or write order_ratings or write public_stats; public_stats reads are public
// Run: npm run test:s5-ratings
require('./_emulator-required')('database');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const rtdb = admin.database();
const { rateOrder, BUCKETS } = require('../ratings/rate-order');
const { buildCreateOrderUpdates } = require('../create-order-build');
const { orderBreakdownCents } = require('../order-money');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s5-ratings: FAILED — exited without completing'); process.exitCode = 1; } });

function post(body, ip = '203.0.113.7') {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(rateOrder);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  await rtdb.ref().remove();
}
let SEQ = 0;
async function placeOrder({ type = 'delivery', fulfilled = 'delivered', at = Date.now() - 3600000 } = {}) {
  const orderId = `s5r_${SEQ += 1}_${Date.now()}`, token = `Trk${String(SEQ).padStart(4, '0')}abcdefgh`;
  const u = buildCreateOrderUpdates({
    orderId, orderType: type, now: Date.now() - 7200000, trackingToken: token, total: 340, lat: 14.13, lng: -87.2,
    fields: { customer_name: 'Ana Pérez', customer_phone: '99990000', customer_email: 'a@b.hn', notes: '', pickup_time: 'standard', items_text: '1x Carnivora', payment_method: 'cash', address_detected: 'Col. Prueba, SPS', address_details: 'casa', maps_link: 'm', waze_link: 'w', items: [{ name: 'Carnivora', qty: 1 }] },
    hubSnap: { hub_lat: 14.1, hub_lng: -87.2, restaurant_name: 'X Pizza', restaurant_phone: '+504' }, restaurantId: 'x_pizza', priceBreakdown: orderBreakdownCents(340, 'x_pizza'),
    facturaPriced: { items: [] }, cashTenderedCents: 34000, freeOrder: false, rewardStamp: {},
  });
  await rtdb.ref().update(u);
  if (fulfilled) await rtdb.ref(`orders/${orderId}`).update(type === 'delivery' ? { status: 'delivered', delivered_at: at } : { status: 'completed', completed_at: at });
  return { orderId, token };
}
const rating = async (oid) => (await rtdb.ref(`order_ratings/${oid}`).get()).val();
const clean = () => rtdb.ref('rate_limits').remove();

(async () => {
  await wipe();

  // 1. a delivered order, rated via its tracker token → ONE record, no identity
  const a = await placeOrder();
  const r1 = await post({ tracking_token: a.token, thumb: 'up' });
  assert.deepStrictEqual([r1.status, r1.json], [200, { ok: true }]);
  const rec = await rating(a.orderId);
  assert.deepStrictEqual(Object.keys(rec).sort(), ['rated_at', 'restaurant_id', 'thumb']);
  assert.deepStrictEqual([rec.thumb, rec.restaurant_id], ['up', 'x_pizza']);
  assert.ok(!JSON.stringify(rec).includes('Ana') && !JSON.stringify(rec).includes('9999') && !JSON.stringify(rec).includes(a.token), 'no name, phone or token in the record');
  ok('a delivered order rated via its tracker token → ONE order_ratings record { thumb, rated_at, restaurant_id } — no customer identity');

  // 2. first tap final
  assert.deepStrictEqual([(await post({ tracking_token: a.token, thumb: 'up' })).status, (await rating(a.orderId)).rated_at], [200, rec.rated_at], 'the same thumb again → idempotent, unchanged');
  const ch = await post({ tracking_token: a.token, thumb: 'down' });
  assert.deepStrictEqual([ch.status, ch.json.error, (await rating(a.orderId)).thumb], [409, 'already_rated', 'up'], 'another thumb → 409 already_rated, the first stays');
  ok('first tap final: the same thumb → idempotent 200; a different one → 409 already_rated (unchanged)');

  // 3. pickups count; refusals write nothing
  await clean();
  const p = await placeOrder({ type: 'pickup' });
  assert.strictEqual((await post({ tracking_token: p.token, thumb: 'down' })).status, 200, 'a picked-up pickup can be rated');
  const notYet = await placeOrder({ fulfilled: null });
  const old = await placeOrder({ at: Date.now() - 8 * 86400000 });
  const rN = await post({ tracking_token: notYet.token, thumb: 'up' }), rO = await post({ tracking_token: old.token, thumb: 'up' });
  assert.deepStrictEqual([rN.status, rN.json.error, await rating(notYet.orderId)], [409, 'not_fulfilled', null]);
  assert.deepStrictEqual([rO.status, rO.json.error, await rating(old.orderId)], [409, 'rating_closed', null]);
  ok('pickups count; not yet fulfilled → 409 not_fulfilled, older than 7 days → 409 rating_closed — nothing written');

  // 4. ONE generic refusal for every bad / unknown token (never reveals whether an order exists)
  await clean();
  await rtdb.ref('order_tracking/OrphanTok1234').set({ order_id: 'does_not_exist_9', status: 'delivered' });
  await rtdb.ref('order_tracking/BadIdTok12345').set({ order_id: '../x', status: 'delivered' });
  const replies = [];
  for (const b of [{ tracking_token: 'UnknownTok123', thumb: 'up' }, { tracking_token: 'OrphanTok1234', thumb: 'up' }, { tracking_token: 'BadIdTok12345', thumb: 'up' }, { tracking_token: 'bad/tok', thumb: 'up' }, { thumb: 'up' }, { tracking_token: a.token, thumb: 'maybe' }]) {
    const r = await post(b); replies.push(JSON.stringify([r.status, r.json]));
  }
  assert.deepStrictEqual([...new Set(replies)], [JSON.stringify([400, { ok: false, error: 'invalid' }])], `🔴 every bad / unknown token → the SAME generic 400 (${replies})`);
  assert.deepStrictEqual(Object.keys((await rtdb.ref('order_ratings').get()).val() || {}).sort(), [a.orderId, p.orderId].sort(), 'nothing else was written');
  ok('malformed body, unknown token, a token whose order is missing or malformed → the SAME generic 400 invalid; nothing written');

  // 5. rate limits: per token, then per IP
  await clean();
  const t = await placeOrder();
  const perToken = [];
  for (let i = 0; i < BUCKETS.rate_token.max + 1; i++) perToken.push((await post({ tracking_token: t.token, thumb: 'up' }, `198.51.100.${i}`)).status);
  assert.deepStrictEqual([perToken.slice(0, -1).every((s) => s === 200), perToken[perToken.length - 1]], [true, 429], `per token: the ${BUCKETS.rate_token.max + 1}th → 429 (${perToken})`);
  await clean();
  const perIp = [];
  for (let i = 0; i < BUCKETS.rate_ip.max + 1; i++) perIp.push((await post({ tracking_token: `Flood${String(i).padStart(4, '0')}tokn`, thumb: 'up' }, '192.0.2.99')).status);
  assert.deepStrictEqual([perIp.slice(0, -1).every((s) => s === 400), perIp[perIp.length - 1]], [true, 429], 'per IP: the flood is cut at the cap (each probe was the generic 400 before it)');
  ok(`rate limits: per tracker token (${BUCKETS.rate_token.max} / 10 min) and per IP (${BUCKETS.rate_ip.max} / 10 min) → 429`);

  // 6. RULES: no client reads/writes order_ratings or writes public_stats; public_stats reads are public
  const RULES_TEXT = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-s5-ratings', database: { rules: RULES_TEXT } });
  try {
    await env.withSecurityRulesDisabled(async (c) => {
      await c.database().ref('dispatchers/disp1').set(true); await c.database().ref('kitchen/kit1').set(true);
      await c.database().ref('order_ratings/o1').set({ thumb: 'up', rated_at: 1, restaurant_id: 'x_pizza' });
      await c.database().ref('public_stats/x_pizza').set({ schema_version: 1 });
    });
    const who = {
      anonymous: env.unauthenticatedContext(), customer: env.authenticatedContext('cust1', { customer: true }),
      dispatcher: env.authenticatedContext('disp1'), kitchen: env.authenticatedContext('kit1'), handheld: env.authenticatedContext('hh1', { handheld: true }),
    };
    for (const [k, c] of Object.entries(who)) {
      const d = c.database();
      await assertFails(d.ref('order_ratings/o1').get());
      await assertFails(d.ref('order_ratings/o2').set({ thumb: 'up', rated_at: 1, restaurant_id: 'x_pizza' }));
      await assertFails(d.ref('public_stats/x_pizza').set({ forged: true }));
      await assertFails(d.ref('public_stats/x_pizza/dish_stats').set([]));
      await assertSucceeds(d.ref('public_stats/x_pizza').get());
    }
  } finally { await env.cleanup(); }
  ok('rules: anonymous / customer / dispatcher / kitchen / handheld can neither read nor write order_ratings, nor write public_stats; everyone can read public_stats');

  FINISHED = true;
  console.log(`\ns5-ratings: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s5-ratings FAILED:', e && (e.stack || e)); process.exit(1); });
