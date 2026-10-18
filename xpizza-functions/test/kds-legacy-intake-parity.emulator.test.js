'use strict';
/**
 * PLATFORM F2 Q2 (PLAN-F2-query-rules §2, amendment 7; codex F2q2 r1 P2-1, advisor ruling: prove what the KDS switch depends on) —
 * §8 parity for FUTURE legacy-provenance orders, driven by the REAL server writers wherever an existing emulator harness drives
 * them, for BOTH legacy brands (RTDB + Firestore emulators; external sends stubbed):
 *   intake      createOrder (cash pickup, cash delivery, cash SCHEDULED) · chargeOnlineOrder (online pickup, online delivery)
 *   payment     confirmOnlinePayment → confirmAndMaterialize (the materialize writer; capture success is represented by
 *               payment_status 'confirmed', as resolve-manual's harness does — the PixelPay capture call itself is external)
 *   scheduler   scheduled-release-core releaseOne (the real claim + finalize release writer)
 *   kitchen     the KDS setOrderStatus write shape (orders/{id}/status) for preparing / ready
 *   driver      the REAL driver completion builder (xpizza-driver/driver-complete.js buildCompleteTaskUpdates) after assignment
 *   cancel      cancelOrderCore (the real cancellation writer)
 * At EVERY step, for every order: (a) restaurant_id is BYTE-UNCHANGED from what intake persisted; (b) both kitchens' exact views
 * (live + Programados) equal today's (the frozen pre-F2 filters over the whole /orders).
 * Writers WITHOUT an existing harness are listed in the hand-back (not built here): the PixelPay hosted webhook's signed callback
 * and the capture call. Run: npm run test:kds-legacy-intake-parity
 */
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'kds-parity-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (mod, extra) => { const p = require.resolve(mod); const real = require(mod); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: { ...real, ...extra } }; };
stub('../whatsapp', { isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) });
stub('../pixelpay-hosted', { createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) });
stub('firebase-admin/auth', { getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) });
require('./_catalog-clock').install();
require('./_config-warm').install();
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database(); const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { confirmOnlinePayment } = require('../pixelpay-confirm');
const { buildMaterializeUpdates } = require('../materialize');
const { cancelOrderCore } = require('../cancel-order-core');
const { voidOrRefund } = require('../pixelpay-cancel');
const REL = require('../scheduled-release-core');
const SCHED = require('../scheduled-orders');

