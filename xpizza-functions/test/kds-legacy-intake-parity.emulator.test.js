'use strict';
/**
 * PLATFORM F2 Q2 (PLAN-F2-query-rules §2, architecture amendment 7) — §8 parity for FUTURE legacy-provenance orders, on the REAL
 * intake: createOrder (cash: pickup + delivery) and chargeOnlineOrder (online) for BOTH legacy brands, through the real handlers
 * on the RTDB + Firestore emulators (the order-exists harness pattern: seeded catalog + identity, external sends stubbed). Each
 * order the real writers persist must carry exactly its legacy location, and today's KDS visibility (the pre-F2 filters) must
 * EQUAL the exact-location visibility for both kitchens and both views — at intake and across a status walk.
 * Q2 changes no server code, so the server write-sets are unchanged by construction; this proves the CLIENT switch is invisible
 * for what the real intake produces. Run: npm run test:kds-legacy-intake-parity
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

const RIDS = ['x_pizza', 'la_musa'];
const OPEN = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN };
async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `kp-${rid}` });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).update({ name: `Rest ${rid}`, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
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
function bodyFor(rid, oid, method, type) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
  const base = { restaurant_id: rid, order_id: oid, customer_name: 'KDS Parity', customer_phone: `9945${String(PH += 1).padStart(4, '0')}`, customer_email: 'kp@example.com', items_text: `1x ${it.display.name}`, order_type: type, payment_method: method, items };
  return type === 'delivery' ? { ...base, address_detected: 'Col. Prueba', address_details: 'casa 1', lat: 14.1, lng: -87.2 } : base;
}
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const PRE = await import(pathToFileURL(path.join(__dirname, '..', 'access', 'kds-filter-pre-f2.mjs')).href);
  const NOW = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-kitchen', 'order-filter.js')).href);
  await rtdb.ref().set(null);
  for (const rid of RIDS) await seed(rid);
  // the REAL intake: cash pickup, cash delivery and online (chargeOnlineOrder) for both brands
  const made = [];
  for (const rid of RIDS) {
    for (const [method, type] of [['cash', 'pickup'], ['cash', 'delivery'], ['online', 'pickup']]) {
      const oid = `KP-${rid}-${method}-${type}`;
      await rtdb.ref('rate_limits').remove();
      const r = await post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, bodyFor(rid, oid, method, type), { 'x-firebase-id-token': `u_${rid}` });
      assert.ok(r.status === 200, `${oid}: the real handler answered 200 (${r.status} ${String(r.text).slice(0, 200)})`);
      made.push({ rid, oid, method });
    }
  }
  const check = async (when) => {
    const all = (await rtdb.ref('orders').once('value')).val() || {};
    for (const m of made) {
      const o = all[m.oid];
      assert.ok(o, `${when}: ${m.oid} persisted`);
      assert.strictEqual(o.restaurant_id, m.rid, `${when}: ${m.oid} carries exactly its legacy location (the census-(a) invariant, on the real writer)`);
    }
    for (const rid of RIDS) {
      assert.deepStrictEqual(Object.keys(NOW.filterLiveOrders(all, rid)).sort(), Object.keys(PRE.filterLiveOrders(all, rid)).sort(), `${when}: ${rid} live view — exact == today's`);
      assert.deepStrictEqual(Object.keys(NOW.filterScheduledOrders(all, rid)).sort(), Object.keys(PRE.filterScheduledOrders(all, rid)).sort(), `${when}: ${rid} Programados — exact == today's`);
    }
    return all;
  };
  const all0 = await check('after intake');
  const statuses = [...new Set(made.map((m) => all0[m.oid].status))].sort();
  ok(`real intake for both legacy brands (${made.length} orders: cash pickup + delivery, online via chargeOnlineOrder; statuses ${statuses.join(', ')}): every order carries exactly its legacy location; both kitchens' live + Programados visibility exact == today's`);
  // the status walk the later writers produce (KDS / driver / dispatch), incl. a held → releasing cycle
  for (const st of ['scheduled', 'releasing', 'new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled']) {
    await rtdb.ref().update(Object.fromEntries(made.map((m) => [`orders/${m.oid}/status`, st])));
    await check(`status ${st}`);
  }
  ok('across the status walk (scheduled → releasing → new → preparing → ready → out_for_delivery → delivered → cancelled) the exact-location views equal today\'s for both kitchens');
  console.log(`kds-legacy-intake-parity.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('kds-legacy-intake-parity.emulator: FAIL\n', e); process.exit(1); });
