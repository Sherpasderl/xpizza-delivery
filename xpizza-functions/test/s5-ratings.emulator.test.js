'use strict';
// S5 — rateOrder end to end on the RTDB emulator through the REAL handler (r1 redesign: the SIGNED-IN CUSTOMER who placed the
// order rates it; status-only eligibility; any repeat → the same 200; no limiter). The orders are written by the REAL createOrder
// record builder + its REAL member attribution (attachCustomerAttribution → customer_uid); a PICKUP is completed by the REAL
// kitchen writer (xpizza-kitchen/xpizza-delivery.js setOrderStatus, firebase stubbed to the emulator), a delivery as the driver
// flow stamps it.
//   · the order's own customer rates → ONE order_ratings record { thumb, rated_at, restaurant_id } — no identity
//   · ANY repeat (same or other thumb) → the same 200 {ok:true}, the first thumb kept (never revealed)
//   · own order not yet fulfilled → 409 not_fulfilled; not signed in / a staff (non-customer) token / a tombstoned account /
//     another customer's order / a guest order / unknown / malformed → the SAME generic 403; nothing written for any refusal
//   · RULES (the real database.rules.json, rules-enabled namespace): no client reads/writes order_ratings or writes public_stats
// Run: npm run test:s5-ratings
require('./_emulator-required')('database');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
// ID tokens: 'cust:<uid>' → a customer; 'staff:<uid>' → a staff account (no customer claim); anything else → invalid
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => {
  const [kind, uid] = String(t).split(':');
  if (kind === 'cust') return { uid, customer: true };
  if (kind === 'staff') return { uid };
  throw new Error('invalid token');
} }) }));
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const rtdb = admin.database();
const { rateOrder } = require('../ratings/rate-order');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require('../create-order-build');
const { orderBreakdownCents } = require('../order-money');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s5-ratings: FAILED — exited without completing'); process.exitCode = 1; } });

function post(body, idToken) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(rateOrder);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { 'x-firebase-id-token': idToken } : {}) }, body: JSON.stringify(body) });
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

// the REAL kitchen writer (KDS SDK), its firebase imports stubbed onto this emulator handle (as xpizza-kitchen/avail-write.test.mjs)
async function loadKds() {
  const KDS = path.join(__dirname, '..', '..', 'xpizza-kitchen');
  globalThis.__kdsUpdate = (p, obj) => rtdb.ref(p).update(obj);
  globalThis.__kdsGet = async (p) => { const s = await rtdb.ref(p).get(); return { val: () => s.val(), exists: () => s.exists() }; };
  const stubSrc = `
export function initializeApp() { return {}; } export function getAuth() { return {}; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: {} }); } export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged() { return () => {}; } export function getDatabase() { return {}; }
export function ref(_db, p) { return { path: p == null ? '' : p }; } export function onValue() { return () => {}; }
export function query(r) { return r; } export function orderByChild() { return {}; } export function equalTo() { return {}; }
export function set() { throw new Error('unexpected set'); } export function remove() { throw new Error('unexpected remove'); }
export function update(r, obj) { return globalThis.__kdsUpdate(r.path, obj); } export function get(r) { return globalThis.__kdsGet(r.path); }
export function runTransaction() { throw new Error('unexpected transaction'); } export function serverTimestamp() { return Date.now(); } export function off() {}
`;
  globalThis.location = { hostname: 'xpizza-kitchen.example' };   // the X. Pizza KDS (kdsRestaurantFromHost default)
  const stubUrl = ('data:text/javascript,' + encodeURIComponent(stubSrc)).replace(/'/g, '%27');
  let sdk = fs.readFileSync(path.join(KDS, 'xpizza-delivery.js'), 'utf8');
  sdk = sdk.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-(app|auth|database)\.js/g, stubUrl)
    .replace(/from '\.\/order-filter\.js'/g, `from 'file://${path.join(KDS, 'order-filter.js')}'`)
    .replace(/from '\.\/cancel-ack-set\.js'/g, `from 'file://${path.join(KDS, 'cancel-ack-set.js')}'`);
  const XPD = await import('data:text/javascript,' + encodeURIComponent(sdk));
  XPD.initDelivery({});
  return XPD;
}

let SEQ = 0;
async function placeOrder({ type = 'delivery', uid = 'u_ana' } = {}) {
  const orderId = `s5r_${SEQ += 1}_${Date.now()}`;
  const fields = { customer_name: 'Ana Pérez', customer_phone: '99990000', customer_email: 'a@b.hn', notes: '', pickup_time: 'standard', items_text: '1x Carnivora',
    payment_method: 'cash', address_detected: 'Col. Prueba, SPS', address_details: 'casa', maps_link: 'm', waze_link: 'w', items: [{ name: 'Carnivora', qty: 1 }] };
  const u = buildCreateOrderUpdates({
    orderId, orderType: type, now: Date.now() - 7200000, trackingToken: `Trk${SEQ}abcdefgh`, total: 340, lat: 14.13, lng: -87.2, fields,
    hubSnap: { hub_lat: 14.1, hub_lng: -87.2, restaurant_name: 'X Pizza', restaurant_phone: '+504' }, restaurantId: 'x_pizza', priceBreakdown: orderBreakdownCents(340, 'x_pizza'),
    facturaPriced: { items: [] }, cashTenderedCents: 34000, freeOrder: false, rewardStamp: {},
  });
  if (uid) attachCustomerAttribution(u, orderId, uid, { now: Date.now(), total: 340, orderType: type, items_text: fields.items_text, restaurantId: 'x_pizza', items: fields.items, tables: null });
  await rtdb.ref().update(u);
  return orderId;
}
const deliver = (oid) => rtdb.ref(`orders/${oid}`).update({ status: 'delivered', delivered_at: Date.now() });
const rating = async (oid) => (await rtdb.ref(`order_ratings/${oid}`).get()).val();