const RIDS = ['x_pizza', 'la_musa'];
const OPEN = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN };
const IDENT = (rid) => ({ name: `Rest ${rid}`, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `kp-${rid}` });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).update(IDENT(rid));
}
function post(handler, body, headers) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { /* text */ }
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
let PH = 0;
function bodyFor(rid, oid, method, type, extra = {}) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
  const base = { restaurant_id: rid, order_id: oid, customer_name: 'KDS Parity', customer_phone: `9945${String(PH += 1).padStart(4, '0')}`, customer_email: 'kp@example.com', items_text: `1x ${it.display.name}`, order_type: type, payment_method: method, items, ...extra };
  return type === 'delivery' ? { ...base, address_detected: 'Col. Prueba', address_details: 'casa 1', lat: 14.1, lng: -87.2 } : base;
}
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const PRE = await import(pathToFileURL(path.join(__dirname, '..', 'access', 'kds-filter-pre-f2.mjs')).href);
  const NOW = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-kitchen', 'order-filter.js')).href);
  const { buildCompleteTaskUpdates } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'driver-complete.js')).href);
  await rtdb.ref().set(null);
  for (const rid of RIDS) await seed(rid);
  const made = {}; const ridAtIntake = {}; const steps = [];
  const check = async (label) => {
    const all = (await rtdb.ref('orders').once('value')).val() || {};
    for (const [oid, rid] of Object.entries(made)) {
      assert.ok(all[oid], `[${label}] ${oid} persisted`);
      assert.strictEqual(JSON.stringify(all[oid].restaurant_id), ridAtIntake[oid], `[${label}] ${oid}: restaurant_id byte-unchanged since intake`);
      assert.strictEqual(all[oid].restaurant_id, rid, `[${label}] ${oid}: exactly its legacy location`);
    }
    for (const rid of RIDS) {
      assert.deepStrictEqual(Object.keys(NOW.filterLiveOrders(all, rid)).sort(), Object.keys(PRE.filterLiveOrders(all, rid)).sort(), `[${label}] ${rid} live: exact == today's`);
      assert.deepStrictEqual(Object.keys(NOW.filterScheduledOrders(all, rid)).sort(), Object.keys(PRE.filterScheduledOrders(all, rid)).sort(), `[${label}] ${rid} Programados: exact == today's`);
    }
    steps.push(`${label} [${[...new Set(Object.values(all).map((o) => o.status))].sort().join('/')}]`);
    return all;
  };
  const intake = async (rid, oid, method, type, extra) => {
    await rtdb.ref('rate_limits').remove();
    const r = await post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, bodyFor(rid, oid, method, type, extra), { 'x-firebase-id-token': `u_${rid}` });
    assert.strictEqual(r.status, 200, `${oid}: the real handler answered 200 (${r.status} ${String(r.text).slice(0, 240)})`);
    made[oid] = rid;
    ridAtIntake[oid] = JSON.stringify((await rtdb.ref(`orders/${oid}/restaurant_id`).once('value')).val());
  };
  // ── intake (real handlers) ──
  const slot = (type) => SCHED.generateSlots(HOURS, Date.now(), type)[0];
  for (const rid of RIDS) {
    await intake(rid, `${rid}-CP`, 'cash', 'pickup');
    await intake(rid, `${rid}-CD`, 'cash', 'delivery');
    await intake(rid, `${rid}-CS`, 'cash', 'pickup', { scheduled_for: slot('pickup') });
    await intake(rid, `${rid}-OP`, 'online', 'pickup');
    await intake(rid, `${rid}-OD`, 'online', 'delivery');
  }
  let all = await check('intake');
  for (const rid of RIDS) assert.strictEqual(all[`${rid}-CS`].status, 'scheduled', `premise: ${rid}-CS is a real held scheduled order`);
  // ── payment: the real confirm → materialize writer ──
  const cDeps = { db: rtdb, restaurant: { lat: 14.1, lng: -87.2, name: 'R', phone: '+504' }, buildMaterializeUpdates, getIdentity: async (_db, rid) => ({ ...IDENT(rid) }), genToken: () => `T${Math.random().toString(36).slice(2, 10)}`, alert: () => {} };
  for (const rid of RIDS) for (const oid of [`${rid}-OP`, `${rid}-OD`]) {
    await rtdb.ref(`orders/${oid}/payment_status`).set('confirmed');   // capture success (the PixelPay call is external)
    const r = await confirmOnlinePayment(cDeps, { orderId: oid, paymentUuid: 'S-1', now: Date.now(), trackingToken: `TK-${oid}` });
    assert.ok(/^(confirmed|materialized|already)/.test(String(r.outcome)), `${oid}: real confirm → materialize (${JSON.stringify(r)})`);
  }
  all = await check('payment confirmed → materialized');
  for (const rid of RIDS) assert.strictEqual(all[`${rid}-OP`].status, 'new', `premise: ${rid}-OP materialized to new`);
  // ── scheduler: the real release ──
  for (const rid of RIDS) {
    const o = all[`${rid}-CS`];
    const r = await REL.releaseOne({ db: rtdb, alert: async () => {}, genToken: () => `RT-${rid}`, restaurantFallback: { lat: 14.1, lng: -87.2, name: 'R', phone: '+504' } }, { orderId: `${rid}-CS`, now: Number(o.release_at) + 1000, claimId: `cl-${rid}` });
    assert.ok(r && /released|materialized|ok/i.test(JSON.stringify(r)), `${rid}-CS released (${JSON.stringify(r).slice(0, 200)})`);
  }
  all = await check('scheduled → released');
  for (const rid of RIDS) assert.strictEqual(all[`${rid}-CS`].status, 'new', `premise: ${rid}-CS released to new`);
  // ── kitchen (the KDS setOrderStatus write shape) ──
  for (const st of ['preparing', 'ready']) {
    await rtdb.ref().update(Object.fromEntries(RIDS.flatMap((rid) => [`${rid}-CP`, `${rid}-CD`, `${rid}-OP`, `${rid}-OD`, `${rid}-CS`]).map((oid) => [`orders/${oid}/status`, st])));
    await check(`kitchen ${st}`);
  }
  // ── driver: assign + pickup + the REAL completion builder (delivery orders) ──
  for (const rid of RIDS) for (const oid of [`${rid}-CD`, `${rid}-OD`]) {
    const DRV = `drv-${rid}`; const at = Date.now();
    await rtdb.ref().update({ [`drivers/${DRV}`]: { name: 'D', status: 'available', active: true },
      [`tasks/${oid}_pickup/assigned_driver_id`]: DRV, [`tasks/${oid}_pickup/status`]: 'completed', [`tasks/${oid}_delivery/assigned_driver_id`]: DRV, [`tasks/${oid}_delivery/status`]: 'accepted',
      [`orders/${oid}/status`]: 'out_for_delivery', [`orders/${oid}/picked_up_at`]: at });
    const allTasks = (await rtdb.ref('tasks').once('value')).val() || {};
    await rtdb.ref().update(buildCompleteTaskUpdates({ driverId: DRV, taskId: `${oid}_delivery`, task: allTasks[`${oid}_delivery`], allTasks, now: at + 60000 }));
  }
  all = await check('driver completion (real builder)');
  for (const rid of RIDS) assert.strictEqual(all[`${rid}-CD`].status, 'delivered', `premise: ${rid}-CD delivered by the real completion builder`);
  // ── cancel: the real cancellation writer ──
  for (const rid of RIDS) {
    await rtdb.ref(`orders/${rid}-CP/status`).set('new');
    const r = await cancelOrderCore({ db: rtdb, client: { voidTransaction: async () => ({ ok: true }) }, voidOrRefund, alert: async () => {}, serverTimestamp: Date.now() }, { orderId: `${rid}-CP`, actor: 'kds-parity', reason: 'test', now: Date.now(), claimId: `cc-${rid}` });
    assert.ok(r && (r.status === 200 || r.ok || /cancel/i.test(JSON.stringify(r))), `${rid}-CP cancelled (${JSON.stringify(r).slice(0, 200)})`);
  }
  all = await check('cancelled (real cancelOrderCore)');
  for (const rid of RIDS) assert.strictEqual(all[`${rid}-CP`].status, 'cancelled', `premise: ${rid}-CP cancelled by the real writer`);
  ok(`10 orders (both legacy brands × cash pickup / cash delivery / cash SCHEDULED / online pickup / online delivery) through the REAL intake, confirm→materialize, scheduled release, completion builder and cancelOrderCore`);
  ok(`at EVERY step (${steps.length}) every order's restaurant_id is byte-unchanged since intake and both kitchens' exact live + Programados views equal today's: ${steps.join(' → ')}`);
  console.log(`kds-legacy-intake-parity.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('kds-legacy-intake-parity.emulator: FAIL\n', e); process.exit(1); });