(async () => {
  await wipe();
  const KDS = await loadKds();

  // 1. the order's own customer rates a delivered order → ONE record, no identity
  const a = await placeOrder(); await deliver(a);
  assert.strictEqual((await rtdb.ref(`orders/${a}/customer_uid`).get()).val(), 'u_ana', 'premise: the real attribution stamped customer_uid');
  const r1 = await post({ order_id: a, thumb: 'up' }, 'cust:u_ana');
  assert.deepStrictEqual([r1.status, r1.json], [200, { ok: true }]);
  const rec = await rating(a);
  assert.deepStrictEqual(Object.keys(rec).sort(), ['rated_at', 'restaurant_id', 'thumb']);
  assert.deepStrictEqual([rec.thumb, rec.restaurant_id], ['up', 'x_pizza']);
  assert.ok(!/u_ana|Ana|9999/.test(JSON.stringify(rec)), 'no uid, name or phone in the record');
  ok('the order\'s own signed-in customer rates a delivered order → ONE order_ratings record { thumb, rated_at, restaurant_id } — no identity');

  // 2. ANY repeat → the same 200, the first thumb kept, never revealed
  const same = await post({ order_id: a, thumb: 'up' }, 'cust:u_ana'), other = await post({ order_id: a, thumb: 'down' }, 'cust:u_ana');
  assert.deepStrictEqual([same.status, same.json, other.status, other.json], [200, { ok: true }, 200, { ok: true }], 'a repeat answers the SAME 200 whatever the thumb');
  assert.deepStrictEqual(await rating(a), rec, 'the first thumb stays final');
  ok('any repeat (same or other thumb) → the same 200 {ok:true}; the first tap stays final and is never revealed');

  // 3. a PICKUP completed by the REAL kitchen writer → rateable (status only, no timestamp)
  const p = await placeOrder({ type: 'pickup' });
  assert.strictEqual(await KDS.setOrderStatus(p, 'completed'), true, 'premise: the real KDS setOrderStatus wrote');
  const po = (await rtdb.ref(`orders/${p}`).get()).val();
  assert.deepStrictEqual([po.status, po.completed_at, po.delivered_at], ['completed', undefined, undefined], 'premise: the KDS completion stamps NO timestamp');
  assert.deepStrictEqual([(await post({ order_id: p, thumb: 'down' }, 'cust:u_ana')).status, (await rating(p)).thumb], [200, 'down']);
  ok('a pickup completed by the REAL kitchen writer (setOrderStatus → completed, no timestamp) is rateable');

  // 4. own order not yet fulfilled → 409; every other refusal → the SAME generic 403; nothing written
  const notYet = await placeOrder();
  const nf = await post({ order_id: notYet, thumb: 'up' }, 'cust:u_ana');
  assert.deepStrictEqual([nf.status, nf.json, await rating(notYet)], [409, { ok: false, error: 'not_fulfilled' }, null]);
  const guestOrder = await placeOrder({ uid: null }); await deliver(guestOrder);
  const bob = await placeOrder({ uid: 'u_bob' }); await deliver(bob);
  const bobUnfulfilled = await placeOrder({ uid: 'u_bob' });
  await rtdb.ref('deleted_uids/u_gone').set(true);
  const gone = await placeOrder({ uid: 'u_gone' }); await deliver(gone);
  const cases = [
    ['not signed in', { order_id: bob, thumb: 'up' }, null],
    ['an invalid token', { order_id: bob, thumb: 'up' }, 'garbage'],
    ['a STAFF account on its own-uid order', { order_id: bob, thumb: 'up' }, 'staff:u_bob'],
    ['another customer\'s order', { order_id: bob, thumb: 'up' }, 'cust:u_ana'],
    ['another customer\'s UNFULFILLED order (status never revealed)', { order_id: bobUnfulfilled, thumb: 'up' }, 'cust:u_ana'],
    ['a guest order', { order_id: guestOrder, thumb: 'up' }, 'cust:u_ana'],
    ['a tombstoned account', { order_id: gone, thumb: 'up' }, 'cust:u_gone'],
    ['an unknown order', { order_id: 'nope_123', thumb: 'up' }, 'cust:u_ana'],
    ['a malformed body', { order_id: '../x', thumb: 'up' }, 'cust:u_ana'],
    ['a bad thumb', { order_id: bob, thumb: 'meh' }, 'cust:u_bob'],
  ];
  for (const [label, b, tok] of cases) {
    const r = await post(b, tok);
    assert.deepStrictEqual([r.status, r.json], [403, { ok: false, error: 'not_allowed' }], `🔴 ${label} → the generic 403`);
  }
  for (const oid of [guestOrder, bob, bobUnfulfilled, gone]) assert.strictEqual(await rating(oid), null, 'nothing written');
  ok(`own unfulfilled order → 409 not_fulfilled; ${cases.length} other refusals (no / invalid / STAFF token, another customer's order — fulfilled or not —, a guest order, a tombstoned account, unknown, malformed) → the SAME 403; nothing written`);

  // 5. RULES: no client reads/writes order_ratings or writes public_stats; public_stats reads are public
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
    for (const c of Object.values(who)) {
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
